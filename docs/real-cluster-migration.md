# Moving the demo off minikube → OpenShift `dylan-mta`

Prep notes for lifting the current laptop+minikube demo (hub-shim, harness
images, tackle2-ui) onto a real cluster. Everything under "Verified" was
checked against the live cluster on 2026-07-30; everything under "Gaps" is
work that does not exist yet.

Companion docs: [quarkus-demo-flow-and-design.md](quarkus-demo-flow-and-design.md)
(what the demo actually does), [../deploy/README.md](../deploy/README.md)
(the existing in-cluster gateway+UI deployment).

---

## 1. Target cluster — verified

| Fact | Value |
| --- | --- |
| API | `https://api.dylan-mta.mg.dog8code.com:6443` |
| Console | `https://console-openshift-console.apps.dylan-mta.mg.dog8code.com` |
| Version | OpenShift **4.21.19** (k8s 1.34.8) |
| Nodes | **1** worker, `7500m` CPU / `~29.7 GiB` allocatable, **amd64** |
| Storage | `gp3-csi` (default), `gp2-csi` — AWS EBS, RWO |
| Egress | Direct (no cluster `Proxy`, no IDMS/ICSP mirroring) |
| Catalogs | `redhat-operators`, `redhat-marketplace` only — **no community-operators** |
| Access | cluster-admin (verified: can create ns / CRDs / clusterrolebindings) |
| Internal registry | `Managed`, but **`defaultRoute` not set** — no external push endpoint today |
| Default SCC | `restricted-v2` → random UID; ns range e.g. `1000750000/10000`, GID 0 |
| cert-manager | **not installed** |

Kubeconfig saved to `~/.kube/dylan-mta.config` (mode 0600), context `admin`.
Use it explicitly — do not merge into the default kubeconfig, which still
points at minikube:

```bash
export KUBECONFIG=~/.kube/dylan-mta.config
```

> The admin client certificate and private key for this cluster were pasted
> into a chat session on 2026-07-30. Rotate them if this cluster outlives the
> demo.

### Hub: MTA removed, upstream Tackle installed — done 2026-07-30

The cluster arrived with productized **MTA 8.2.0** in `openshift-mta`. That
was torn down and replaced with **upstream Konveyor** at the user's
instruction. State now:

- Namespace **`konveyor-tackle`** — deliberately the same name minikube used,
  and also the operator's own `suggested-namespace`. This means
  `HUB_BASE_URL=http://tackle-hub.konveyor-tackle.svc:8080` in
  `manifests/coolstore-quarkus-demo.yaml` works **unchanged**.
- `tackle-hub` (`quay.io/konveyor/tackle2-hub:latest`) →
  `svc/tackle-hub.konveyor-tackle.svc:8080`
- `tackle-ui` → route
  `https://tackle-konveyor-tackle.apps.dylan-mta.mg.dog8code.com`
- Operator `konveyor-operator.v99.0.0`, channel `development`, from a
  hand-added `CatalogSource` (`quay.io/konveyor/tackle2-operator-index:latest`)
  in `openshift-marketplace` — the cluster has no community-operators catalog,
  so this step is required and is **not** part of stock OperatorHub.
- `feature_auth_required: false`, verified live: an unauthenticated `POST
  /applications` returned `201` with `createUser: admin.noauth`.

Teardown artifacts: install manifests in `/tmp/konveyor-install/`, and a
logical backup of the destroyed MTA Hub records (~300 KB of JSON: apps,
tasks, tags, tag categories, plus the old Tackle CR and Subscription) at
`/tmp/mta-backup-20260730/`. The 110 Gi of PVC data is gone.

