# Demo: the agentic platform, end to end (~10 minutes)

What this shows: **konveyor/agentic-controller PR #4 doing real work.** A
browser UI and the VSCode extension drive the same AgentRun/ACP contract,
a real goose+Bedrock agent reads a real repository, and a run started in
the web UI is picked up from the IDE — the architect → developer handoff.

No simulator anywhere: the reconciler is the real controller, the sandbox
is Agent Sandbox v0.5.0, the agent is goose 1.39 on AWS Bedrock.

## The stack

| Piece | What | Where |
|---|---|---|
| minikube | konveyor CRDs, Agent Sandbox v0.5.0, **agentic-controller (PR #4)** | `manifests/controller/install.yaml` (rendered snapshot, sha-pinned) |
| `packages/hub-shim` | stand-in for the future Hub passthrough proxy (REST + WS `/acp`) | :7080 |
| `ui/` | browser SPA (PatternFly) | :5199 |
| extension | `editor-extensions-cluster-agent` branch `feature/cluster-agent` | F5 dev host |
| `goose-harness:dev` | real agent base: entrypoint clones the repo, maps model env, runs `goose serve` | built into minikube (auto-rebuilt if missing) |
| `acp-mock-harness:dev` | deterministic mock agent (no LLM) — for the create-flow beat | built into minikube (auto-rebuilt if missing) |

### API-seeded defaults

The UI's **Load defaults** button (toolbar) calls `POST /api/defaults`,
which seeds 14 domain resources + the image catalog ConfigMap into the
cluster (create-only — re-seeding never clobbers edits):

- **Provider**: `gcp-vertex-ai` (shared)
- **Java EE → Quarkus set**: 4 SkillCards, 3 Agents on `agent-java`, 1 AgentWorkload
- **PatternFly 5→6 set**: 1 SkillCard, 3 Agents on `agent-nodejs`, 1 AgentWorkload
- **Image catalog**: `agent-image-catalog` ConfigMap (PR #53 hierarchy)

The PatternFly-migration domain skill lives in `skills/patternfly-migration/`.

**One command** (idempotent; safe after reboot / `minikube stop`):

```sh
hack/demo-up.sh     # preflight + converge cluster + start shim & UI, prints URLs
hack/demo-check.sh  # pre-demo smoke: full ACP round-trip on a throwaway mock run
hack/demo-down.sh   # stop the local processes; cluster untouched
```

Run `demo-check.sh` right before presenting — exit 0 means every beat's
surface is live (it creates, chats with, replays, and deletes a mock run
through the same shim/WS path the browser uses; costs nothing).

It verifies the controller deployment, rebuilds missing harness images,
applies `manifests/samples.yaml` (+ `goose-bedrock.yaml` when
`aws-bedrock-creds` exists), and gates on the Agent going Ready. Only true
prerequisites: minikube running, Agent Sandbox installed, and the
`agentic-controller:dev` image present (rebuild instructions live in the
`install.yaml` header). Runs do not survive a minikube restart
(`restartPolicy: Never`) — create fresh ones, don't rely on old pods.

## Beat 1 — create a run in the browser (2 min)

Open http://localhost:5199 → **Create run** → agent `migration-analyzer`
(the mock — instant, free) → application **Coolstore** → Create.

Note there is no repository field to type into: the agent declares that its
`repository`, `branch`, and git credentials come from the application
(ADR 0005), so the form shows what the platform will resolve and asks only
for what a human should actually answer. Worth saying out loud — it is the
whole point of the beat.

Narrate what's happening live: the SPA POSTs to the shim, the shim creates
the AgentRun CR, the **real controller** validates the Agent/provider chain
and creates a Sandbox CR, Agent Sandbox spins the pod, the phase label
flips Pending → Running, and the chat auto-connects over WebSocket through
the shim (X-Secret-Key injected server-side — a browser can't set WS
headers, which is exactly why the Hub proxy seat exists).

Send a message; show streamed chunks + the tool-call card. Delete the run
from the kebab (cascade: Sandbox, pod, Service, secret all GC).

## Beat 2 — the real agent (goose + Bedrock) (4 min)

The UI's create form doesn't yet set `models:`/`envFrom:` (known gap), so
create the real run via the API — which is the point: same CR, any client:

```sh
kubectl create -f docs/demo/real-run.yaml
kubectl logs -f -n konveyor-agents -l agents.x-k8s.io/sandbox-name-hash --tail=50   # or: kubectl logs <run-name>
```

Show the agent-base log lines: `cloning …coolstore@main`, `clone OK: … pom.xml …`,
`provider=aws_bedrock model=…haiku…`. That's the Phase-4 agent base doing
what the controller deliberately doesn't.

Open the run in the browser UI and ask:

> What build system does this project use? Name two files at the repository
> root that support your answer.

Watch a **real tool call** (`tree /workspace`) and a grounded answer
(Maven, `pom.xml`). This is Claude on Bedrock reading the actual clone.

## Beat 3 — the handoff (3 min)

F5 the extension dev host with the **coolstore** workspace open.

Within ~15s: a toast — *"Cluster agent real-XXXXX is running on this
workspace's repo (main). Attach to it?"* — the extension matched the run's
`repository` param against the workspace's git remote.

Click **Attach**: the session history **replays** (`session/load`),
including the browser-side Q&A, and the conversation continues in the IDE
next to the actual code. Same run, same session, two shells.

Also worth showing: `Konveyor: Attach to Cluster Agent for This Workspace`
in the palette (on-demand version of the toast).

## Beat 4 — the mock harness as a conformance surface (4 min)

Optional but the strongest beat for a protocol/platform audience. Everything
here is **deterministic, instant, and free** — no LLM, no Bedrock. The mock
(`acp-mock-harness:dev`, agent `migration-analyzer`) is a *real* ACP server
built on the same `@agentclientprotocol/sdk` the client uses; it just fakes
the agent. That's what lets us demo the hard protocol edges on cue — the ones
a live LLM can never be trusted to hit in front of a room.

Say the framing out loud: **this is how we prove the contract without burning
tokens or gambling on model behavior.** Same CR, same shim, same WS path as
every other beat — only the image differs.

Create (or reuse) a mock run against **Coolstore**, open its chat, and walk
the four capabilities. Each is triggered by a token in the prompt (see the
header of `harness-mock/server.mjs`):

1. **Diff-preview permission — the money shot.** Prompt with `TEST_PERMISSION`.
   The harness sends a `session/request_permission` carrying **standard ACP
   diff content blocks**, and the UI renders the actual code diff *before* you
   approve: a `javax.*→jakarta.*` rewrite of `InventoryService.java` plus a new
   `.konveyor/java-ee-findings.md`. This is literally the Konveyor migration
   story as a reviewable diff. Click **Reject**, watch the outcome echo back;
   re-run and **Allow**. Human-in-the-loop, end to end. (Forcing it even under
   `GOOSE_MODE=auto` is the whole point — the real agent only asks when *it*
   decides to.)

2. **Cancel mid-turn.** Prompt with `TEST_CANCEL`. It streams "still
   working (N)..." on a slow drip; hit **Stop**. `session/cancel` propagates
   and the turn ends with `stopReason: cancelled` — proving the client can
   interrupt a running turn, not just wait it out.

3. **Connection death — a live caveat.** Prompt with `TEST_DROP`. The harness
   destroys every TCP socket mid-turn (`kubectl logs` shows the destroy) —
   but through the shim's port-forward dial the drop is currently **absorbed
   by the tunnel**: the browser never sees a close and the pending prompt
   hangs (verified live; shim keepalive fix filed). Until that lands, demo
   the disconnect UX by severing the browser-side socket instead — the UI
   shows *Disconnected from the agent* with a **Reconnect** action.
   `TEST_DROP` remains the right conformance trigger for direct/in-cluster
   dials.

4. **`session/load` replay — same session, two shells.** The headline. Do a
   short Q&A in the browser chat, then **reconnect a second client** to the
   same run. On `session/load` the harness replays its entire recorded history
   (it keeps a per-session update log — the stand-in for goose's SQLite), so
   the second client materializes the full prior conversation before the next
   prompt. This is the exact mechanism behind the Beat 3 architect→developer
   handoff, shown in isolation so the audience sees *what* replays and *why*
   the IDE could resume a browser-started run. Two ways to show it:

   - **In the browser:** the run's `sessionId` lives in memory, so a hard
     refresh starts a *new* session — no replay. Instead, sever the
     connection mid-session (see item 3) and click **Reconnect**: the
     transcript clears and `session/load` replays it from the agent, not
     local state. (Note: the mock records only agent-side updates, so
     replayed history omits your own bubbles; goose replays both.)
   - **Scripted:** `hack/demo-check.sh` already drives
     create → Running → WS prompt → **`session/load` replay** → delete through
     the shim on a throwaway mock run (see `packages/hub-shim/dev/browser-smoke.ts`).
     Run it live and narrate the replay step — exit 0 means every surface,
     including replay, is green. Costs nothing.

Delete the run from the kebab when done (cascade GC as in Beat 1).

## Talking points

- **Only one lane changes later**: browser clients (this SPA, tackle2-ui,
  RHDH) all ride the gateway seat; hub-shim occupies it today, the real Hub
  passthrough proxy replaces it — the shim's route table *is* the proposed
  spec (docs/adr/0004). Hub already has the `/services/:name/*path`
  precedent; stdlib ReverseProxy has done WS upgrades since Go 1.12.
- **Nobody rewrites UX**: the extension kept its panel/tree; tackle2-ui
  gains chat capability it doesn't have (zero WS code today).
- **Contract is verified, not aspirational**: pod == `status.sandboxName`,
  ACP key `secret-key`, headless portless Service, no run label on the pod,
  whole-spec immutability — all proven against the live controller and
  encoded in the shared client core.
- **Upstream asks are small and pre-merge**: see docs/UPSTREAM-FEEDBACK.md.

## Cleanup

```sh
kubectl delete agentrun --field-selector metadata.name=<run> -n konveyor-agents  # or by name
```

Idle goose costs nothing (Bedrock bills per request), so keeping the real
run alive as a standing demo target is fine.
