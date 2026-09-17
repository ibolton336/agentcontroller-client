# Pre-release check: is `main` good to cut?

There is no release-candidate branch or tag for 0.11 yet — no `release-0.11`
anywhere, and the `v0.11.0-alpha.N` tags are cut straight off `main`. A tag
push re-runs the same image workflows with the ref name as the tag, and the
operator bundle pins those to digests. So **`main` is the candidate**, and its
published form is:

| What | Where |
| --- | --- |
| Operator + bundle index | `quay.io/konveyor/tackle2-operator-index:latest` (== `:main`) |
| Everything it deploys | `quay.io/konveyor/{tackle2-hub,tackle2-ui,agentic-controller,agent-base,agent-java,…,skills}:latest` — the operator's `helm/values.yaml` defaults on main |

(When `release-0.11` is branched, the same images/index appear under a
`:release-0.11` tag and fixes start needing backports. Not yet.)

Two checks, cheapest first.

## A. Upstream binaries on the ROKS demo cluster (~5 min + a run)

Swaps only the controller, agent-java and tackle2-ui images to the
upstream-built `:latest` digests; Hub, operator and the hand-rendered
CRD/RBAC install stay as they are.

```sh
../roks/use-upstream-images.sh            # prints the digests it pinned — keep them
# console → start a coolstore run → must get past turn 1 and push a branch
#   STAY ON THE RUN PAGE: until agentic-controller#242 ships, the agent may
#   ask a question and the run fails if nobody answers within 180 s
../roks/use-upstream-images.sh rollback   # back to the ghcr fork images
```

Proves: the artifacts upstream CI built work. Does **not** prove: the install
path a user takes.

## B. The operator-driven install on a throwaway cluster

Use a disposable cluster, not ROKS — the operator deploys its *own* agentic
controller into the Hub namespace, and two controllers reconciling the same
CRs is unsupported.

**Cluster.** cluster-bot is the better fit: Slack DM `launch 4.19 aws`
(amd64, cluster-admin kubeconfig in ~35 min, self-destructs after ~2.5 h —
a full run needs ~25 min). ROSA works the same but costs money, takes as
long to come up, and you have to remember to delete it; worth it only if
the cluster should outlive the afternoon. Either way the default worker
pool (3× m6i.xlarge-class) is enough; analyzer tasks are the only thing
that strains it.

```sh
export KUBECONFIG=~/Downloads/cluster-bot-….kubeconfig   # never the ROKS context
oc whoami --show-server                                   # look at it before going on
export KONVEYOR_NS=konveyor-tackle
```

1. **Agent Sandbox** — the operator does not resolve this dependency, and
   without it posts `AgenticControllerReady=False` and deploys nothing. Use
   the version upstream Getting Started names (v1.0.0 at time of writing;
   ROKS still runs v0.5.0, so this also checks the documented one):

   ```sh
   T=v1.0.0
   git clone --depth 1 --branch $T https://github.com/kubernetes-sigs/agent-sandbox.git /tmp/agent-sandbox
   helm install agent-sandbox /tmp/agent-sandbox/helm/ -n agent-sandbox-system \
     --create-namespace --set namespace.create=false --set image.tag=$T
   oc -n agent-sandbox-system wait deploy/agent-sandbox-controller --for=condition=Available --timeout=120s
   ```

2. **Operator from main**

   ```sh
   oc apply -f olm-main.yaml
   oc -n $KONVEYOR_NS get csv -w        # until Succeeded
   ```

3. **Tackle CR with the agentic switch on** — one flag deploys the
   controller, its default Agents/Workflow, and lights up the console.
   Leave `openshift_cluster` alone here: the `false` workaround in
   `../roks/README.md` is for ROKS' admission-locked empty cluster Proxy; on
   a stock OCP/ROSA cluster you want the real Route.

   ```sh
   oc apply -f - <<'EOF'
   apiVersion: tackle.konveyor.io/v1alpha1
   kind: Tackle
   metadata: {name: tackle, namespace: konveyor-tackle}
   spec:
     feature_auth_required: false
     agentic_enabled: true
   EOF
   oc -n $KONVEYOR_NS get tackle tackle \
     -o jsonpath='{.status.conditions[?(@.type=="AgenticControllerReady")]}{"\n"}'
   ```

4. **Record what got installed** — this is the evidence for the release ask:

   ```sh
   oc -n $KONVEYOR_NS get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.containerStatuses[0].imageID}{"\n"}{end}'
   oc -n $KONVEYOR_NS get agents.konveyor.io -o custom-columns=NAME:.metadata.name,IMAGE:.spec.image
   ```

5. **Gateway + credentials** (upstream sample names, in the Hub namespace):

   ```sh
   SECRET_NAME=bedrock-credentials ../roks/set-bedrock-creds.sh $KONVEYOR_NS
   oc apply -n $KONVEYOR_NS -f https://raw.githubusercontent.com/konveyor/agentic-controller/main/config/samples/gateway_aws_bedrock.yaml
   ```

6. **An application + push identity** — in the console (the `tackle` Route):
   Applications → create coolstore pointing at your fork, then
   `GITHUB_PAT=… ../roks/add-git-identity.sh <github-user> <app-id>`.

7. **Run it from the console** — Agentic → Agents → run the default Java
   migrator against coolstore with the Bedrock gateway.

### Pass criteria

- [ ] `AgenticControllerReady=True` with nothing applied by hand beyond steps 1–3
- [ ] Default Agents and Workflow appear in the console and are `Ready` once the Gateway exists (#225, #222/#228)
- [ ] Create-run modal refuses a not-Ready Agent / missing gateway (ui#3603, ui#3605)
- [ ] Plan ladder shows the descriptive rungs and the branch-named push (#230)
- [ ] Run gets past turn 1, finishes, pushes `konveyor/migration-*` to the fork
- [ ] Failure path: swap the Secret for a dead key → run is **Failed** with the provider's reason shown in the console, not termination JSON (#232, ui#3606); restore the key after
- [ ] Workflow run attaches to its live stage (ui#3577)

Anything red here is a blocker to raise before asking for the next alpha.

## Log

**2026-09-17 — A on ROKS, not yet passed.** Swapped to
`agentic-controller@sha256:ced1f051…`, `agent-java@sha256:f3b06857…`,
`tackle2-ui@sha256:dcd060c1…`; controller/UI/Agents all healthy, Gateways
`Ready/VerificationSkipped`. Two runs, neither completed, neither the
images' fault:

- `ui-4cdjk` — deleted at turn 17 by a bulk delete from the runs page
  (Running runs are not protected).
- `ui-8trs6` — 38 turns, then Failed on an unanswered `ask_user` question.
  Same Agent and prompt had Succeeded that morning (`ui-gckqt`, fork images).

What came out of it: konveyor/agentic-controller#242 (ask_user opt-in —
worth landing *before* the next alpha, it changes a default),
konveyor/tackle2-ui#3608 (pinned plan, honest usage chip). Still owed: one
run to completion on the upstream digests, then B.
