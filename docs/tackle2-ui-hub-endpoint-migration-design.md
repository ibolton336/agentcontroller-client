# tackle2-ui agentic console → real hub endpoints (design)

2026-08-10. Approved in-session; implementation plan follows separately.

> **2026-08-11 update:** the route namespace was renamed `/agent/*` →
> `/agentic/*` (mock, UI, and the direction agreed for hub PR #1119).
> Route strings below are the `/agent`-era record; only the prefix differs.

## Goal

`feature/agent-runs` (ibolton336/tackle2-ui, currently @ 8a70bf644) stops
speaking the hub-shim contract entirely and speaks the real hub's `agent/*`
API — hub#1112 as Jeff is implementing it on `jortel:tackle2-hub@agentic`
(verified 2026-08-10 @ 392a9493). Deliverables:

1. The migrated branch, browser-verified cluster-free against a mock hub.
2. A rebuilt multi-arch `ghcr.io/ibolton336/tackle2-ui:demo` image.
3. A handoff doc for the coworker's env (Jeff's hub + agentic-controller,
   auth off), including a what-works / pending table.
4. A short conformance comment for hub#1112, drafted for Ian's review
   before anything is posted (draft at the bottom of this doc).

## The hub contract as implemented today

Routes (all behind `Authenticate()`; noauth in the target env):

| Resource | Route | Verbs |
|---|---|---|
| Agent | `/agent/agents[/:name]` | list, get, create, update, delete |
| SkillCard | `/agent/skills[/:name]` | list, get, create, update, delete |
| SkillCollection | `/agent/skillcollections[/:name]` | list, get, create, update, delete |
| Gateway | `/agent/gateways[/:name]` | list, get, create, update, delete |
| AgentRun | `/agent/runs[/:name]` | list, get, create |
| AgentRun ACP | `/agent/runs/:name/acp` | GET → WebSocket relay to sandbox |
| AgentWorkflow | `/agent/workflows[/:name]` | list, get, create, update, delete |
| AgentWorkflowRun | `/agent/workflowruns[/:name]` | list, get, create |

Wire shapes are the controller's v1alpha1 CR types serialized directly:
lists return a JSON array of full CRs, create binds a full CR body and
returns it (201), update binds a full CR and returns **204 no body**.

