# Deploying the agentic demo stack on OpenShift

Everything needed to stand up the full stack — Konveyor Hub, the agentic
controller, in-cluster-built images, the gateway, and the tackle2-ui
console — on a fresh OpenShift cluster. Written from the working ROKS
deployment (`demo-agentic-controller`, OpenShift 4.21, 2×amd64 workers),
but nothing here is IBM-specific: any OpenShift 4.x cluster with amd64
worker nodes and cluster-admin works the same way.

Two design decisions shape the whole thing:

- **Images are prebuilt, multi-arch, and public on ghcr.io** — the
  [`build-images` workflow](../../.github/workflows/build-images.yml) builds
  all five on native amd64 + arm64 runners and pushes
  `ghcr.io/ibolton336/{agent-base,agent-java,agentic-controller,agentic-gateway,tackle2-ui}:demo`.
  The cluster just pulls; no local checkouts, no builds, no push credentials.
  (Native runners matter: cross-building amd64 from an ARM Mac with
  `docker buildx` does NOT work — the emulated UBI10 `dnf` fails TLS under
  QEMU. The old in-cluster BuildConfig flow, `build-configs.yaml` +
  `build-images.sh`, remains as a fallback for hacking on images without
  pushing branches.)
- **Exposure is OpenShift Routes with edge TLS.** On managed clusters the
  route hostnames land under the provider's ingress domain (on IBM Cloud
  that's `*.containers.appdomain.cloud`) — that domain is just the router,
  unrelated to where images live.

> **No auth, deliberately.** The gateway has no auth of its own and the Hub
> runs with `feature_auth_required: false`. The Routes are reachable by
> anyone who knows the hostname. Demo clusters only.

## Architecture

```
browser ── Route (edge TLS) ── tackle2-ui (feature/agent-runs)
                                   │  /hub → tackle-hub . /agentic → gateway (REST + WS)
                               agentic-gateway (SA + namespace RBAC)
                                   │  CRs via k8s API · direct-dials sandbox pods :4000
                               agentic-controller / Agent Sandbox / sandbox pods
                                   │
                               tackle-hub (konveyor-tackle ns) ← NetworkPolicy allows this hop
```

## Prerequisites

- `oc` logged in with cluster-admin on an OpenShift 4.x cluster (amd64 or
  arm64 workers — the ghcr images are multi-arch).
- A checkout of this repo (for these manifests). The other source repos
  (`agentic-controller`, `tackle2-ui`) are only needed if you want to
  rebuild images — see step 2.
- AWS credentials with Bedrock access (for the `aws-bedrock` LLMProvider).
- For the coolstore demo's final push: a GitHub PAT with `repo` scope on
  your coolstore fork.

## 1. Namespace + Konveyor Hub

```sh
oc new-project konveyor-agents
oc new-project konveyor-tackle
```

Install the **Konveyor operator** (community, tested at v0.10.0-alpha.9)
into `konveyor-tackle`, then create the Tackle CR:

```yaml
apiVersion: tackle.konveyor.io/v1alpha1
kind: Tackle
metadata:
  name: tackle
  namespace: konveyor-tackle
spec:
  feature_auth_required: false
  openshift_cluster: false   # see note
```

- `openshift_cluster: false` is a **workaround, not a typo**: on clusters
  with an empty admission-locked cluster `Proxy` spec the operator's
  Ansible crashes dereferencing `proxy_cluster.spec.trustedCA`. Side
  effect: stock tackle-ui gets a dead nginx Ingress instead of a Route —
  harmless here, the demo uses our tackle2-ui build instead.
- The operator drops a deny-all NetworkPolicy set into its namespace which
  silently **hangs** (not errors) every Hub API call from `konveyor-agents`.
  Fix:

```sh
oc apply -f hub-networkpolicy.yaml
```

Then seed the Hub with an application to migrate (Applications → create,
pointing at your fork of the source repo) and optionally run an analyzer
task so the migration has real insights to ground on. Watch analyzer
resources on small clusters — the defaults may exceed node capacity and
need Tackle CR patches.

## 2. Images (nothing to build)

All five images are public multi-arch (amd64 + arm64) pulls from ghcr.io:

```
ghcr.io/ibolton336/agent-base:demo
ghcr.io/ibolton336/agent-java:demo          # base + JDK 21 + Maven + 5 demo skills
ghcr.io/ibolton336/agentic-controller:demo
ghcr.io/ibolton336/agentic-gateway:demo
ghcr.io/ibolton336/tackle2-ui:demo          # feature/agent-runs console
```

They're produced by the
[`build-images` workflow](../../.github/workflows/build-images.yml) from
`agentcontroller-client` + `agentic-controller@demo/dylan-workload` +
`tackle2-ui@feature/agent-runs` (refs overridable via workflow_dispatch
inputs). To republish after a source change, push the branch and run:

```sh
gh workflow run build-images.yml -R ibolton336/agentcontroller-client
```

`:demo` is a moving tag — after a republish, pin Deployments/Agents by
digest (printed at the end of the workflow run) or restart pods so
`IfNotPresent` doesn't serve the stale image.

<details><summary>Fallback: in-cluster builds (no registry, hacking without pushing branches)</summary>

```sh
oc apply -f build-configs.yaml     # 5 ImageStreams + 5 binary BuildConfigs
./build-images.sh                  # stages each context locally, runs oc start-build --follow
```

