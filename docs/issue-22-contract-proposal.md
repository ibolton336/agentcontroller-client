# Draft comment for konveyor/agentic-controller#22 (3.1 API client layer)

Paste-ready. Standing rule: upstream delivery is a human decision — post
this manually after review.

---

Issue 3.1 depends on the Stream 2 API contract, so here's a concrete
proposal to start that discussion — not from a whiteboard, but from a
running system.

## What exists today

I've been prototyping the client layer in
[ibolton336/agentcontroller-client](https://github.com/ibolton336/agentcontroller-client)
against the real controller (PR #4) on minikube with Agent Sandbox v0.5.0.
Working end-to-end, verified with both the mock harness and a real
goose+Bedrock agent base:

- create AgentRun → wait for `Running` → resolve pod + ACP secret → ACP
  session with streaming updates, permission (HITL) round-trips, and cancel
- an isomorphic client core (`@konveyor/agentic-client`: contract types +
  `AcpSession` over plain WebSocket, no node builtins) with two transports:
  direct-k8s (IDE/node) and Hub-proxy (browser)
- a local stand-in for the Hub passthrough proxy (`hub-shim`) that a
  browser SPA drives today

Full write-up: [ADR 0004 — verified client contract and layered
transports](https://github.com/ibolton336/agentcontroller-client/blob/main/docs/adr/0004-client-contract-and-transports.md).

## Proposed Hub proxy surface (SHIM HTTP API v1)

The shim's HTTP surface is proposed as the reference shape for the Hub
passthrough proxy — i.e. the endpoint contract this issue's REST client
would be written against:

| Method | Route | Behavior |
|--------|-------|----------|
| GET | `/healthz` | 200 `ok` |
| GET | `/api/agents[/:name]` | 200 `Agent[]` \| `Agent` (full CRs) \| 404 |
| GET | `/api/llmproviders[/:name]` | 200 `LLMProvider[]` \| `LLMProvider` \| 404 |
| GET | `/api/skillcards[/:name]` | 200 `SkillCard[]` \| `SkillCard` \| 404 |
| GET | `/api/skillcollections[/:name]` | 200 `SkillCollection[]` \| `SkillCollection` \| 404 |
| GET | `/api/agentruns` | 200 `AgentRun[]` |
| POST | `/api/agentruns` | 201 `AgentRun` — body `{agentRef, params?, instructions?}` |
| GET | `/api/agentruns/:name` | 200 `AgentRun` \| 404 |
| DELETE | `/api/agentruns/:name` | 204 |
| WS | `/api/agentruns/:name/acp` | proxy to the sandbox pod's `:4000/acp` — the proxy resolves the pod (`status.sandboxName`), reads the key (`status.secretKeyRef` → `secret-key`), injects `X-Secret-Key`, and pipes frames |

The WS route is the piece browsers cannot do themselves (no custom upgrade
headers, no route to the pod), so endpoint resolution, secret injection,
and tunneling must live server-side in Hub. A browser client written
against this shape should work against the real Hub proxy by swapping the
base URL + auth.

## Contract facts the client layer depends on

Verified against the live controller (details + rationale in ADR 0004):

- pod name == `status.sandboxName` == run name; resolve by name, never by
  label (pods currently carry no `konveyor.io/agentrun` label — patch
  proposed separately)
- ACP key Secret `<sandboxName>-acp-key`, data key `secret-key`, via
  `status.secretKeyRef.name`
- ACP server: pod `:4000`, path `/acp`, `X-Secret-Key` auth; `/healthz`
  unauthenticated
- the auto-created Service is headless with no ports — dial the pod
  (or `<sandboxName>.<ns>.svc:4000` in-cluster)
- AgentRun spec is immutable (whole-spec CEL) ⇒ every edit/retry UI
  affordance is delete + recreate

## Open questions for Stream 2

1. **Resource coverage:** SkillCard, SkillCollection, and LLMProvider are
   served read-only (`GET /api/<plural>` + `GET /api/<plural>/:name`, same
   full-CR shape). Is read-only sufficient for the UI phase, or does
   Stream 2 want create/edit for these resources through Hub too?
2. **Permission diff preview (feeds 3.3):** approve/reject round-trips
   work today, but the ACP permission request carries no diff payload.
   If tackle2-ui is to show a diff preview, the agent side needs to send
   one — worth deciding the shape now.
3. **Auth:** the shim is an unauthenticated localhost tool; the Hub proxy
   presumably fronts this same shape with Hub authn/z. Any constraints
   that should change the surface (e.g. namespace scoping in the path)?

If the endpoint shapes above look right, I'll write the tackle2-ui client
layer (REST client + React Query hooks + WS client) directly against them.
