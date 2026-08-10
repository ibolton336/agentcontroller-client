# Agentic migrations from the application inventory — UX gap analysis

**Status:** recon complete, pre-implementation · **Date:** 2026-08-10 · **Scope:** konveyor epic "agentic migrations built around the application inventory" (dev preview / v0.11.0)

**Evidence base:** tackle2-ui `feature/agent-runs` branch, tackle2-hub v23 model + live no-auth Hub, agentcontroller-client hub-shim (reference implementation), konveyor/agentic-controller#121, `docs/v0.11.0-issue-tree.md`.

---

## 1. Verdict

The inventory-side plumbing is roughly half built and the archetype side is not started: single-app and bulk triggering from the inventory exist end-to-end (row kebab + bulk toolbar → `BulkAgentRunModal` → client-side fan-out, one POST per app), and per-app progress exists in the detail drawer — but **every archetype-facing acceptance criterion has zero implementation** (no association data model, no archetype trigger, no archetype identity on runs, no archetype filter), the runs pages have **no filters, no URL-param mechanism, and no application column**, so the already-scope-locked landing pattern ("route to runs page with filter pre-applied", B5/B6) has nothing to route to, and all application↔run joins are done by fetching *everything* and matching `spec.env` `APP_ID` client-side. The good news: the hard parts have existing patterns to clone (target-profiles for association, ADR 0006 label stamping + the shim's `?application=` filter for identity, `useLocalTableControls` URL filters for chips), so the gaps are well-shaped issues rather than open research — except AC#121, which is a genuine decision that must be made **before** the preview because one of its options is unrecoverable if skipped.

---

## 2. Gap table

Ordered blockers first. Area key: **A1** archetype↔workflow association · **A2** trigger from inventory · **A3** progress per application · **A4** archetype identity on runs · **A5** assessment/review integration.

| # | Gap | Area | Severity | Evidence | Owning issue |
|---|-----|------|----------|----------|--------------|
| 1 | No archetype↔workflow association exists anywhere — no data model, no UI. Hub `TargetProfile` carries generators + analysisProfile but no workflow ref; grep of `client/src/app/pages/archetypes` for `workflow\|agentic` returns zero matches. | A1 | **Blocker** | hub `internal/migration/v23/model/application.go:201-215`; grep of archetypes pages → no output | **hub#1115** (B3) |
| 2 | Runs carry no archetype identity and the stamping-vs-query-time decision is unmade; the archetype half of run-list filtering is explicitly deferred "pending a decision on how runs carry archetype identity". Zero archetype support in the shim reference implementation. | A4 | **Blocker** | AC#121 (open, zero comments, milestoned v0.11.0); hub#1112 acceptance comment; `grep -rni archetype packages/ --include='*.ts'` → no matches | **AC#121** |
| 3 | Runs pages have no filter toolbar, read no URL query params, and persist no filter state — the B5/B6 scope decision ("route to runs page with filter pre-applied") has **no mechanism today**. | A3 | **Blocker** | `workflow-runs-page.tsx:102-137` (Create button only); grep for `useUrlParams/search` in workflow-runs → no output | **ui#3523** (B7), enables ui#3520/#3521 |
| 4 | Hub has no run-list query filters: hub#1112's body specifies routes but no `?application=`/`?archetype=`; the only implementation of filtering is the shim. UI REST layer matches — `getWorkflowRuns()`/`getAgentRuns()` take zero arguments, so no server-side selector is expressible. | A3/A4 | High | hub#1112 body + acceptance comment #2; `client/src/app/api/rest/agent-runs.ts` | **hub#1112** (B2 folded in) |
| 5 | Stage AgentRuns don't inherit parent labels (controller builds a fixed 3-key label map), so application — and archetype, once stamped — is invisible on stage runs. Load-bearing for the whole filtering story. | A4/A3 | High | AC#107; shim comment `server.ts:1179-1182` | **AC#107**, fix **PR#113** open |
| 6 | Per-app progress is drawer-only and unscalable: `TabAgentRunsContent` fetches ALL workflow runs + ALL agent runs and filters client-side by `spec.env` APP_ID. The run detail page similarly resolves its application by fetching the entire inventory. No server-side selection anywhere. | A3 | High | `tab-agent-runs-content.tsx:32-43` (comment concedes it); `workflow-run-detail-page.tsx:58-59,107-108` | ui#3521 (B6) + hub#1112 |
| 7 | No archetype-based trigger. The only path is manual approximation: archetype multiselect filter on the inventory (which matches by `join('')` name-concatenation substring — fuzzy), select-all-filtered, bulk action. Works, but is a snapshot with no memory of the archetype and no association payoff. | A2 | High | grep of archetypes pages; `applications-table.tsx:471-490`; `getLocalFilterDerivedState.ts:72-77` | ui#3520 (B5) + hub#1115 |
| 8 | Bulk post-create feedback is a toast whose "View runs" navigates to the **unfiltered** runs page (`history.push(Paths.workflowRuns)`, no query string) — the user launches 10 runs and lands on an undifferentiated list. | A2/A3 | Medium | `applications-table.tsx:1394-1417` (inline comment concedes it) | ui#3520 (scope: filter pre-applied, no new drawer tabs) |
| 9 | No migration status on the inventory row: applications-table columns are name/businessService/assessment/review/analysis/tags/effort. "Progress surfaced per application" requires opening a drawer per app. | A3 | Medium | `applications-table.tsx:420-428` | ui#3521 area (fast-follow) |
| 10 | Runs list pages have no Application column (Name/Workflow/Phase/Stages/Age/Duration only), so even an unfiltered list can't answer "which app is this run for". | A3 | Medium | `workflow-runs-page.tsx:102-110`; `agent-runs-page.tsx:92-100` | ui#3523 |
| 11 | Bulk fan-out is entirely client-side — one POST per app via `Promise.allSettled`, no server-side atomicity; the code anticipates a future `applicationRefs[]` create endpoint that doesn't exist. Acceptable at preview scale, dishonest at fleet scale. | A2 | Medium | `useStartAgentWorkflowRuns.ts:22-31,57-75` | hub#1112 follow-on |
| 12 | Assessment/review plays **no role** in the agentic flow: run eligibility is repo/branch only (`noRepository`/`branchMatchesSource`/`branchInvalid`); no "recommended workflow via archetype", no assessment gate or badge, despite the decoration seam (inherited-assessment status) being exactly where it would compute. | A5 | Medium | `BulkAgentRunModal.tsx:80-109`; `useDecoratedApplications.ts` / `column-assessment-status.tsx:24-37` | hub#1115 follow-on (no issue filed for gating — deliberate preview cut) |
| 13 | Bulk modal forces one workflow + one shared target branch across the whole selection; per-app overrides don't exist (exclusion list mitigates but doesn't solve). | A2 | Low | `BulkAgentRunModal.tsx:65-66,76-96,237-255` | ui#3520 (note in scope) |

