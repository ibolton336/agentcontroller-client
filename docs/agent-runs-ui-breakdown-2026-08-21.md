# Agentic console on `feature/agent-runs` — work breakdown and gaps

Snapshot 2026-08-21. Sources: the tackle2-ui checkout (`~/Development/tackle2-ui`,
local HEAD `3341a606d`, clean tree), PR [ui#3546](https://github.com/konveyor/tackle2-ui/pull/3546)
(head `7ce9cf137`), tracking issues #3504 / #3520–#3527, the 08-06 scope call and
08-11 prototype call, `docs/skills-ux-gaps.md`, `docs/agentic-inventory-ux-gaps.md`,
`docs/tackle2-ui-graduation-plan.md`. Gates were re-run today on the local HEAD.

## 1. Where the branch stands

- 46 commits on konveyor/tackle2-ui main `1393f0ae4` (0 behind as of today); 65 files,
  **+14,261 / −14** — near-pure additive.
- Gates on local HEAD: `common` build OK, `tsc` clean, eslint **0 errors / 20 warnings**
  (20 is the ceiling; every warning is pre-existing main code).
- ui#3546: **19/19 checks green** on `7ce9cf137`; reviewers requested (sjd78, rszwajko);
  **0 human reviews**. CodeRabbit posted a skip notice — this repo gets no automatic
  review (<10 stars), so the only review coming is human.
- **One commit is local-only:** `3341a606d feat(agentic): skills authoring, detail
  drawers, and run-side skill visibility` (+3.3k lines, 08-21) is on neither the fork nor
  the PR. The PR is stale by the whole skills-authoring expansion.
- No test files and no docs on the branch. `cypress/` carries no agentic spec and the CI
  e2e tiers run with the flag off — **nothing in CI exercises the console**; evidence is
  the mock-stack rig plus live-cluster runs (stated in the PR body).

## 2. Work breakdown by surface

| # | Surface | Files | +lines | What is there | Verified how |
|---|---|---|---|---|---|
| 1 | Plumbing + gate | 12 | 170 | `/hub` proxy gains `ws: true` + an upgrade handler scoped to `/hub/agentic/`; `AGENTIC_ENABLED` and `AGENTIC_STEER_ENABLED` (serverConfig default `false`, webpack.dev default `true`, env-types, env.ts); gated route list, sidebar "Agentic" group, SidebarApp `Switch` entry; `@patternfly/chatbot ^6.4.1` (+738-line lockfile hunk); chatbot css in `stylePaths.ts` | Flag-off hides nav + routes on the mock rig; WS 101 through the express upgrade path |
| 2 | API + queries + utils | 10 | 1,466 | `api/agentic/contract.ts` (CRD shapes incl. the #157 skill shape), `api/rest/agent-runs.ts` (hub `/agentic/*`, CR envelopes, PUT→204, ACP nonce mint), six query modules (agent-runs, agents, skills, workflows, workflow-runs, agentic-catalog incl. gateways) polling at `DEFAULT_REFETCH_INTERVAL`, `utils/agentic.ts` (application-label join, eligibility partition, launch preflight), `utils/skills.ts` (frontmatter validator mirroring the controller's) | Mock contract fixture (`hack/mock-inventory-stack.mjs`) + real hub on the local-stack rig |
| 3 | Agent runs | 11 | 2,266 | List on `useLocalTableControls` (Name / Application / Phase chips, sort, pagination, URL-persisted `agr`); detail (spec panel, params, env with the token masked, BranchPanel commit feed, Skills group); CreateRunModal (agent picker with Ready state, application-scoped for managed agents, target branch, GatewayPicker, typed params + platform-param preview, instructions); PhaseLabel / ReadyLabel | Live on ROKS (37 runs paginate) + rig |
| 4 | Session panel | 3 | 2,603 | ChatPanel on PF Chatbot: dials on `ACPReady` (legacy phase+sandbox fallback loop), nonce two-step, message/thought chunks, tool calls + updates, plan ladder, elicitation ask cards, `request_permission` with diff preview + Allow/Reject, steer behind the flag (activeRunId handshake, bubble lifecycle), cancel = `session/cancel` behind ConfirmDialog, bounded reconnect with `session/load` replay, fullscreen, reader-intent auto-scroll, "Loaded skill …" rows | Scripted mock runs (boot race, flaky, steer early/late/off) + real Bedrock turns in the transcript |
| 5 | Workflow runs | 5 | 1,214 | List (chips incl. Workflow, `awr` prefix); detail with stage ladder → agent-run links; CreateWorkflowRunModal (param union across stage agents, uniform-default omission, gateway intersection, repo-less guard); `runs-page-links.ts` deep link | Live on ROKS + rig |
| 6 | Workflows authoring | 3 | 700 | Composer (guide, ordered stages with agent select + instructions, gateway-overlap warning), list with ReadyLabel, delete confirm | Two-stage create/delete E2E on the local-stack rig (CR byte-exact); **edit hydration untested** |
| 7 | Agents authoring | 3 | 795 | Designer (name, image free-text + builtin suggestions, prompt, gateways, skill cards, collections, params with type/default/required), list with Ready, delete | Create/edit/delete E2E on the local-stack rig |
| 8 | Skills authoring | 11 | 3,357 | SkillCardModal (Inline / Image / Git, SKILL.md editor + template + frontmatter validation), SkillCollectionModal (explicit picker or enumerate-an-image), detail drawers with referenced-by, SkillLabels (type / delivery mode / Ready tooltip), description column; RunSkillsSummary on run detail | Browser-verified on the mockstack rig 08-21 — **this is the unpushed commit** |
| 9 | Inventory integration | 5 | 543 | Toolbar bulk item + row kebab action → BulkAgentRunModal (eligibility split; preflight blocks on dangling `agentRef` / required-defaultless params, warns on missing source credential); client-side fan-out (`allSettled`, success/failure split); landing on the pre-filtered runs page; Details-tab deep link | Rig (wire-logged POSTs) + live |
| 10 | i18n | 1 | 409 | Every console string through `agentic.*` / `terms.*` / `sidebar.*` | — |

## 3. Issue scorecard — what the PR claims vs what is on the branch

| Issue | PR claim | Reality | Residue |
|---|---|---|---|
| #3522 feature gate | closes | **Done** | Operator-side wiring is operator#590 (open, unowned) |
| #3520 bulk run from inventory | closes | **Done** | One shared target branch per batch (the issue asked for per-app templating) — parked for David's configure object; fan-out is client-side by design |
| #3521 app detail runs | closes | **Done, differently** — row action + Details-tab deep link to the pre-filtered runs page; the drawer tab in the issue title was deleted on purpose (fetch-everything) | Say so in the PR if a reviewer asks; inventory status column = fast-follow |
| #3525 standalone AgentRun | closes | **Done** | — |
| #3527 HITL read-only + flagged steer | closes | **Done** for transcript / plan / asks / permissions / steer flag / cancel | **Not rendered:** `usage_update` frames (the issue text names usage), harness outcome `status_message`, final-push progress. ROKS runs the flag **on** |
| #3523 server-side chips | advances | Client-side chips done, URL-persisted | `?application=` waits on the hub (#1119 carries only the managed label) |
| #3524 namespaced params + modes | advances | Typed forms from declarations; union across stages | No workflow/agent namespacing, no mode selection, no limits on authoring forms — all need AC#115 (open) |
| #3526 continue work | not started | — | AC#128 moved to milestone **Next** |
| #3504 item 2 — RBAC | unclaimed | **No scope gating anywhere** in the agentic tree; `ScopeGate` / `useHasSomeScopes` exist in `scopes.ts` | Architect is get-only on agents/gateways by design (Jeff 08-20) → authoring buttons render, then 403 |
| #3504 item 5 — delete / retry | dropped | Run delete removed honestly: the hub has no `DELETE /agentic/agentruns/{name}` | Run detail has **zero actions** (no re-run, cancel, delete) |
| #3504 item 6 — single-writer state | obsolete | The ACP tee fans out to viewers; write = steer behind the flag | — |

## 4. Gap register

### A. Hygiene — before or with the next push

| # | Gap | Effort |
|---|---|---|
| A1 | `3341a606d` (skills authoring, +3.3k) is unpushed; the PR and its body describe the pre-skills branch. Gates are green locally. | 30 min incl. PR-body edit |
| A2 | Six orphan i18n keys with zero code refs: `sourceConversion*` (2), `directImage`, `skillCardNamePlaceholder`, `noSkillsSelected*` (2) | 10 min, fold into A1 |
| A3 | ~~`AGENTIC_ENABLED` / `AGENTIC_STEER_ENABLED` are undocumented~~ DONE 08-21: tackle2-ui `621e32305` (README flags bullet + quick-start note; ARCHITECTURE.md "Agentic Console" section with defaults, gates, code map) — unpushed | — |
| A4 | Demo posture: the ROKS UI runs `AGENTIC_STEER_ENABLED=true` (since 08-19) on the pre-skills image | Ian's call |
| A5 | ui#3545 (OIDC `offline_access`) has an untriaged `@tier3_C` failure; the 5-minute session death hits the console hardest because runs outlive the token | 1 h triage |
| A6 | No CI coverage of the console (flag off in e2e tiers, no Cypress spec) — expect the review ask | see B10 |

### B. Review-round / post-merge UI work — no upstream dependency

| # | Gap | Effort |
|---|---|---|
| B1 | Scope-gate the authoring surfaces (create / edit / delete on agents, skills, workflows; steer) with `ScopeGate` on the scopes hub#1119 seeds; migrator is read-only, architect get-only on agents/gateways | ½ day |
| B2 | Read-only view completeness: render `usage_update` (turns / cost — the counters the coming limits are measured in), the harness outcome `status_message`, push progress | 1 day |
| B3 | "Run again": prefill CreateRunModal / CreateWorkflowRunModal from a finished run. Spec is immutable and the hub has no delete, so this is the only re-run shape available today | ½ day |
| B4 | Gateways page (read-only: provider / model / Ready + condition message). AC#167 — Bedrock / Vertex gateways can never become Ready — is invisible to users today; agents just read Not Ready | ½ day |
| B5 | Agents / Skills / Workflows lists on `useLocalTableControls` (sort, filter, pagination). Fence #4 (08-06) says ship as-is | 1 day, only if asked |
| B6 | Failure reasons on run detail: show `status.conditions` reason + message beside the phase (Ready=False today; `Succeeded` / `LimitReached` after C2) | ½ day, re-touch at C2 |
| B7 | Strip the legacy (phase + sandbox + secret) dial fallback once no controller without `ACPReady` remains — ROKS is still on the pr160 image | ¼ day |
| B8 | Designer polish from the 08-12 smoke: unhydrated flash on designer open, param rows invisible to the a11y tree, 12 px Required checkbox target — unverified since | ½ day |
| B9 | Never driven E2E: workflow edit hydration, skill-collection edit, non-admin role rendering. Verification, not code | ½ day on the local-stack rig |
| B10 | Cypress smoke for the console against the mock stack, if reviewers ask (the mock has to run in CI) | 2 days |

### C. Blocked upstream — watch, don't build

| # | Gap | Waits on | UI effort once unblocked |
|---|---|---|---|
| C1 | Mode selection, workflow/agent param namespacing, limits on authoring forms (ui#3524) | AC#115 (open) | 1–2 days |
| C2 | `Succeeded` condition migration — blast radius mapped: `isTerminalPhase`, PhaseLabel, 4 display sites, both filter matchers, ReadyLabel | AC#119 (open; Ian's 3 questions to David outstanding) | ½ day |
| C3 | Server-side `?application=` chips (ui#3523) | hub#1119 merge + a hub follow-up | ¼ day swap |
| C4 | Continue work (ui#3526) | AC#128 (milestone Next) | 1 day |
| C5 | Operator feature gate — until it lands the console is enabled only by patching the UI deployment env | operator#590 (open, unowned) | — |
| C6 | Skills file import / doc-to-skill, provenance column; `contract.ts` re-sync if the #157 shape moves | AC#158 (Next), AC#157 (open) | 1–2 days |
| C7 | Hub routes missing for UI actions: `DELETE` agentruns, a real cancel (today = ACP `session/cancel`, which fails the stage), 400 on application-less creates for managed agents (the client guards; the hub doesn't) | hub#1112 follow-ups | — |
| C8 | Steer authorization | hub#1116 | keeps steer flag-only |

### D. Design-owed

| # | Gap |
|---|---|
| D1 | Send the designer the repo link + the ux-gaps doc (drafted 08-11, not sent) |
| D2 | Designs owed from the 08-12 list: failure-reasons surface (list vs detail), "analysis is a prerequisite" messaging at launch, inventory "Migration status" column, per-app target branch in bulk |

## 5. Action list

1. **Ian — push `3341a606d` to the fork** so ui#3546 carries the skills work; prune the six
   orphan i18n keys in the same push; edit the PR body's scope + verified paragraphs.
   Gates are green. *30 min.*
2. **Ian — decide the ROKS posture**: flip `AGENTIC_STEER_ENABLED` off before any demo to
   people who shouldn't type at the agent; roll the image once the push lands.
3. **Ian — triage ui#3545's tier3_C** (flake → rerun, real → fix), then ask for its review.
4. ~~**Ian — document the two flags** in ARCHITECTURE.md / README.~~ DONE 08-21 (`621e32305`, rides the next push).
5. **Reviewers (sjd78, rszwajko) — already requested**; nudge in Slack if nothing by Monday.
   Answer test asks with the mock fixture + live evidence; B10 only if they insist.
6. **Ian, review round or right after merge — B1 scope gating and B2 usage/outcome
   rendering** are the two gaps a dev-preview user will hit first (403 toasts; "how much
   did this cost"). *1½ days together.*
7. **Ian, cheap wins when there's a gap in the week**: B3 "Run again" and B4 Gateways page
   (*1 day together*), B6 condition reasons (*½ day*).
8. **Ian — send the designer the repo link** (D1) and hand over D2 as the design backlog.
9. **Watch, don't build**: AC#115 (modes/limits), AC#119 (Succeeded), hub#1119 merge
   (server chips), AC#128 (continue), operator#590 (gate wiring — needs an owner).

## 6. Status — 2026-08-21 evening (B-list worked on `feature/agent-runs`)

Seven commits on the local checkout, on top of `621e32305` (the flags-doc commit), **not yet
pushed** to the fork / ui#3546. Gates (tsc, eslint ≤20 warnings, prettier, husky) green on
every commit. Mock fixture changes live in this repo (`e91b5f9`, `4a5b281`).

| # | Status | Commit | Evidence |
|---|---|---|---|
| B1 scope gating | **Done** | `fe1c13c9d` | Masquerade presets (dev rig, mirrors of the hub#1119 seed) and **real hub tokens on the `hub-auth` rig**: `rig-pm` sees no create/edit/delete anywhere and "No access" on the run page (nonce never minted); `rig-migrator` sees Create run / Create workflow run and a workflows kebab of just *Run*; `rig-architect` authors skills/workflows but not agents. Token decode confirms the hub expands `*` to `decrypt delete get patch post put`. |
| B2 usage / outcome / push | **Done** | `6c2dc5444` | `acp.ts` now dispatches `_goose/unstable/session/update`; header badge "48.2K / 200K · 4 turns · $0.151", closing "stage succeeded — results pushed to branch …" notice, harness `git push (final)` as a harness step — on the mock's skills run (fixture `e91b5f9`). Not yet seen against a real goose (needs a live run on the rig). |
| B3 run again | **Done** | `9244d5b8c` | Failed agent run → modal "Run again: …" with its own agent preselected; failed workflow run → its workflow, application from the label, fresh branch, stage agents fetched. Prefill captured once (polling cannot reset the form). |
| B4 gateways page | **Done** | `8f5019748` | `/gateways` renders the rig's four gateways for every role; the mock's `gcp-vertex-ai` gateway shows ConnectionFailed + "Unverifiable provider" and the page-level AC#167 alert; a Verifying gateway stays quiet. |
| B6 failure reasons | **Done** | `0a7ab3ef0` (+ `9244d5b8c` passes the phase) | Real rig run `ui-v9427`: "Failed · Sandbox finished with reason: PodFailed"; mock workflow run: "Failed · StageFailed · Stage "migrate" failed …". Progress reasons stay hidden. Re-touch at C2 (Succeeded condition). |
| B7 strip dial fallback | **Done** | `f9ddb0ac1` | Mock: `boot-race-run` gets exactly one nonce + WS upgrade once ACPReady flips; `legacy-boot-race-run` is never dialed and shows the #160 notice. Rig controller (`ghcr.io/ibolton336/agentic-controller:demo`) CRD carries ACPReady. |
| B8 designer polish | **Done** | `341813641` | Spinners until the catalog settles; params editor is a table (headers, "Parameter N <field>" labels, "Remove parameter N", wrapped Required label 92×21 px); catalog checkboxes named. |
| B9 never-driven E2E | **Done (verification)** | — | On the `hub-auth` rig with real users: skill-collection edit hydrates and PUTs (gen 1→2, members byte-identical; restored afterwards), workflow create → edit hydrates → PUT (gen 2, two stages) → delete via the console. Non-admin rendering as above. |
| B5 table controls | not started | — | "only if asked". |
| B10 Cypress | not started | — | "if reviewers ask". |

Rig changes left in place: users `rig-architect` / `rig-migrator` / `rig-pm` (roles 2/3/4, password
`rig-<login>-pw`, local minikube only) on the `hub-auth` hub for future role checks; the
`tackle2-ui` port-forward on :18081 was stopped for the local auth-on UI and restored afterwards.

Tooling notes for the next round: the prod bundle tree-shakes the masquerade switcher, so
persona checks need a `NODE_ENV=development` bundle (express dev server on :9005 fronting
webpack on :9001, `TACKLE_HUB_URL` = mock); the preview tool's health probe kills a bare
webpack-dev-server (its `GET /` blocks until the first bundle), so run webpack outside it; the
Browser pane's accessibility tree only reads the fronted tab with a real viewport
(`resize_window` first) and the hub login page needs `form.requestSubmit()`; OIDC sessions are
per tab, so one tab per rig user works.
