# agentcontroller-client

Client-side reference stack for the Konveyor agentic platform
([konveyor/agentic-controller](https://github.com/konveyor/agentic-controller)
+ the hub's `/agentic/*` endpoints + the tackle2-ui agent-runs console).
This repo holds the rigs, manifests, deployment recipes and design docs that
sit *around* those three upstream pieces: things to prove a contract, stand
a real stack up on a laptop or a cluster, and hand it to someone else.

## Running the real hub + console locally (no shim)

Two scripts stand the real pair up on a disposable minikube profile —
[docs/local-stack.md](docs/local-stack.md):

```sh
hack/hub-auth-up.sh     # real hub, agentic endpoints, auth on   → http://localhost:18080
hack/ui-up.sh           # tackle2-ui console against it          → http://localhost:18081  (admin / admin)
hack/hub-auth-probe.sh  # 21-leg 401 / 403 / past-auth matrix per role
```

The hub-only auth rig behind it, with the probe matrix used to review
tackle2-hub#1119, is [docs/hub-auth-rig.md](docs/hub-auth-rig.md).

## Layout

| Path | What |
|------|------|
| `hack/` | `hub-auth-*.sh` + `hub-auth-rig.yaml` (real hub, auth on, probe), `ui-up.sh` + `ui-rig.yaml` (console in front of it), `mock-inventory-stack.mjs` (cluster-free mock hub — the console's *contract fixture*, incl. the ACP nonce two-step and a scripted pod-boot race), `upstream-patches/`. |
| `deploy/roks/` | The ROKS demo-cluster recipe: hub RBAC/NAMESPACE swap, `web-ui` IdpClient, console Deployment/Route, controller install render, agent-sandbox, Bedrock gateways, coolstore demo, image catalog. [deploy/roks/README.md](deploy/roks/README.md) + [docs/tackle2-ui-real-hub-handoff.md](docs/tackle2-ui-real-hub-handoff.md) (live digests, what works, traps). |
| `manifests/` | `crd/` = agentic CRDs mirroring upstream `main`; sample CRs, `goose-bedrock.yaml` (Bedrock Gateways), `coolstore-quarkus-demo.yaml`, image catalog. |
| `packages/agentic-client/` | Browser-safe contract types + `AcpSession` — the reference for [ADR 0009](docs/adr/0009-client-contract-and-transports.md). |
| `harness-goose/` | The original goose-serve harness image (`goose-harness:dev`), pre-upstream-harness; kept because `docs/bedrock-wiring.md` traces the Secret → Gateway → env → goose chain against it. |
| `skills/` | Skill sources baked into `agent-java` by CI (`patternfly-migration`). |
| `docs/` | Design docs, issue trees, call decisions, ADRs (`docs/adr/`), handoffs. Start with `local-stack.md`, `hub-auth-rig.md`, `tackle2-ui-real-hub-handoff.md`, `v0.11.0-issue-tree.md`. |
| `.github/workflows/` | `build-images.yml` — agent-base, agent-java, agentic-controller, tackle2-ui, multi-arch, to ghcr; `build-hub.yml` — any tackle2-hub fork/ref → `ghcr.io/ibolton336/tackle2-hub:<tag>`. |
| `slides/` | Decks. |

Conventions for working here are in [CLAUDE.md](CLAUDE.md) (E2E over unit
tests; never touch a cluster that wasn't named).

## Bedrock credentials

The Gateways in `manifests/goose-bedrock.yaml` expect a Secret that no
manifest ever contains:

```sh
kubectl create secret generic aws-bedrock-creds -n konveyor-agents \
  --from-literal=AWS_ACCESS_KEY_ID="$(aws configure get aws_access_key_id)" \
  --from-literal=AWS_SECRET_ACCESS_KEY="$(aws configure get aws_secret_access_key)" \
  --from-literal=AWS_REGION=us-east-1
kubectl apply -f manifests/goose-bedrock.yaml
```

The chain from that Secret to goose's SigV4 calls is traced in
[docs/bedrock-wiring.md](docs/bedrock-wiring.md).

## History (retired 2026-08-18)

The repo started as a POC before the upstream reconciler, the hub endpoints
and the console existed, and grew stand-ins for each: a **controller
simulator**, the **`hub-shim`** localhost proxy (SHIM HTTP API v1, later
the in-cluster "gateway"), a **Vite UI prototype**, the **`agentrun-client`**
node POC, a **mock harness**, and `hack/demo-*.sh` around them. All of that
was removed once the real pieces landed — recover any of it from git
history before this commit. `docs/DEMO.md` and `docs/DEV_MODE.md` are kept
as historical narrative (banners say so); the design record lives on in
`docs/adr/`.