Not implemented yet on the branch (vs the #1112 text): run cancel, run
delete (never planned), `?application=` filter, application-label
stamping (`injectLabels` adds only `konveyor.io/managed=true`), scoped
token minting + `HUB_BASE_URL`/`HUB_APP_ID` env injection, and the
400-on-managed-agent-run-without-application guard.

Known drift/bugs in the WIP, flagged to Jeff (draft below), designed
around rather than depended on:

- `RunList`/`WorkflowRunList` filter on `konveyor.io/managed=true`;
  controller-created workflow **stage runs won't carry that label**, so
  the stage → run drill-down will come up empty until fixed.
- The ACP route sits behind header-based auth; **browser WebSockets
  cannot send an Authorization header**. Fine while auth is off.
- Env-name drift: #1112 says `HUB_APP_ID`; the shim/harness contract is
  `APP_ID` (with `HUB_BASE_URL`, `TARGET_BRANCH`).

## Decisions

### D1 — Transport: ride the `/hub` proxy (cutover, no dual mode)

- All agentic REST moves to `/hub/agent/...`. The global axios Bearer
  interceptor already covers `/hub`, so auth-on REST works with no
  agentic-specific code.
- `server/src/proxies.js`: delete the `agentic` entry; add `ws: true` to
  the `hub` entry.
- `server/src/index.js`: replace `server.on("upgrade", agenticProxy.upgrade)`
  with a path-routed handler — upgrade requests matching
  `/hub/agent/runs/<name>/acp` go to the hub proxy's `upgrade`; any other
  upgrade path keeps its pre-existing behavior (dev-server HMR must be
  re-verified, not regressed, by this change).
- `serverConfig.js`: `AGENTIC_SHIM_URL` is deleted. `AGENTIC_ENABLED`
  becomes a plain env flag, default `"false"`.
- The retired names (`AGENTIC_SHIM_URL`, `/agentic`) must not survive
  anywhere in the tree (grep gate in the plan).

### D2 — REST layer: paths and envelopes, no read mappers

`contract.ts` types are already CR-shaped (`metadata: ObjectMeta`, `spec`,
`status`) and the shim already serves CR JSON, so **read paths need no
shape adaptation** — only URLs change. The whole diff concentrates in
`client/src/app/api/rest/agent-runs.ts` plus the queries layer:

- Path map: `agentruns→runs`, `agents→agents`, `skillcards→skills`,
  `skillcollections→skillcollections`, `gateways→gateways`,
  `agentworkflows→workflows`, `agentworkflowruns→workflowruns`, all under
  `/hub/agent`. WS URL: `/hub/agent/runs/:name/acp`.
- Config-kind create bodies change from the shim DTO `{name, spec}` to a
  CR `{metadata: {name}, spec}`. Updates change from `{spec}` to
  `{metadata: {name}, spec}`, expect 204, and return `void` (react-query
  invalidation already refetches; no code depends on update echoes).
- `RunApi` interface in `contract.ts` drops `deleteRun`,
  `deleteWorkflowRun`, `loadDefaults`; gains nothing.

### D3 — Run creation: the modal stays the resolver; env stays server-side

The UI builds the run CR itself (both run kinds, same treatment; workflow
runs carry `workflowRef` in `spec` instead of `agentRef`):

```json
{
  "metadata": {
    "generateName": "ui-",
    "labels": { "konveyor.io/application": "<hub app id>" }
  },
  "spec": { "agentRef": "...", "params": [...], "instructions": "...", "gateway": "..." }
}
```

- `generateName: "ui-"` replicates the shim's naming.
- The `konveyor.io/application` label is stamped **client-side** when an
  application is selected — same key/value the shim stamps (daab736), so
  per-application views keep working across shim-created and hub-created
  runs, and nothing breaks when Jeff moves stamping server-side.
- Platform params keep resolving in the modal (create-time-resolver seam,
  unchanged): resolved values ride `spec.params`.
- **The UI does not set `spec.env`/`spec.envFrom`.** `HUB_BASE_URL` is
  in-cluster knowledge the browser doesn't have, and partial injection is
  useless to the harness. Until Jeff lands #1112 injection: runs needing
  hub grounding (assess-style playbooks reading insights; PAT-identity
  pushes via envFrom) **will not ground** — a documented pending item,
  not something to fake client-side. Gateway LLM credentials are
  unaffected (controller mounts them since agentic-controller#100).
- The managed-agent-without-application 400 guard is hub-side and pending;
  the modals already require an application for annotated agents, which
  covers the UI path meanwhile.

### D4 — Feature deltas (honest removals, no silent stubs)

- **Run / workflow-run Delete actions removed** (list rows + detail).
  Hub has no run delete; cancel arrives later — wiring `POST .../cancel`
  is an explicit follow-up once it exists.
- **Load-defaults button removed** (toolbars + empty states +
  `agentic-catalog` query + `SeedResult` contract). Seeding is a
  cluster-side `kubectl apply` documented in the handoff.
- **Image catalog dropped**: agent designer image field becomes free text
  with a small built-in suggestion constant (the existing custom-image
  escape already exists; the `/images` fetch and provenance UI go).
- **Applications come from core hub queries** (`useFetchApplications`).
  `AgenticApplication`, `getApplicationsWithSource`, and the
  X-Inventory-Source provenance UI are deleted. Consumers map
  `Application {id, name, repository}` directly.
- **Per-application run filtering is client-side** on the
  `konveyor.io/application` label (replaces both the shim's
  `?application=` param and the drawer tab's `spec.env APP_ID` matching —
  hub-created runs won't have that env var until injection lands, but
  they will have the label from D3). Server-side filters are Jeff's
  later round per the 2026-08-10 call.

### D5 — Verification (E2E only, per repo testing policy)

Cluster-free first — rewrite `hack/mock-inventory-stack.mjs` as a **mock
hub** (single server, `:18090`): core `/applications` plus `/agent/*`
serving CR shapes from an in-memory store, POST/PUT bodies logged for
wire-shape proof, `/agent/runs/:name/acp` accepting a WS upgrade for
connection smoke. Launch entry: `TACKLE_HUB_URL=http://localhost:18090`,
`AGENTIC_ENABLED=true`, no shim vars. Browser matrix:

1. All five list pages + both detail pages against mock CRs.
2. Both create modals: logged wire payloads show CR envelope,
   `generateName`, application label, resolved params, gateway.
3. Agent designer / skill / workflow CRUD round-trips (create → PUT 204 →
   refetched state).
4. Inventory drawer "Agent runs" tab + bulk workflow launch
   (label-based filtering, including a just-created run).
5. `AGENTIC_ENABLED` unset → no agentic nav/routes.
6. WS connect smoke against the mock upgrade endpoint.

Then real E2E on the coworker env (list/detail on real CRs;
inventory-launched run reaches Running; ACP chat through Jeff's relay —
his relay dials in-cluster service DNS, so chat requires hub in-cluster;
branch panel). Expected failure to record, not fix: workflow stage-run
drill-down empty until Jeff's managed-filter fix.

### D6 — Image & handoff

After browser verification: push `feature/agent-runs`, dispatch
`build-images.yml` (`tackle2_ui_ref=feature/agent-runs`) → multi-arch
`:demo`. Existing demo clusters pin digests and keep working; new pulls
get the hub-contract UI.

Handoff doc (this repo, `docs/`): env prerequisites (hub built from
`jortel:agentic`, agentic-controller CRDs + controller + gateway secret,
seed via `manifests/samples.yaml`), UI deployment (image ref +
`AGENTIC_ENABLED=true` + `TACKLE_HUB_URL` per topology), the what-works
table, and the pending list (cancel, token/env injection, server-side
label stamping, stage-run visibility, WS auth-on, hub-side 400 guard).

### Out of scope

Cancel wiring, auth-on WS mechanism, HITL/steering surfaces, remaining
graduation gaps (useLocalTableControls tables, re-run affordance,
workflow-modal advisories), upstream tackle2-ui PR prep, any shim code
changes (the shim keeps serving existing rigs; the UI just stops calling
it).

## Risks

- **Jeff's branch moves daily** ("checkpoint" commits). Contract facts
  here are pinned to 392a9493; re-verify route/shape drift right before
  the coworker-env E2E. The mock hub doubles as the drift detector — it
  encodes what the UI expects.
- **CR spec fidelity**: `contract.ts` claims to mirror
  `agentic-controller api/v1alpha1`; the plan includes a field-level
  check of both run specs against the controller source before the
  create mapping is written.
- **Upgrade routing regression**: the old handler upgraded `/agentic`
  WS on a cold connection; the new path-routed handler must be verified
  with a cold-start WS connect (mock smoke covers it).

## Draft comment for hub#1112 (review before posting — not posted)

> A few things surfaced while pointing the tackle2-ui branch at the
> `agentic` branch's contract:
>
> 1. `RunList`/`WorkflowRunList` filter on `konveyor.io/managed=true`,
>    but controller-created workflow stage runs don't carry that label —
>    the workflow → stage-run drill-down comes up empty. The shim's
>    reference behavior filters managed on config kinds only and leaves
>    both run lists unfiltered.
> 2. `agent/runs/:name/acp` sits behind header auth, and browser
>    WebSockets can't send an Authorization header — fine for noauth
>    envs, but auth-on needs a mechanism (token query param or
>    `Sec-WebSocket-Protocol`). Happy to write up the options.
> 3. Env naming: the issue text says `HUB_APP_ID`; the shim/harness
>    contract today is `APP_ID` (alongside `HUB_BASE_URL`,
>    `TARGET_BRANCH`). Whichever wins, the harness and injection need to
>    agree before injection lands.
> 4. The UI now stamps `konveyor.io/application` on run creates
>    client-side (same key the shim stamps) so per-application views
>    work before server-side stamping lands — it'll keep working if
>    create starts stamping it server-side, so no urgency, just noting
>    the interim.