**CPU is the binding constraint on this node, not memory.** Stock task pods
request 1 CPU per container (`addon + nodejs + python + java = 4`), and with
~3800m of the 7500m already requested by system pods they will not schedule —
`FailedScheduling: Insufficient cpu`, task Pending forever, queue wedged.
This is the same class of failure as the minikube wedge but on a different
resource. The Tackle CR therefore tunes CPU **requests** down while leaving
limits high, and deliberately does **not** touch memory (~14 Gi free; the java
provider's stock 2.5 Gi is what yields a full insight report). These settings
land on the `Addon`/`Extension` CRs, not on hub env — check them there:

```bash
kubectl get addon analyzer -n konveyor-tackle -o jsonpath='{.spec.container.resources}'
kubectl get extension java -n konveyor-tackle -o jsonpath='{.spec.container.resources}'
```

Note that changing the CR does not re-spec an already-Pending task pod —
cancel the task (`PUT /tasks/{id}/cancel`) so the Hub recreates it.

Hub inventory now:

| id | name | repository |
| --- | --- | --- |
| 2 | `coolstore` | `https://github.com/ibolton336/coolstore.git` (branch `main`) |

Analysis has been run and **succeeded**: task 3, java extension, targets
`quarkus` + `cloud-readiness`, 2m49s, **50 insights** (25 `quarkus/springboot`,
17 `technology-usage`, 6 `discovery-rules`, 1 each `cloud-readiness` /
`eap8/eap7`) — parity with the 49 the minikube demo was built on.
`GET /applications/2/analysis/insights` returns `200`.

---

## 2. What has to move

Three components, plus the control plane they need and the Hub data they read.

| Component | Today | On the cluster |
| --- | --- | --- |
| hub-shim | laptop process `:7080`, `ACP_DIAL=tunnel`, `HUB_URL` via port-forward | `agentic-gateway` Deployment, `ACP_DIAL=direct` — manifests already exist in [`deploy/`](../deploy) |
| browser UI | vite dev server `:5199` | `agentic-ui` Deployment (nginx SPA) — same kustomization |
| harness images | `agent-base:latest` / `agent-java:dev` built into minikube's daemon | must live in a registry the cluster pulls from |
| controller | `agentic-controller:dev` local image | same — registry |
| Agent Sandbox | v0.5.0 helm chart | not installed on target |
| tackle2-ui | laptop dev server `:9000`, branch `feature/agent-runs` | cluster runs stock upstream `tackle-ui`; branch disposition **decision open** — see §6 |

---

## 3. Gaps, ranked by how likely they are to bite

### G1 — Every image is arm64; the cluster is amd64 🔴

The single largest blocker, and it invalidates the entire existing image set.
The Mac builds `linux/arm64`; the node reports `architecture: amd64`. Nothing
currently built runs there.

Affected: `agent-base`, `agent-java`, `agent-nodejs`, `agentic-controller`,
`agentic-gateway`, `agentic-ui` (and `tackle2-ui` if it ships in-cluster).

Note that *where the build runs* is independent of *which registry it lands
in* (G2). Per-image cross-build cost under QEMU, read from the Dockerfiles:

| Image | Cost | Why |
| --- | --- | --- |
| `agentic-controller` | ~free | kubebuilder Dockerfile already does `GOARCH=${TARGETARCH} go build`, so the compile stays native and just emits an amd64 binary; final stage is distroless with no `RUN`. |
| `agentic-gateway` | low | `node:22-slim` + two `npm ci`. Emulated but no heavy native build. |
| `agentic-ui` | moderate | `npm ci` plus a `vite build` — CPU-bound JS, several× slower emulated. |
| `agent-java` | moderate | only `dnf install java-21-openjdk-devel maven` on top of base. Emulated package install, no compilation. |
| `agent-base` | **high** | the real cost. Emulated `dnf` toolchain install, a from-source pip build of `graphifyy==0.7.17`, then `dnf remove` — *and* its Go builder stage (unlike the controller's) has no `TARGETARCH`, so that compiles emulated too. |

So the pain is concentrated in exactly one image, and it is partly
self-inflicted: giving `agent-base`'s builder stage the same
`--platform=$BUILDPLATFORM` + `GOARCH=${TARGETARCH}` treatment the controller
already uses makes the Go half native. Worth doing regardless of build
location, and it belongs upstream in #53 next to the `HOME` fix (G3).

#### Settled by experiment 2026-07-30: the laptop **cannot** build `agent-base`

The buildx cross-build was tried and **fails**, and not for a reason any flag
fixes:

```
Curl error (35): SSL connect error for https://cdn-ubi.redhat.com/…
TLS connect error: error:030000EA:digital envelope routines::provider signature failure
```

`agent-base` is `FROM registry.access.redhat.com/ubi10/ubi`. UBI10's OpenSSL
fails its **provider module integrity check** under QEMU user-mode emulation,
so `dnf` cannot complete a TLS handshake to the Red Hat CDN at all — the build
dies on the very first `dnf install` layer.

Isolated the variable — same emulated `curl`, same URL, different base image:

| Base image (emulated amd64) | Result |
| --- | --- |
| `ubi9/ubi:latest` | **HTTP 200** |
| `ubi10/ubi:latest` | `curl (35)` TLS failure |

So it is UBI10-specific, not general QEMU-TLS breakage. Four
`OPENSSL_ia32cap` masks (`~0x20000000`, `:~0x20000000`,
`~0x200000200000000`, `~0x1000000000000000`) were tried and none helped.
Docker Desktop's Rosetta backend is not enabled in this install
(`settings-store.json` has no virtualization keys), and switching it on is a
GUI toggle + daemon restart with no guarantee it survives the provider
integrity check either.

**Therefore: build on the cluster.** OpenShift `BuildConfig` with a *binary*
source — the context uploads from the laptop, but compiles natively on the
amd64 node. Verified working:

```bash
oc start-build agent-base -n konveyor-agents --from-dir=<ctx> --follow
```

Practical notes learned doing it:

- Use a **minimal context**. The repo root is 221 MB (218 MB of it an
  untracked nested `clients/` copy), and the repo's `.dockerignore` excludes
  `images/` — which is harmless for `docker build -f` but **hides the
  Containerfile from a BuildConfig**, whose `dockerfilePath` must resolve
  inside the uploaded context. A context of just `harness/` +
  `images/agent-base/Containerfile` is **128 KB**.
- Manifests live in `/tmp/konveyor-install/04-agent-base-build.yaml`.

`agent-base`'s goose install already branches on `uname -m`
(`x86_64` / `aarch64`), so no change is needed for the arch itself.

### G2 — Nothing is in a registry 🔴

`quay.io/konveyor/agent-java:dev` etc. are **local tag names only** — they
exist in minikube's daemon and nowhere else. `imagePullPolicy: IfNotPresent`
made that invisible on minikube; on a real cluster it becomes
`ImagePullBackOff`.

**Decided 2026-07-30: `quay.io/ibolton/*`** — verified by a real push.

> **Two different usernames.** GitHub is **`ibolton336`**; quay is
> **`ibolton`**. `quay.io/ibolton336` *does* exist (it holds `mig-ui` /
> `mig-controller`) but the logged-in account cannot push to it — that
> mismatch produces a misleading `401 UNAUTHORIZED` on the blob HEAD,
> *after* buildkit has already reported a successful `[auth] … token`.
> Confirm the helper's account with `docker-credential-desktop list`
> (prints registry → username only, no secrets) before blaming the
> credential.

Docker Desktop holds the quay credential in the macOS keychain, so
`docker push` works with no setup and the secret never has to be handled
directly. It is also the better choice on merits: the images outlive this
cluster (which is shared and may well be temporary), they are shareable, and
the tag shape stays close to the `quay.io/konveyor/agent-*` names they will
eventually carry upstream.

Two consequences to handle:

- **Confirmed private:** `quay.io/ibolton/agent-base` was created by the first
  push and anonymous read returns `401`. So either flip the repos public in
  the quay UI (one click each, fine for demo images), or add a pull secret to
  `konveyor-agents` built from a robot token. Not blocking until Phase 2 —
  but the failure mode is an opaque `ImagePullBackOff`, so decide before
  deploying rather than while debugging.

> **Status 2026-07-30: quay is the *destination*, but it is not where
> `agent-base` currently lives.** Because the build had to move on-cluster
> (G1), the built image landed in the **cluster-internal registry**:
> `image-registry.openshift-image-registry.svc:5000/konveyor-agents/agent-base:latest`,
> via ImageStream `agent-base` in `konveyor-agents`. That is sufficient for
> everything on this cluster and needs **no credentials at all**, which is why
> it is the current state.
>
> Getting it onward to `quay.io/ibolton` needs a push credential *on the
> cluster* — the laptop's keychain credential cannot be read or mounted. That
> means a **quay robot account** whose token becomes a push secret (and,
> conveniently, the pull secret too). Worth doing for portability beyond this
> cluster; not required to run the demo here.
>
> The only quay artifact so far is a throwaway `agent-base:authcheck` tag
> (a 2-line `FROM scratch` probe used to prove push auth) — safe to delete.
- Every manifest that names an image needs repointing:
  `manifests/coolstore-quarkus-demo.yaml` (`quay.io/konveyor/agent-java:dev`),
  `manifests/samples.yaml`, `manifests/image-catalog.yaml`,
  `manifests/controller/install.yaml` (`agentic-controller:dev`), and
  `deploy/manifests/{gateway,ui}.yaml`. Also flip `imagePullPolicy` off
  `IfNotPresent` — with a moving `:dev` tag it will serve a stale cached
  layer.

### G3 — OpenShift random UID vs `agent-base`'s `HOME` 🔴

Predicted in the PR #53 notes as untested; this cluster is where it bites.

`images/agent-base/Containerfile` does:

```dockerfile
RUN mkdir -p /opt/skills /workspace /home/harness/.migration-harness \
    && useradd -u 1001 -g 0 -d /home/harness -s /sbin/nologin harness \
    && chown -R 1001:0 /home/harness /workspace \
    && chmod -R g=u /home/harness /workspace
USER 1001
```

The GID-0 + `g=u` half is the correct OpenShift pattern and will hold. The
missing half is that **`ENV HOME` is never set**. Under `restricted-v2` the
container runs as a random UID from `1000750000/10000` with no `/etc/passwd`
entry, so `HOME` resolves to `/` — and goose writes its config under
`$HOME/.config/goose`, i.e. to a read-only root. On minikube this was masked
because UID 1001 *did* have a passwd entry.

Fix (one line, belongs upstream in #53) — **already applied** on branch
`demo/amd64-roks`, together with the `BUILDPLATFORM` change from G1:

```dockerfile
ENV HOME=/home/harness
```

#### ✅ Verified on-cluster 2026-07-30

`scc=restricted-v2`, `runAsUser=1000740000` (from ns range
`1000740000/10000`):

```
id        : uid=1000740000 gid=0(root) groups=0(root),1000740000
HOME      : /home/harness      HOME write: OK
goose cfg : OK                 goose     : 1.45.0
git cfg   : OK                 workspace : OK
arch      : x86_64
```

> **Trap when verifying this.** The first attempt looked green but was
> worthless: as cluster-admin, admission gave the pod the **`anyuid`** SCC
> (priority 10), so it ran as UID 1001 *with* a passwd entry — precisely the
> minikube condition that hid the bug in the first place. A verification pod
> must pin the SCC:
>
> ```yaml
> metadata:
>   annotations:
>     openshift.io/required-scc: restricted-v2
> ```
>
> Always assert on the resulting `openshift.io/scc` annotation and
> `runAsUser`, not just on the command output.

Incidental finding: UBI10 synthesises a passwd entry for the random UID
(`1000740000:x:1000740000:0:…:/home/harness:/sbin/nologin`), so `HOME` might
have resolved even without the `ENV`. Keep the `ENV` anyway — it makes the
behaviour explicit rather than dependent on base-image nss behaviour.

### G4 — No git push identity in the Hub 🟠

`GET /identities` returns `[]` on the rebuilt Hub too — the wipe did not
change this, it was empty before. The demo's whole payoff is the pushed
branch, and the harness resolves its push credential from the Hub identity
attached to the application. Needs a `source`-kind identity carrying a GitHub
PAT, associated with app 2.

**This one is yours to do** — it needs a live PAT, which should not travel
through a chat transcript. Create the identity in the Tackle UI
(`https://tackle-konveyor-tackle.apps.dylan-mta.mg.dog8code.com` →
Administration → Credentials → *Source Control* / *Username-Password*, user
`ibolton336`, password = PAT), then attach it to the `coolstore` application
on its Details tab. Or via the API with the PAT in an env var you set
yourself:

```bash
curl -X POST "$HUB/identities" -H 'Content-Type: application/json' -d "{
  \"name\": \"github-ibolton336\", \"kind\": \"source\",
  \"user\": \"ibolton336\", \"password\": \"$GITHUB_PAT\" }"
```

Related: the PAT rotation already noted as owed in the coolstore demo notes —
worth minting a fresh, repo-scoped token for this cluster rather than reusing
the minikube one, especially given G8 (the Route is unauthenticated).

### G5 — Analysis report ✅ RESOLVED 2026-07-30

Was: no report on the target Hub. Now: analyzer task 3 Succeeded in 2m49s and
`GET /applications/2/analysis/insights` returns `200` with **50 insights**.
The harness self-pull has real data to write into
`.konveyor/analysis.json`.

Known-good submission recipe, if it ever needs re-running — note the explicit
`extensions: ["java"]`, which is what keeps the pod small enough to schedule:

```json
POST /tasks
{ "name": "coolstore.2.analyzer", "kind": "analyzer", "addon": "analyzer",
  "extensions": ["java"], "state": "Ready", "priority": 10,
  "application": { "id": 2 },
  "data": { "mode": {"artifact":"","binary":false,"withDeps":true},
            "rules": {"labels":{"excluded":[],
                      "included":["konveyor.io/target=quarkus",
                                  "konveyor.io/target=cloud-readiness"]},"path":""},
            "scope": {"packages":{"excluded":[],"included":[]},"withKnownLibs":false},
            "sources": [], "tagger": {"enabled": true}, "targets": [],
            "verbosity": 1 } }
```

### G6 — Demo application ✅ RESOLVED 2026-07-30

Was: app 1 `coolstore2` → `konveyor-ecosystem/coolstore`, the wrong fork.
Now: app **2** `coolstore` → `https://github.com/ibolton336/coolstore.git`
branch `main`, matching the proven demo.

It is id **2**, not 1 — Postgres does not reuse the id of a deleted record.
`manifests/coolstore-quarkus-demo.yaml` has been updated accordingly
(`APP_ID: "2"`), along with `TARGET_BRANCH: quarkus-migration-ocp-1`, since
the old `quarkus-migration-demo-2` branch already exists on the fork and would
collide. The `AgentWorkloadRun` name in that manifest
(`coolstore-quarkus-demo-2`) still needs to be fresh per attempt.

### G7 — Control plane absent 🟠

No `konveyor.io` Agent CRDs, no Agent Sandbox on the target. Both must be
installed:

- `manifests/crd/*` + `manifests/controller/install.yaml` (contains **no**
  webhooks and **no** cert-manager dependency — verified, so it installs
  clean).
- Agent Sandbox v0.5.0 helm chart. **Check whether it needs cert-manager** —
  cert-manager is not installed here, and there is no community-operators
  catalog, so it would come from the Red Hat cert-manager operator.

### G8 — Ingress / Route 🟡

`deploy/manifests/ingress.example.yaml` is nginx-Ingress-shaped. On OpenShift
this becomes a `Route` with edge termination on `*.apps.dylan-mta…`. That is
the whole of the remaining work here.

**Auth is deliberately out of scope for this demo** (decided 2026-07-30). The
gateway has no auth of its own — `deploy/README.md` calls this an intentional
gap, since per-user identity and RBAC on runs is exactly the value the real
Hub proxy adds later. No oauth-proxy sidecar, no Route auth. This matches how
the Hub itself is already configured on this cluster
(`feature_auth_required: "false"`).

What that means concretely, stated once so it is on the record: the Route is
reachable by anyone who knows the hostname, and the API behind it can create
AgentRuns — which spend against the Bedrock account and push to the
repositories the Hub identity is good for. Two zero-effort limiters if the
cluster is long-lived, neither of which is an auth stack:

- `haproxy.router.openshift.io/ip_whitelist: "<your-ip>/32"` on the Route —
  one annotation.
- Create the Route only for the demo window; `oc delete route` after.

If neither is wanted, nothing here blocks the move — just keep the Bedrock
credential's blast radius and the PAT's repo scope in mind, since those are
what an open Route ultimately exposes.

### G9 — Bedrock credentials 🟡

`aws-bedrock-creds` (3 keys) exists only in minikube's `konveyor-agents`. The
LLMProvider wiring itself is portable — a keyless `credentialRef` exposes the
whole Secret via `envFrom` since upstream #34 — but the Secret must be
recreated on the target. Confirm the cluster's egress reaches
`bedrock-runtime.us-east-1.amazonaws.com` (no proxy configured, so it should).

### G10 — Laptop-loopback assumptions 🟡

Mostly already solved in code, but each needs setting correctly:

- `ACP_DIAL=direct` — dials `<sandbox>.<ns>.svc:4000` instead of a
  port-forward tunnel. Auto-detected in-cluster; `ACP_DIAL` overrides.
- `RUN_HUB_BASE_URL` must be the cluster Hub DNS
  (`http://tackle-hub.konveyor-tackle.svc:8080`), **not** a `127.0.0.1` port-forward
  — sandbox pods cannot reach the laptop. The shim already refuses a loopback
  value in tunnel mode; make sure it is right in direct mode too.
- `manifests/coolstore-quarkus-demo.yaml` hardcodes
  `HUB_BASE_URL: http://tackle-hub.konveyor-tackle.svc:8080` — which is now
  **correct as written**, because upstream Tackle was installed into
  `konveyor-tackle` precisely so this would not need editing.
- The `git://192.168.65.254:9418` daemon from the RHDH testbed is already
  retired; confirm nothing still references it.

### G11 — Namespace and cross-namespace reach 🟡

The shim/gateway is namespace-scoped (`konveyor-agents` Role, not
ClusterRole). Keeping the namespace name `konveyor-agents` on the target
avoids editing every manifest. Sandbox pods must reach `konveyor-tackle` —
check for NetworkPolicies (OpenShift's default is open, but the operator may
add some).

---

## 4. Suggested order

> **STATUS 2026-07-30 (end of day): Phases 1–5 are DONE on dylan-mta.**
> All five images built on-cluster (`agent-base`, `agent-java`+skills,
> `agentic-controller`, `agentic-gateway`, `tackle2-ui`, all `:demo`),
> controller + Agent Sandbox v0.5.0 installed, aws-bedrock LLMProvider
> `Verified=true`, gateway + tackle2-ui deployed with edge Routes, and a
> smoke AgentRun cleared image/SCC/ACP/Bedrock/skills/clone/insights and
> failed exactly where predicted: `final push: authentication required`
> (no Hub identity yet). The smoke run was deleted immediately after the
> failure — the OnFailure crashloop gap means a failed run re-burns Bedrock
> tokens every restart; never leave a failed run standing.
>
> Cluster-specific traps hit on the way, all now encoded in `deploy/roks/`:
> - cross-namespace internal-registry pulls need
>   `oc policy add-role-to-group system:image-puller
>   system:serviceaccounts:agentic-controller-system -n konveyor-agents`
>   (controller pod `ImagePullBackOff: authentication required` otherwise);
> - the konveyor operator NetworkPolicy-isolates `konveyor-tackle`
>   (`tackle-deny-all`) — `deploy/roks/hub-networkpolicy.yaml` opens
>   Hub:8080 to `konveyor-agents`; without it the gateway and every sandbox
>   pod hang on the Hub, they don't error;
> - CRDs/RBAC were generated from the controller source tree
>   (`deploy/roks/agentic-controller-install.yaml`), NOT from
>   `manifests/crd/` — the client-repo copy is stale and its
>   `credentialRef.key` requirement breaks keyless SigV4.
>
> **Two clusters now share `deploy/roks/`** (this one and the concurrent
> ROKS `demo-agentic-controller`); their Hubs disagree on the coolstore app
> id (ROKS 1, dylan-mta 2), so the AgentWorkloadRun moved to per-cluster
> files under `deploy/roks/runs/` and `add-git-identity.sh` requires the app
> id explicitly.
>
> **DEMO RUN SUCCEEDED 2026-07-30 ~19:12 local.** `coolstore-quarkus-mta-1`:
> assess → remediate → validate all `Succeeded`, zero restarts, ~22 min
> total. Branch `quarkus-migration-mta-1` pushed to `ibolton336/coolstore`
> (head `0892656`); PLAN.md on the branch carries the messaging-topology
> table and a Verification Results section with all three gates ✅
> (package, "Listening on" startup, `/services` endpoints). §6's tackle2-ui
> question resolved itself: it is built and serving on the cluster.
>
> Post-mortem of the one failed attempt: an attached Hub identity is NOT
> enough. The harness's Direct lookup filters the *association* by
> `role='source'` (`IdentityRef{id, role}`), and its Indirect fallback
> wants `kind='source' AND default=true`. A bare `{id}` association matches
> neither → the final push silently goes anonymous and the stage crashloops
> (OnFailure) — delete the run fast, every restart re-burns a full Bedrock
> stage. `add-git-identity.sh` now writes `role:'source'` (plus an env-var
> placement fix); the Hub identity here is also `default:true`.
>
> ⚠️ **CRD rename in flight in `deploy/roks/`** (from the ROKS side of the
> shared tree): run files now say `AgentWorkloadRun`/`workloadRef` and the
> stack Role names `agentworkloads`/`agentworkloadruns`. dylan-mta's
> installed CRDs are still the playbook-named generation the successful run
> used (`AgentPlaybookRun`/`playbookRef`) — the renamed files will NOT
> apply here until the controller + CRDs are rebuilt from a renamed tree.
> To re-run on dylan-mta today, use kind `AgentPlaybookRun` with
> `playbookRef`, fresh `metadata.name` + `TARGET_BRANCH`.
>
> Rotate the GitHub PAT after the demo (it transited a chat session); the
> Hub identity `github-push` must be updated with the replacement.

Each phase is independently verifiable; do not start the next until the
previous is green.

**Phase 0 — decide**: registry ✅ `quay.io/ibolton` (G2), auth ✅ out of
scope (G8). Still open: tackle2-ui disposition (§6) — but it does not block
Phases 1–5.

**Phase 1 — images**
1. ✅ Both `agent-base` Containerfile fixes are in, on branch
   `demo/amd64-roks` in `~/Development/agentic-controller`:
   `ENV HOME=/home/harness` (G3) and `--platform=$BUILDPLATFORM` +
   `GOARCH=${TARGETARCH}` (G1).
2. ✅ `agent-base` built **on the cluster** (laptop cross-build is impossible —
   see G1) → ImageStream `agent-base:latest` in `konveyor-agents`.
3. ✅ Verified under `restricted-v2` at a random UID: amd64, `HOME`, goose
   1.45.0, git, workspace all good (G1 + G3 closed).
4. ⬜ Remaining images, same on-cluster BuildConfig pattern:
   `agent-java` (needs `--build-arg BASE_IMAGE` pointing at our `agent-base`,
   since the Containerfile defaults to `quay.io/konveyor/agent-base:latest`)
   → skills bake → `agentic-controller`, `agentic-gateway`, `agentic-ui`.
   Note `agentic-controller` and the two node images are *not* UBI10-based, so
   those could still cross-build on the laptop if that is ever preferable.
5. ⬜ Optional: quay robot account, to mirror images off-cluster (G2).

**Phase 2 — control plane**
5. `kubectl apply -f manifests/crd/` + `manifests/controller/install.yaml`
   with the image patched to the registry ref.
6. Install Agent Sandbox v0.5.0 (resolve the cert-manager question first).
7. Create ns `konveyor-agents`, recreate `aws-bedrock-creds`, apply the
   LLMProvider, confirm it reaches `Verified=true`.

**Phase 3 — a run that is not the demo**
8. Apply the mock agent/provider (`manifests/samples.yaml`) and get one
   trivial AgentRun to `Succeeded`. This isolates SCC, image-pull, ACP dial,
   and model injection from any Hub or git complexity.

**Phase 4 — shim + UI**
9. `kubectl apply -k deploy/manifests` with patched images and
   `RUN_HUB_BASE_URL` pointed at `tackle-hub.konveyor-tackle.svc:8080`.
10. Create the Route — edge termination, no auth in front (G8).
11. Smoke: `SHIM_URL=https://… npx tsx dev/browser-smoke.ts`.

**Phase 5 — Hub data** — mostly done 2026-07-30
12. ✅ Upstream Tackle installed in `konveyor-tackle`, auth off (§1).
13. ✅ Demo application seeded — app id **2**, `ibolton336/coolstore` (G6).
14. ✅ Analysis run — 50 insights, `/analysis/insights` returns 200 (G5).
15. ⬜ **Still owed: the git push identity (G4).** Needs a GitHub PAT, which
    is yours to create — see G4 for the exact call.

**Phase 6 — the demo itself**
13. Port `manifests/coolstore-quarkus-demo.yaml` with corrected
    `HUB_BASE_URL` / `APP_ID` / fresh `TARGET_BRANCH`, and run the full
    assess→remediate→validate workload.
14. Re-check the known caveats that are unrelated to the move: `OnFailure`
    crashloop on a failing stage, `.konveyor/analysis.json` not reaching the
    pushed branch, the dirty-worktree warning misattributing the harness's own
    writes.

---

## 5. Things that get *easier* on this cluster

Worth stating, because it is not all cost:

- 30 GiB / 7.5 CPU on one node vs minikube's ~3.9 GiB — the analyzer
  scheduling wedge disappears, and Maven builds in the validate stage get real
  headroom.
- The Hub is already installed, already unauthenticated, and already
  resource-tuned. The auth wedge that cost a day on minikube is simply absent.
- `ACP_DIAL=direct` removes the port-forward tunnel and its liveness/retry
  machinery, including the readiness race the shim currently works around.
- No more "which of three checkouts is live" ambiguity for the runtime pieces
  — what runs is what was pushed to the registry.
- Auth is out of scope by decision, and the Hub is already auth-off, so the
  entire SSO/oauth-proxy/Route-auth workstream is zero. A plain edge Route is
  the whole of the exposure work.

---

## 6. Open decisions

*Decided 2026-07-30: registry = `quay.io/ibolton` (G2); auth = out of scope
(G8).*

1. **tackle2-ui** — simpler now that the productized `mta-ui` is gone: the
   cluster runs stock **upstream** `tackle-ui` from the operator, which is the
   same codebase your branch forks. The agent-runs work is on
   `feature/agent-runs` (`~/Development/tackle2-ui`, clean at `842edfe05`).
   Three options:
   - keep tackle2-ui as a laptop dev server pointed at the cluster Hub —
     least work, keeps UI iteration fast, but re-introduces a laptop
     dependency into the demo;
   - build a tackle2-ui image from the branch and point the operator's
     `tackle-ui` at it (or deploy it under its own Route) — self-contained,
     one more amd64 image, and it now *replaces* like-for-like rather than
     sitting awkwardly beside a productized UI;
   - demo the standalone `agentic-ui` only and leave tackle2-ui out.
2. **Scope** — full end-to-end demo, or agentic stack only. Still unanswered;
   the phases above assume full end-to-end and can be truncated after
   Phase 4.