Builds run native amd64 on the cluster's own nodes; outputs land at
`image-registry.openshift-image-registry.svc:5000/konveyor-agents/<name>:demo`.
Requires local checkouts of all three repos (`CLIENT_REPO`,
`CONTROLLER_REPO`, `TACKLE_UI_REPO` env overrides), and you must point the
image refs in the step-3/5/6 manifests back at the internal registry. The
webpack tackle2-ui build is the heaviest; budget ~2 GiB memory per build
pod (already set in the BuildConfigs).
</details>

## 3. CRDs, controller, Agent Sandbox

```sh
oc apply -f agentic-controller-install.yaml    # CRDs + RBAC + controller Deployment
oc apply -f agent-sandbox-v0.5.0.json          # Agent Sandbox v0.5.0
```

`agentic-controller-install.yaml` is `oc kustomize config/default` rendered
from the **same controller tree the image was built from**
(`agentic-controller@demo/dylan-workload`), with the image repointed at
ghcr. If you rebuild the controller from a
different branch, re-render this file from that tree — CRDs and RBAC must
match the running binary.

## 4. LLMProvider

Create the Bedrock credentials secret and a provider named `aws-bedrock`
(that exact name — the seeded agents and demo Agents reference it):

```sh
oc -n konveyor-agents create secret generic aws-bedrock-creds \
  --from-literal=AWS_ACCESS_KEY_ID=... \
  --from-literal=AWS_SECRET_ACCESS_KEY=... \
  --from-literal=AWS_REGION=us-east-1
```

Adapt [`manifests/goose-bedrock.yaml`](../../manifests/goose-bedrock.yaml)
(rename to `aws-bedrock`, keep `credentialRef.secretName: aws-bedrock-creds`;
the key field can be omitted — the harness resolves the full SigV4 triple
from the secret). Wait for the provider to report Ready.

## 5. Gateway + console

```sh
oc apply -f agentic-stack.yaml
```

This creates the gateway (ServiceAccount + namespace Role, `HUB_URL`
pointing at the in-cluster Hub, `ACP_DIAL=direct` so it dials sandbox pods
by service DNS instead of port-forwards) and tackle2-ui (proxying
`/agentic` → the gateway, WebSockets included), each behind an
edge-TLS Route:

```sh
oc -n konveyor-agents get routes    # tackle2-ui = the demo URL
```

The gateway Role's `configmaps get` rule is load-bearing: without it,
seeding silently falls back to the builtin quay.io catalog and plans agent
sets this cluster can't pull.

## 6. Image catalog + seed defaults

```sh
oc apply -f agent-image-catalog.yaml
```

The ConfigMap tells `POST /api/defaults` which images this cluster
actually has (deliberately java-only here — seed sets needing images you
didn't build are *skipped*, not created broken). Then seed from the
console ("Load defaults") or directly:

```sh
curl -sk -X POST https://<gateway-route>/api/defaults | jq
```

Idempotent; `?dryRun=true` shows the plan without writing.

## 7. The coolstore migration demo

```sh
oc apply -f coolstore-quarkus-demo.yaml    # Agent + AgentWorkload (cluster-agnostic)
```

The final push needs a Hub identity on the application. Run
[`add-git-identity.sh`](add-git-identity.sh) yourself (it port-forwards to
the Hub; the PAT never leaves your shell):

```sh
export GITHUB_PAT='ghp_...'
./add-git-identity.sh <github-user> <app-id>
```

The association **must** carry `role: source` — the harness filters on the
association role, and a bare `{id}` attach makes the push go anonymous
(fails with "No anonymous write access").

Then start a run: from the console's workload page, or apply a run file
(see `runs/` for per-cluster examples — app id and `TARGET_BRANCH` differ
per cluster, so don't share run files between them). A full
assess→remediate→validate chain takes ~20–25 min and pushes a branch to
the fork.

## Gotchas (all hit in production, all real)

| Symptom | Cause / fix |
| --- | --- |
| `docker buildx --platform linux/amd64` dies in `dnf` with "provider signature failure" | QEMU emulation breaks UBI10 TLS. Use the CI workflow (native runners) or the in-cluster fallback (step 2); don't retry buildx. |
| Hub API calls from the gateway hang forever | Operator's deny-all NetworkPolicy. Apply `hub-networkpolicy.yaml`. |
| Tackle operator Ansible crashes on `proxy_cluster.spec.trustedCA` | Empty admission-locked cluster Proxy. Set `openshift_cluster: false`. |
| Seeding creates agents with quay.io images the cluster can't pull | Gateway Role missing `configmaps get`, or catalog ConfigMap not applied. |
| Pod runs a stale image after a rebuild | `IfNotPresent` + mutable `:demo` tag. Pin the Deployment/Agent `image` by digest after rebuilding, or the tag pull races the just-pushed image. |
| Run reaches the end then fails "No anonymous write access" | No `role: source` identity on the Hub application (step 7). |
| Gateway can't reach a Running sandbox on :4000 | Controller pods have no readiness probe; phase=Running races the ACP server. The gateway retries the dial — transient. |
| Sandbox ACP unreachable / goose panics on startup | Needs the goose `--host 0.0.0.0` + `ENV HOME=/home/harness` fixes in agent-base — build from a controller tree that has them. |

## Teardown

```sh
oc delete -f agentic-stack.yaml -f agent-image-catalog.yaml -f coolstore-quarkus-demo.yaml
oc delete -f agentic-controller-install.yaml -f agent-sandbox-v0.5.0.json
oc delete project konveyor-agents        # takes builds + ImageStreams with it
# Hub: delete the Tackle CR, then uninstall the operator / delete konveyor-tackle
```