---

## 3. AC#121 decision record (draft — ready to paste)

> ### Decision: stamp `konveyor.io/archetype` on runs at create time (Option A)
>
> **Context.**
> Runs already carry `konveyor.io/application` per merged ADR 0006: the Hub create path mints the token, injects `HUB_BASE_URL`/`APP_ID` env, and "stamps the application id as a label when the request carries one" — env is the pod's input channel, the label is the queryable API index. The archetype question is whether to (A) extend that stamp with `konveyor.io/archetype` when a run is launched from an archetype context, or (B) carry no archetype label and have the Hub resolve archetype→member-app ids at query time, emitting a set-based selector `konveyor.io/application in (…)`.
>
> Two facts about Hub archetype membership drive the decision. First, membership is **computed, never stored**: `MembershipResolver` derives it per request from criteria-tag containment with narrowest-match dominance. Second, it therefore **drifts** — not only when tags or criteria change, but when a *new, more specific* archetype is created and silently steals members from broader ones; live data already shows overlapping membership (one app in two archetypes simultaneously).
>
> The two options answer different questions. B answers "runs whose application is *currently* in archetype X" — under drift, a run launched from archetype X whose app later leaves X vanishes from X's history, and app-first runs appear under archetypes nobody launched them from. A answers "runs *launched for* archetype X" — provenance, stable forever. Every archetype surface in the v0.11.0 tree (B5 bulk landing filter, B7 chips, archetype run history) asks the provenance question.
>
> **Decision.**
> Stamp `konveyor.io/archetype=<hub archetype id>` at create time when — and only when — the run is launched from an archetype context (the bulk action's subject). This is a one-step amendment to ADR 0006's create flow, not a new mechanism. Runs launched app-first carry no archetype label, which is correct: no archetype context existed, and they remain findable via the application filter. The label is single-valued by k8s design, which matches the semantics: it records the one archetype the user acted *from*, not the (multi-valued, drifting) membership set. `?archetype=` in hub#1112 becomes a direct label selector — the same code path as `?application=` (shim reference: `applicationSelector()`, unsupported filter ⇒ 400, never a silent unfiltered pass), reusing the existing uint64 label-value validation verbatim, zero DB work on the list hot path.
>
> **Consequences.**
> - *Recoverability asymmetry is the decisive argument:* B's question stays answerable later from data A carries (resolve members, select `konveyor.io/application in (…)` — the tree's own cut-line fallback is B implemented in the browser). A's fact is **unrecoverable** if not stamped at create; choosing B forecloses A forever, choosing A forecloses nothing.
> - Stage runs surface the label only after PR#113 (parent-label propagation) merges — a dependency the application label already has, so A adds zero new dependencies.
> - We accept that the archetype filter shows launch-time provenance, not current membership; a future "current members' runs" estate view remains buildable on top via B's set-selector, in Hub or client.
> - Rejected (B): couples run-list filter semantics to the narrowest-match membership algorithm, puts a `MembershipResolver` build (preload all archetypes + per-app tag math) on the list hot path, and emits selectors that grow with estate size — to answer a question the UX isn't asking.

