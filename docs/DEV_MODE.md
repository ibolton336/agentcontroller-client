# Dev mode: running the agentic platform locally

Everything needed to run the full loop on one laptop: minikube stands in
for the cluster, the **simulator** stands in for the not-yet-written
AgentRun controller, a **mock harness** (or real goose + Bedrock) stands
in for the agent, and the **editor-extensions branch** is the client.

```text
VSCode dev host ──ACP/WebSocket──► sandbox pod (mock or goose)
      │                                  ▲
      └──AgentRun CRs──► minikube ◄── simulator (fake controller)
```

## Prerequisites

- Docker Desktop running
- minikube (any recent; cluster was built on k8s 1.35)
- kubectl
- Node ≥ 22.9, npm ≥ 10.5
- For real-goose mode only: AWS credentials with Bedrock access
  (`aws bedrock-runtime` invoke) in `~/.aws`

Repos:

| Repo | Where |
|---|---|
| this repo | `~/agentcontroller-client` |
| editor-extensions, branch `feature/cluster-agent` | worktree at `~/Development/editor-extensions-cluster-agent` (branch is local-only for now) |

## One-time setup

```sh
cd ~/agentcontroller-client

# 1. Cluster
minikube start

# 2. CRDs — use the vendored copies (they include the CEL fixes;
#    upstream's konveyor.io_agents.yaml won't apply until
#    agentic-controller PR #2 merges)
kubectl apply -f manifests/crd/

# 3. Namespace + sample Agent/LLMProvider
kubectl create namespace konveyor-agents
kubectl apply -f manifests/samples.yaml

# 4. Mock harness image (built INTO minikube's docker daemon —
#    pods use imagePullPolicy: Never)
(cd harness-mock && minikube image build -t acp-mock-harness:dev .)

# 5. Deps
(cd packages/agentrun-client && npm install)
(cd ~/Development/editor-extensions-cluster-agent && npm install)
```

### Optional: real goose + Bedrock

```sh
(cd harness-goose && minikube image build -t goose-harness:dev .)

kubectl create secret generic aws-bedrock-creds -n konveyor-agents \
  --from-literal=AWS_ACCESS_KEY_ID="$(aws configure get aws_access_key_id)" \
  --from-literal=AWS_SECRET_ACCESS_KEY="$(aws configure get aws_secret_access_key)" \
  --from-literal=AWS_REGION=us-east-1

kubectl apply -f manifests/goose-bedrock.yaml
```

## Daily loop

**Terminal 1 — the stand-in controller (must be running, or AgentRuns
never progress — they'll show a blank PHASE, since nothing else on the
cluster reconciles them):**

```sh
cd ~/agentcontroller-client/packages/agentrun-client
npm run simulator
```

**Terminal 2 — the extension:**

```sh
cd ~/Development/editor-extensions-cluster-agent
npm run build -w vscode/core     # or `npm run dev` for watch mode
code .
```

Press **F5** with launch config **"Run Core + Java Extensions"**. In the
dev host, open any git-backed project (e.g. a clone of
konveyor-ecosystem/coolstore) — the workspace's remote/branch are
auto-detected into the run's params.

**Drive it** from the dev host:

- Command palette → **"Konveyor: Start Cluster Agent on This Workspace"**
  → setup form (agent picker, params, model, HITL toggle) → chat panel
- Or the **Cluster Agent Runs** view in the Konveyor activity-bar icon:
  live phases, click a Running run to attach, trash icon to stop+delete

Settings (dev-host `settings.json`) — defaults target the mock; switch
to real goose with:

```json
"konveyor-core.clusterAgent.agentRef": "migration-analyzer-goose",
"konveyor-core.clusterAgent.llmProvider": "bedrock",
"konveyor-core.clusterAgent.model": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
"konveyor-core.clusterAgent.approvalMode": "smart_approve"
```

(`smart_approve` = write/execute tool calls pause for approval cards in
the chat. All settings: `konveyor-core.clusterAgent.{namespace, agentRef,
kubeconfig, llmProvider, model, approvalMode}`.)

## Headless smokes (no VSCode needed)

From `~/Development/editor-extensions-cluster-agent/vscode/core`
(simulator must be running):

```sh
npx tsx cluster-smoke.ts                 # mock: create → connect → prompt
AGENT_REF=migration-analyzer-goose \
GOOSE_MODEL_SELECTION="global.anthropic.claude-haiku-4-5-20251001-v1:0" \
APPROVAL=smart_approve npx tsx cluster-smoke.ts   # real goose + HITL
npx tsx drop-smoke.ts                    # connection-loss + resume path
```

No-cluster protocol check, from
`~/agentcontroller-client/packages/agentrun-client`:

```sh
GOOSE_SERVER__SECRET_KEY=localtest PORT=4100 node ../../harness-mock/server.mjs &
npx tsx dev/local-smoke.ts
```

## Poking the cluster directly

```sh
kubectl get agentruns -n konveyor-agents -w        # phases live
kubectl logs -f -n konveyor-agents <run>-sandbox   # harness/goose logs
kubectl get agentrun <run> -n konveyor-agents -o yaml
kubectl delete pod <run>-sandbox -n konveyor-agents  # reconnect demo
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ECONNREFUSED 127.0.0.1:<port>` from anything | Docker/minikube down: `open -a Docker`, then `minikube start`. Cluster state (CRs) survives; old sandbox pods don't (`restartPolicy: Never`) and their runs flip to Failed — correct, delete them. |
| Runs stuck with a blank PHASE (or `Pending`) | Simulator isn't running (Terminal 1). A brand-new run has no status at all until the simulator's first pass. |
| Pod stuck `PodInitializing` → run Failed | The `repository` param must be a real, publicly clonable URL — the init container git-clones it. |
| Commands missing in dev host | Stale build: `npm run build -w vscode/core`, relaunch F5. |
| `agents.konveyor.io` CRD won't apply from upstream | Known upstream CEL bugs (PRs #2/#3). Use `manifests/crd/` here. |
| Edited `harness-mock/server.mjs` but behavior unchanged | Rebuild the image into minikube (step 4) — pods never pull. |
| Bedrock auth errors in goose pod | Recreate the `aws-bedrock-creds` secret; check `aws sts get-caller-identity` locally. |
| Dev host logs a `401 ... provide your API key` model health check at startup | Kai's *core* GenAI provider (provider-settings.yaml, defaults to OpenAI) — unrelated to the cluster agent, whose LLM runs in the sandbox pod. Safe to ignore for this flow. |
| Hub Sign In fails: `fetch failed` to `localhost:9000/oidc` | Hub isn't needed for the cluster agent. That port is mock-konveyor-hub (launch-config env); `npm start` it if you want the Hub chrome + model health check green, otherwise ignore. |

Reset everything created by runs (secret/pod/service GC via owner refs):

```sh
kubectl delete agentruns --all -n konveyor-agents
```

## What's fake, and when it stops being fake

- `packages/agentrun-client/dev/simulate-controller.ts` — dies when
  agentic-controller grows its AgentRun reconciler (issue #1, stream 1.7)
- `harness-mock/` — becomes that repo's e2e test fixture
- `harness-goose/` — skeleton of the stream-4 base image
- `manifests/crd/` — dies when upstream PR #2 merges

The extension code is the part that's real.
