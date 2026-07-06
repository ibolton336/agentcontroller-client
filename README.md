# agentcontroller-client

Client-side implementation of the konveyor/agentic-controller AgentRun
flow, built VSCode-extension-first per ADR 0002/0003: create AgentRun CRs
directly against the apiserver, then attach to the run's ACP endpoint
(`goose serve`, `:4000/acp`, `X-Secret-Key` auth) over WebSocket.

The upstream controller has CRD types but no reconcilers yet, so this
repo includes a **controller simulator** that performs the same
externally observable steps the real reconciler will. When the real
controller lands, delete the simulator — the client code is unchanged.

## Layout

| Path | What |
|------|------|
| `packages/agentrun-client/src/` | The reusable module (shaped for konveyor/editor-extensions). `types.ts` mirrors the CRDs, `kube.ts` creates/watches AgentRuns and resolves the ACP endpoint, `portforward.ts` tunnels to the pod, `acp.ts` connects via `@agentclientprotocol/sdk`'s WebSocket transport. |
| `packages/agentrun-client/dev/` | `simulate-controller.ts` (stand-in reconciler), `demo.ts` (end-to-end flow), `local-smoke.ts` (no-cluster protocol test). |
| `harness-mock/` | Mock of the sandbox harness ACP surface — real ACP via the SDK's server side, deterministic fake agent. Honors `GOOSE_SERVER__SECRET_KEY`, `GOOSE_MODE`, `KONVEYOR_PARAM_*`, `AGENT_PROMPT`. |
| `manifests/` | Sample LLMProvider + Agent CRs (`samples.yaml` = mock, `goose-bedrock.yaml` = real goose on AWS Bedrock). |
| `harness-goose/` | Real harness image: goose v1.39.0 `serve --host 0.0.0.0 --port 4000` (plain HTTP at this tag; the self-signed-TLS default landed later — keep it pinned). Provider/model/credentials arrive via env from the LLMProvider resolution in the simulator. |
| `agentic-controller/` | Upstream clone (with two local CEL-rule fixes in the Agent CRD, PR pending). |

> **Full local dev-mode guide** (cluster + simulator + extension dev
> host + smokes + troubleshooting): [docs/DEV_MODE.md](docs/DEV_MODE.md)

## Quickstart (minikube)

```sh
# one-time setup
kubectl apply -f manifests/crd/  # vendored CRDs, incl. Agent CEL fixes (upstream PR 2)
kubectl create namespace konveyor-agents
kubectl apply -f manifests/samples.yaml
(cd harness-mock && minikube image build -t acp-mock-harness:dev .)

cd packages/agentrun-client && npm install

# terminal 1: the stand-in reconciler
npm run simulator

# terminal 2: full flow — create CR, wait, port-forward, ACP prompt + replay
npm run demo
```

`npx tsx dev/local-smoke.ts` (with `node ../../harness-mock/server.mjs`
running) exercises the ACP layer with no cluster at all.

Cleanup: `kubectl delete agentruns --all -n konveyor-agents` — the
secret/pod/service are owner-referenced and garbage-collect.

## Real goose + Bedrock

```sh
(cd harness-goose && minikube image build -t goose-harness:dev .)
kubectl create secret generic aws-bedrock-creds -n konveyor-agents \
  --from-literal=AWS_ACCESS_KEY_ID="$(aws configure get aws_access_key_id)" \
  --from-literal=AWS_SECRET_ACCESS_KEY="$(aws configure get aws_secret_access_key)" \
  --from-literal=AWS_REGION=us-east-1
kubectl apply -f manifests/goose-bedrock.yaml
```

Then create runs with `agentRef: migration-analyzer-goose` and a models
selection (`role: primary, provider: bedrock, model: <bedrock model id>`).
The simulator resolves the LLMProvider CR to `GOOSE_PROVIDER`/`GOOSE_MODEL`
plus an `envFrom` of the credential secret, and clones the `repository`
param into /workspace via initContainer — the same mapping the real
harness will own.

## editor-extensions integration (implemented)

The VSCode integration lives in the `feature/cluster-agent-transport`
branch of the git worktree at `~/Development/editor-extensions-cluster-agent`
(based on konveyor/editor-extensions PR #1368, which unifies backends on
ACP). What it adds:

- `vscode/core/src/client/acpTransport.ts` — transport seam for the PR's
  `GooseClient` (stdio subprocess remains the default; ~40-line change).
- `vscode/core/src/client/clusterAgent/` — `ClusterAgentTransport`
  (create AgentRun → wait → read key Secret → port-forward → WebSocket
  with X-Secret-Key), AgentRun kube client, tunnel helper, CRD types.
- Backend setting `konveyor-core.experimentalChat.agentBackend: "cluster"`
  plus `clusterAgent.{namespace,agentRef,kubeconfig}` settings; the
  workspace's git remote/branch are auto-detected and passed as run params.
- `vscode/core/cluster-smoke.ts` — headless E2E: verified against both the
  mock harness and real goose v1.39.0 on Bedrock.

## Extension integration notes

- `AgentRunClient` + `withRunConnection` are the seam: the extension
  builds `AgentRunSpec` from the open workspace (git remote, branch),
  renders `onSessionUpdate` into its chat webview, and maps
  `onPermissionRequest` onto its diff-preview UX.
- Swap direct CR creation for Hub `POST /hub/agentruns` and the
  port-forward for Hub's `/stream` proxy when those land (ADR 0003) —
  interface-compatible by design.
- The ACP secret data key is assumed `ACP_SECRET_KEY`; the client
  tolerates a single-entry secret under any key. Confirm with the real
  harness when it exists.