---

## 4. Recommended UX flow per area

### Area 1 — Associate workflows with archetypes → **flow 1A: Workflows tab + Manage page (clone target-profiles)**
Add a `Workflows` TabKey to `ArchetypeDetailDrawer` (read view), a "Manage agent workflows" kebab item pushing a dedicated route/page cloned from `target-profiles-page.tsx`, a modal form reusing `BulkAgentRunModal`'s `useFetchWorkflows` FormSelect with Ready-condition gating, and a `workflows` count column mirroring the existing `profiles` count. Persistence: soft string refs on the archetype via the existing whole-archetype PUT (`useUpdateArchetypeMutation`) — no new endpoint shape; the ref is validated against `/agent/workflows` (hub#1112) since AgentWorkflows are cluster CRs with no Hub FK. Effort M.
*Alternatives:* **1B** — `workflowRef` embedded in `TargetProfile` (smallest delta, but conflates generator/analysis concerns with workflows; fallback only if hub#1115 decides the profile IS the transformation unit). **1C** — workflow-side reverse picker (rejected: persistence is Hub-side regardless, so it becomes an N-archetype PUT fan-out with partial-failure semantics the UI has no pattern for; keep as a future read-only "Used by archetypes" list).

### Area 2 — Trigger from inventory (single / bulk / archetype) → **flow 2A: one launch modal, three entry points, filtered landing**
Generalize the existing bulk modal to "launch for N apps": (1) row kebab passes `[app]`, keeping its navigate-to-run-detail on create (a filtered list of one is worse than the detail page; the ui#3520 scope comment binds bulk, not single); (2) bulk toolbar as today; (3) **new** "Run workflow for members" kebab on the archetype row, resolving members client-side (apps already decorate `referencedArchetypeRefs`; Hub also returns `applications[]` per archetype) and opening the same modal with the 1A-associated workflow pre-selected. Same eligibility partition, same client fan-out until `applicationRefs[]` exists. Post-create for bulk/archetype: `history.push(Paths.workflowRuns + serialized filters)` with application (and archetype, post-#121) chips pre-applied — replacing the unfiltered toast. One mental model: a launch is always a batch of size 1..N with a visible exclusion list. Effort M.
*Alternatives:* **2B** — archetype drawer "View applications" deep link into the pre-filtered inventory (ships in a day; good interim, no launch payoff for the association). **2C** — PF6 wizard from the archetype row (best at fleet scale; defer past preview — needs server-side member resolution + fan-out to be honest about atomicity; 2A upgrades into it).

### Area 3 — Progress per application → **flow 3B: filtered workflow-runs page as the fleet backbone**
Add to `workflow-runs-page.tsx`: an Application column (resolve via run labels once stamping lands, APP_ID-env fallback meanwhile) and a `FilterToolbar` with chips for application, workflow, phase, and archetype (archetype chip gated on #121 stamping). Every launch path (2A) and the app-detail affordance (B6: a button to this page with the application chip pre-applied, showing **workflow** runs, not stage runs) routes here via URL filter serialization. Client-side filtering at preview scale; upgrade to hub#1112 server filters without UX change. Effort M. This page is what ui#3520/#3521/#3523 all point at.
*Alternative:* **3A** — inventory "Migration" status column (IconedStatus of latest workflow-run phase, mirroring the analysis column) — right fast-follow, not the backbone.

### Area 4 — Archetype identity on runs → **Option A per the §3 decision record**
Stamp at create (Hub create path already touches the CR — the natural site), filter as a direct label selector, propagate to stage runs via PR#113. UI consumes it only through the 3B archetype chip — no new surface.
*Alternative:* query-time Hub resolution (Option B) — rejected as primary per §3; remains buildable later on top of A for a "current members" estate view.

### Area 5 — Assessment/review integration → **decorate, don't gate (preview)**
Compute at the existing decoration seam (`useDecoratedApplications`, where inherited-from-archetype assessment status already flows): show "recommended workflow (via archetype X)" pre-selection in the launch modal (this is 2A's entry point 3), and consider an informational badge when launching against an unassessed app. Do **not** add assessment/review to run eligibility for the preview — blockers stay repo/branch-only, matching the team's HITL-read-only scope posture. Archetype-level "assess → associate workflow → run on members" becomes a coherent kebab sequence on the archetypes row, where assess/review/discard actions already live.
*Alternative:* hard assessment gate on launch — rejected for preview; punts to a post-preview decision once hub#1115's model exists.

---

## Live smoke evidence (filled by operator)

Run 2026-08-10 on the ROKS demo cluster (post-#100 stack, real Bedrock runs). Estate: 5 real
applications added to the live Hub next to coolstore — kitchensink (jboss-eap-quickstarts@7.4.x),
ticket-monster, daytrader (WASdev/sample.daytrader7), nodejs-rest-http — plus archetypes
**JavaEE Monolith** (criteria: `Java` + `JPA entities` tags) and **Node.js Web** (criteria:
`Node.js` tag). Everything below was observed, with screenshots, in one sitting.

1. **Archetype membership works — and over-matches on day one.** Hub computed JavaEE Monolith =
   {coolstore, kitchensink, ticket-monster, daytrader} exactly as intended. But Node.js Web
   captured **coolstore and Tackle2-Hub too** (language-discovery tags: a Java monolith with JS
   inside is a "Node.js app" by naive criteria). Multi-membership and criteria fuzziness are not
   edge cases; any association/trigger UX must surface *which* archetype a launch acts from
   (supports the §3 provenance decision).
2. **The archetype-triggered launch exists today as filter → select-all → bulk kebab.** The
   inventory's archetypes filter (URL-serialized) narrowed 6 → the 4 members; select-page + "Run
   agent workflow" opened the bulk modal at "4 of 4 applications eligible"; submit fanned out 4
   `AgentWorkflowRun`s, each correctly stamped `konveyor.io/application` (ids 1/3/4/5). The
   mechanics of the Ramon story work; what's missing is everything that makes it *legible*
   (below).
3. **First fan-out: 100% failure in 17 seconds — a contract gap, not a model failure.** All four
   plan stages died with `InvalidParams: required param "repository" not supplied`. The seeded
   agents still carry the ADR-0005 shape (required platform params + `param-sources`
   annotations); only the *single-run* modal implements create-time resolution; the bulk path
   sends `{workflowRef, applicationRef, targetBranch}` and no params. Two conclusions: (a) the
   seed content must move to the runtime-resolution shape (drop required platform params — the
   env chain `HUB_BASE_URL`/`APP_ID` already carries it), per ADR 0009/0013; (b) the bulk modal's
   "eligible" claim is *repo-eligibility only* — it said "4 of 4 eligible" about a launch that
   was 0-for-4 by construction. Eligibility must include a param check against the workflow's
   stage agents, or the modal is lying.
4. **Fleet failure is illegible.** The workflow-runs page showed four Failed rows — identical
   workflow, generated names (`ui-792qk`…), **no application column** — at the exact moment a
   user most needs "which app broke": indistinguishable. The workflow-run detail page *also*
   never names its application. Gap #10/#6 confirmed at the worst possible moment.
5. **No association narrowing, live:** the bulk modal offered `coolstore-quarkus-demo` (a
   single-app demo workflow) as a launch option for daytrader. B3/hub#1115 in one screenshot.
6. **Agent designer round-trip (used in anger to fix the seeds):** saves are faithful
   (image/gateways/params preserved), but the modal *flashes* unhydrated state — image shows
   "Select an image..." and gateways show "No gateways available" for a beat before queries
   land — alarming in a form you're about to Save; the filled parameter rows are invisible to
   the accessibility tree (only the empty add-row is exposed — a11y gap); the Required checkbox
   is a ~12px target with a vertically-wrapped label. Fixed all three agents through it anyway.
7. **Second fan-out: 4/4 Running within seconds on real repos.** Live stage view: ChatPanel
   `Connected`, streaming the agent's actual tool calls (`find . -name "persistence.xml"` →
   real coolstore paths) through gateway→tee. Run detail shows the stage ladder, target-branch
   link, and an honest "branch not pushed yet" note.
8. **Fence #2 violation in the deployed build:** the live run's "Message the agent…" input is
   active — steering is exposed with no flag. ui#3527 (read-only default, flagged steer) is
   confirmed necessary, not theoretical.
9. Minor: freshly created agents render Age "2d" on the agents list (formatAge suspect);
   Hub auto-discovery raced my manual tags (ticket-monster's discovery task errored — red row
   marker — without blocking the run).

10. **Terminal states (all four reached in ~16 min).** coolstore — the one app with a push
    identity — **Succeeded end-to-end and pushed a real branch**: `konveyor/migration-1786370921`
    on ibolton336/coolstore, with commits like "Verify: Build and migration verification
    complete — Quarkus 3.4.1 migration successful", AMQP connector and jakarta-import fixes. An
    inventory-launched, archetype-selected, fully autonomous migration on Bedrock Haiku. The
    other three apps each did their full planning work (~4.5 min of real tool calls, PLAN.md
    written) and then **failed at the stage push**: `authorization failed: Permission to
    jboss-developer/jboss-eap-quickstarts.git denied to ibolton336` — no push identity on those
    apps, and every stage ends in a push by design. Verdict on honesty: the pod-failure path
    reports **Failed**, not false-green (AC#129's refusal gap is a different path). Two new
    gaps this exposes: (a) **failure reasons never reach the UI** — the run shows "Failed ·
    plan" and the push-auth error lives only in pod logs, though it's exactly the kind of
    user-fixable problem (add a credential) the UI should say out loud; (b) **launch
    eligibility must include push credentials** — the Hub knows whether an app carries a
    source-role identity, yet the modal said "4 of 4 eligible" about a batch where 3 were
    guaranteed to fail at push. Eligibility lied twice in one day: once on params (item 3),
    once on credentials.

---

## 6. Sequencing

Order matters because two items are decision-shaped and one is unrecoverable:

1. **AC#121 decision — now, before any preview code.** Zero implementation cost to decide; Option A's provenance data cannot be backfilled. Every run created before stamping lands is permanently invisible to the archetype filter (the shim already documents the same caveat for the application label).
2. **PR#113 (AC#107, stage label inheritance) — merge next.** Load-bearing for the application half already; the archetype label rides the same generic propagation with zero extra work.
3. **hub#1115 (association data model).** Smallest viable shape: soft workflow refs on the archetype (or `TargetProfile`, per the hub#1115 call), persisted via existing archetype PUT, validated against hub#1112's `/agent/workflows`. Unblocks Area 1 UI and 2A's archetype entry point.
4. **hub#1112 run routes + filters (B2).** `?application=` per the shim reference semantics (unsupported filter ⇒ 400), `?archetype=` as the same label-selector path once #121/A lands. Create-path stamping of both labels lives here too.
5. **ui#3523 (filter chips + Application column on runs pages).** Can start **before** #1112 lands using client-side filtering — the URL-serialization contract is the deliverable; swapping the data source later is invisible to users.
6. **ui#3520 + ui#3521.** Bulk landing switches from unfiltered toast-nav to filter-pre-applied route (needs 5); app-detail gets the button to the filtered runs page (workflow runs, not stage runs; no new drawer tabs per scope).
7. **2A archetype entry point** on the archetypes kebab (needs 3 for pre-selection; member resolution is client-side).

**Dev preview can fake:** run-list filtering (client-side over fetch-all — already the drawer's pattern; fine at preview scale), archetype member resolution (client-side from decorated refs / Hub's computed `applications[]`), bulk fan-out (client-side `Promise.allSettled` with partial-failure toast), the inventory Migration column (defer entirely).

**Dev preview must have (cannot fake or defer):** the #121 decision + create-time stamping (data loss if skipped), PR#113 (labels invisible on stage runs otherwise), a minimal hub#1115 association (the epic's first acceptance criterion has no workaround), and URL filter serialization on the workflow-runs page (the landing pattern every scoped issue routes through).