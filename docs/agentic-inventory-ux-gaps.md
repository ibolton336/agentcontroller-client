# Agentic migrations from the application inventory — UX gap analysis

**Status:** recon complete, pre-implementation · **Date:** 2026-08-10 · **Scope:** konveyor epic "agentic migrations built around the application inventory" (dev preview / v0.11.0)

**Evidence base:** tackle2-ui `feature/agent-runs` branch, tackle2-hub v23 model + live no-auth Hub, agentcontroller-client hub-shim (reference implementation), konveyor/agentic-controller#121, `docs/v0.11.0-issue-tree.md`.

---

## Action items — UX × eng tag team (added 2026-08-12)

Consolidates §2/§4/§6, the live-smoke findings, and the 2026-08-11 prototype-call agreements into one working list. Call agreements this list assumes: **phase 1 = single-application runs** (bulk-by-archetype arrives in a later phase), runs pages answer "status per application" with Issues-page-style filter chips, knowledge base = git links (repo/branch/commit), and analysis stays a prerequisite the UI must convey.

### Already built — review it, don't re-mock it

Running today on `feature/agent-runs` (deployed on the ROKS demo build): single-app and bulk launch through one modal with an eligibility/exclusion split; both runs pages with an Application column and Name/Application/Phase chips, URL-persisted so deep links work; a per-application runs tab in the app drawer; run detail with the stage ladder and live agent chat. This closes the client half of gaps #3/#10 — the server half swaps in under the same URLs via [hub#1112](https://github.com/konveyor/tackle2-hub/issues/1112) with no UX change. Fastest next step for design: react to the running UI, not re-mock it.

### Decisions to close first (eng chases — cheap now, expensive later)

- [ ] **Resolve [AC#121](https://github.com/konveyor/agentic-controller/issues/121) — ratify or close.** The Option A proposal (stamp provenance at create) is posted, and its unrecoverability argument holds *if* archetype-context launches exist. But with the association cut (previous item) and the archetype demoted to a selection filter, "application-only for the preview" plausibly resolves the issue instead — which would also thin the runs chips and hub filter surface to application-only. Confirm with Ramon, then either ratify the stamp or close; either ends the limbo (§3, §6-1).
- [x] **[hub#1115](https://github.com/konveyor/tackle2-hub/issues/1115) CLOSED (not planned) 2026-08-12 — no stored association ships in the preview.** Two anchors fell in one day. The archetype anchor: membership is computed and drifts (§3), live data showed accidental multi-membership on day one (Live smoke #1), the asset-generation precedent declines to auto-resolve multi-archetype apps, and per-archetype operations have no product precedent (Jeff's own doubt, 2026-08-10 call). Then the app anchor with it, because nothing in scope consumes a stored ref: single-app launches pick the workflow in the modal, bulk batches come from a filtered selection that already carries the intent, and status-per-application reads run history via the application label. A stored ref earns its keep only when intent must outlive the selection session (heterogeneous fleet launches, planned-vs-started reporting, assign-now-launch-later) — all post-preview, and unlike the #121 provenance label it is backfillable config, so deciding late loses nothing. If a consumer appears, the ref goes on the **Application**, never the archetype. Bonus: the multi-archetype questions queued for Ramon dissolve — the user picks at launch. Closing comment invites Jeff to reopen if Hub-side sees a consumer.
- [ ] **Land parent-label inheritance for stage runs** — [PR#113](https://github.com/konveyor/agentic-controller/pull/113) is open and load-bearing for all label-based filtering; chase review.

### UX — design (priority order)

- [ ] **Honest launch preflight.** The modal said "4 of 4 eligible" about a batch that was 0-for-4 on missing params, and separately 3-of-4 doomed at push for lack of credentials (Live smoke #3, #10). Design the per-app preflight: repo / branch / params / push-credential states, and which failures block vs. warn.
- [ ] **Failure reasons on runs.** Today a dead run says "Failed · plan" and the actual, user-fixable cause ("push denied — no credential for this repo") lives only in pod logs (Live smoke #10a). Decide where the human-readable reason surfaces: runs list, run detail, or both.
- [ ] **"Analysis is a prerequisite" messaging.** Workflows cannot run analysis (too slow in-pod, per the call). Design how launch surfaces "this app needs analysis first," alongside admin-predefined archetypes/targets.
- [ ] **Inventory "Migration status" column.** The agreed fast-follow surface (§4 Area 3 alternative): design the column states now so eng can build it when the backbone settles.
- [ ] **Prototype iteration owed from the call:** stage "description" → expected-agent-behavior wording; knowledge-base tab as git links; skills file-import plus a source column (organization / Red Hat / user).
- [ ] **Agent-designer polish** (found using it in anger, Live smoke #6): unhydrated flash on open ("Select an image…" / "No gateways available" before queries land), filled param rows invisible to the accessibility tree, ~12px Required checkbox target.

### Eng — build (phase-1 code)

- [ ] **Wire the real preflight checks** behind the UX design above: params validated against the workflow's stage agents, push credential present on the app. The Hub already knows both facts; the modal just never asks.
- [ ] **Plumb failure reasons** from the stage pod into run status so the UI has something to render — no issue exists yet; file it.
- [ ] **App detail: button to the pre-filtered runs page**, replacing the drawer tab per the scope comment on [ui#3521](https://github.com/konveyor/tackle2-ui/issues/3521) — unblocked now that the filter mechanism exists.
- [ ] **Bulk landing pre-filtered.** Replace the unfiltered "View runs" toast-nav with a route carrying the application chips ([ui#3520](https://github.com/konveyor/tackle2-ui/issues/3520)); add the workflow chip while in there.
- [ ] **Steer behind a default-off flag.** The deployed build exposes the "Message the agent…" input (Live smoke #8); [ui#3527](https://github.com/konveyor/tackle2-ui/issues/3527) is confirmed necessary.
- [ ] **Finish the review pass owed on [hub#1112](https://github.com/konveyor/tackle2-hub/issues/1112)** so server-side `?application=`/`?archetype=` filters can land under the URLs the UI already emits.

### Do together

- [ ] **Walk the live branch** (30 min, ROKS build): map each prototype screen to what exists; agree what the prototype should adopt vs. redesign.
- [ ] **Confirm the landing pattern** as canonical in both prototype and code: every launch path ends on the runs page pre-filtered to what you just launched.
- [ ] **Timebox phase-2 sketches** — what survives the association cut is the "run workflow for members" selection entry (§4 flow 2A entry 3 / 2B); per-app target branch in bulk stays parked for David's configure object.

---

## 1. Verdict

The inventory-side plumbing is roughly half built and the archetype side is not started: single-app and bulk triggering from the inventory exist end-to-end (row kebab + bulk toolbar → `BulkAgentRunModal` → client-side fan-out, one POST per app), and per-app progress exists in the detail drawer — but **every archetype-facing acceptance criterion has zero implementation** (no association data model, no archetype trigger, no archetype identity on runs, no archetype filter), the runs pages have **no filters, no URL-param mechanism, and no application column**, so the already-scope-locked landing pattern ("route to runs page with filter pre-applied", B5/B6) has nothing to route to, and all application↔run joins are done by fetching *everything* and matching `spec.env` `APP_ID` client-side. The good news: the hard parts have existing patterns to clone (target-profiles for association, ADR 0006 label stamping + the shim's `?application=` filter for identity, `useLocalTableControls` URL filters for chips), so the gaps are well-shaped issues rather than open research — except AC#121, which is a genuine decision that must be made **before** the preview because one of its options is unrecoverable if skipped.

---

## 2. Gap table

Ordered blockers first. Area key: **A1** archetype↔workflow association · **A2** trigger from inventory · **A3** progress per application · **A4** archetype identity on runs · **A5** assessment/review integration.

| # | Gap | Area | Severity | Evidence | Owning issue |
|---|-----|------|----------|----------|--------------|
| 1 | No archetype↔workflow association exists anywhere — no data model, no UI. Hub `TargetProfile` carries generators + analysisProfile but no workflow ref; grep of `client/src/app/pages/archetypes` for `workflow\|agentic` returns zero matches. | A1 | **Blocker** | hub `internal/migration/v23/model/application.go:201-215`; grep of archetypes pages → no output | ~~hub#1115~~ (B3) — closed 2026-08-12, association cut from preview scope (Area 1) |
| 2 | Runs carry no archetype identity and the stamping-vs-query-time decision is unmade; the archetype half of run-list filtering is explicitly deferred "pending a decision on how runs carry archetype identity". Zero archetype support in the shim reference implementation. | A4 | **Blocker** | AC#121 (open, zero comments, milestoned v0.11.0); hub#1112 acceptance comment; `grep -rni archetype packages/ --include='*.ts'` → no matches | **AC#121** |
| 3 | Runs pages have no filter toolbar, read no URL query params, and persist no filter state — the B5/B6 scope decision ("route to runs page with filter pre-applied") has **no mechanism today**. | A3 | **Blocker** | `workflow-runs-page.tsx:102-137` (Create button only); grep for `useUrlParams/search` in workflow-runs → no output | **ui#3523** (B7), enables ui#3520/#3521 |
| 4 | Hub has no run-list query filters: hub#1112's body specifies routes but no `?application=`/`?archetype=`; the only implementation of filtering is the shim. UI REST layer matches — `getWorkflowRuns()`/`getAgentRuns()` take zero arguments, so no server-side selector is expressible. | A3/A4 | High | hub#1112 body + acceptance comment #2; `client/src/app/api/rest/agent-runs.ts` | **hub#1112** (B2 folded in) |
| 5 | Stage AgentRuns don't inherit parent labels (controller builds a fixed 3-key label map), so application — and archetype, once stamped — is invisible on stage runs. Load-bearing for the whole filtering story. | A4/A3 | High | AC#107; shim comment `server.ts:1179-1182` | **AC#107**, fix **PR#113** open |
| 6 | Per-app progress is drawer-only and unscalable: `TabAgentRunsContent` fetches ALL workflow runs + ALL agent runs and filters client-side by `spec.env` APP_ID. The run detail page similarly resolves its application by fetching the entire inventory. No server-side selection anywhere. | A3 | High | `tab-agent-runs-content.tsx:32-43` (comment concedes it); `workflow-run-detail-page.tsx:58-59,107-108` | ui#3521 (B6) + hub#1112 |
| 7 | No archetype-based trigger. The only path is manual approximation: archetype multiselect filter on the inventory (which matches by `join('')` name-concatenation substring — fuzzy), select-all-filtered, bulk action. Works, but is a snapshot with no memory of the archetype and no association payoff. | A2 | High | grep of archetypes pages; `applications-table.tsx:471-490`; `getLocalFilterDerivedState.ts:72-77` | ui#3520 (B5); ~~hub#1115~~ closed — no association in preview |
| 8 | Bulk post-create feedback is a toast whose "View runs" navigates to the **unfiltered** runs page (`history.push(Paths.workflowRuns)`, no query string) — the user launches 10 runs and lands on an undifferentiated list. | A2/A3 | Medium | `applications-table.tsx:1394-1417` (inline comment concedes it) | ui#3520 (scope: filter pre-applied, no new drawer tabs) |
| 9 | No migration status on the inventory row: applications-table columns are name/businessService/assessment/review/analysis/tags/effort. "Progress surfaced per application" requires opening a drawer per app. | A3 | Medium | `applications-table.tsx:420-428` | ui#3521 area (fast-follow) |
| 10 | Runs list pages have no Application column (Name/Workflow/Phase/Stages/Age/Duration only), so even an unfiltered list can't answer "which app is this run for". | A3 | Medium | `workflow-runs-page.tsx:102-110`; `agent-runs-page.tsx:92-100` | ui#3523 |
| 11 | Bulk fan-out is entirely client-side — one POST per app via `Promise.allSettled`, no server-side atomicity; the code anticipates a future `applicationRefs[]` create endpoint that doesn't exist. Acceptable at preview scale, dishonest at fleet scale. | A2 | Medium | `useStartAgentWorkflowRuns.ts:22-31,57-75` | hub#1112 follow-on |
| 12 | Assessment/review plays **no role** in the agentic flow: run eligibility is repo/branch only (`noRepository`/`branchMatchesSource`/`branchInvalid`); no "recommended workflow via archetype", no assessment gate or badge, despite the decoration seam (inherited-assessment status) being exactly where it would compute. | A5 | Medium | `BulkAgentRunModal.tsx:80-109`; `useDecoratedApplications.ts` / `column-assessment-status.tsx:24-37` | post-preview decision (was a hub#1115 follow-on; #1115 closed 2026-08-12) |
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

### Area 1 — Workflow↔app association → **none ships in the preview** *(decided 2026-08-12; hub#1115 closed)*
No stored association, on either anchor. Every scoped consumer resolves at launch time: the modal picks the workflow (single or bulk); bulk batches come from a filtered — typically archetype-filtered — selection whose narrowing already carries the workflow intent; and status-per-application is run *history* read through the `konveyor.io/application` label (Area 3), not stored intent. A stored ref earns its keep only when intent must outlive the selection session — heterogeneous fleet launches ("each app runs its own workflow"), planned-vs-started reporting, assign-now-launch-later delegation — and if one of those materializes post-preview, the ref belongs on the **Application** (single-valued soft name-ref, app PUT, fail-at-run: the 2026-08-10 mechanics), never the archetype, whose membership is computed, drifting, and overlapping (Live smoke #1; asset-gen precedent declines to auto-resolve multi-archetype apps). Unlike the #121 provenance label, an assignment ref is backfillable config — deferring costs nothing.
*Superseded flows (record only; full text in git history):* **1D** — app-anchored `workflowRef` + inventory bulk-assign (remains the recorded future shape if a consumer appears). **1A/1B/1C** — archetype-anchored variants (Workflows tab + manage page / `TargetProfile` embed / workflow-side picker); these fall regardless of scope: they bind an operational choice to computed, drifting, overlapping membership.

### Area 2 — Trigger from inventory (single / bulk / archetype) → **flow 2A: one launch modal, three entry points, filtered landing**
Generalize the existing bulk modal to "launch for N apps": (1) row kebab passes `[app]`, keeping its navigate-to-run-detail on create (a filtered list of one is worse than the detail page; the ui#3520 scope comment binds bulk, not single); (2) bulk toolbar as today; (3) **new** "Run workflow for members" kebab on the archetype row, resolving members client-side (apps already decorate `referencedArchetypeRefs`; Hub also returns `applications[]` per archetype) and opening the same modal with the user picking the workflow as in any bulk launch (no stored association — Area 1). Same eligibility partition, same client fan-out until `applicationRefs[]` exists. Post-create for bulk/archetype: `history.push(Paths.workflowRuns + serialized filters)` with application (and archetype, post-#121) chips pre-applied — replacing the unfiltered toast. One mental model: a launch is always a batch of size 1..N with a visible exclusion list. Effort M.
*Alternatives:* **2B** — archetype drawer "View applications" deep link into the pre-filtered inventory (ships in a day; good interim, no launch payoff for the association). **2C** — PF6 wizard from the archetype row (best at fleet scale; defer past preview — needs server-side member resolution + fan-out to be honest about atomicity; 2A upgrades into it).

### Area 3 — Progress per application → **flow 3B: filtered workflow-runs page as the fleet backbone**
Add to `workflow-runs-page.tsx`: an Application column (resolve via run labels once stamping lands, APP_ID-env fallback meanwhile) and a `FilterToolbar` with chips for application, workflow, phase, and archetype (archetype chip gated on #121 stamping). Every launch path (2A) and the app-detail affordance (B6: a button to this page with the application chip pre-applied, showing **workflow** runs, not stage runs) routes here via URL filter serialization. Client-side filtering at preview scale; upgrade to hub#1112 server filters without UX change. Effort M. This page is what ui#3520/#3521/#3523 all point at.
*Alternative:* **3A** — inventory "Migration" status column (IconedStatus of latest workflow-run phase, mirroring the analysis column) — right fast-follow, not the backbone.

### Area 4 — Archetype identity on runs → **Option A per the §3 decision record**
Stamp at create (Hub create path already touches the CR — the natural site), filter as a direct label selector, propagate to stage runs via PR#113. UI consumes it only through the 3B archetype chip — no new surface.
*Alternative:* query-time Hub resolution (Option B) — rejected as primary per §3; remains buildable later on top of A for a "current members" estate view.

### Area 5 — Assessment/review integration → **decorate, don't gate (preview)**
Compute at the existing decoration seam (`useDecoratedApplications`, where inherited-from-archetype assessment status already flows): an informational badge when launching against an unassessed app. (The earlier "recommended workflow via archetype" pre-selection died with the association — no stored ref, no recommendation source.) Do **not** add assessment/review to run eligibility for the preview — blockers stay repo/branch-only, matching the team's HITL-read-only scope posture. Archetype-level "assess → run on members" stays a coherent kebab sequence on the archetypes row, where assess/review/discard actions already live.
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
3. **hub#1115 — closed 2026-08-12: no stored association in the preview** (Area 1). Launch-time selection + run labels cover the scoped flows; the app-anchored ref is the recorded future shape if a post-preview consumer appears.
4. **hub#1112 run routes + filters (B2).** `?application=` per the shim reference semantics (unsupported filter ⇒ 400), `?archetype=` as the same label-selector path once #121/A lands. Create-path stamping of both labels lives here too.
5. **ui#3523 (filter chips + Application column on runs pages).** Can start **before** #1112 lands using client-side filtering — the URL-serialization contract is the deliverable; swapping the data source later is invisible to users.
6. **ui#3520 + ui#3521.** Bulk landing switches from unfiltered toast-nav to filter-pre-applied route (needs 5); app-detail gets the button to the filtered runs page (workflow runs, not stage runs; no new drawer tabs per scope).
7. **2A archetype entry point** on the archetypes kebab (member resolution is client-side; the user picks the workflow in the modal — the association dependency is gone).

**Dev preview can fake:** run-list filtering (client-side over fetch-all — already the drawer's pattern; fine at preview scale), archetype member resolution (client-side from decorated refs / Hub's computed `applications[]`), bulk fan-out (client-side `Promise.allSettled` with partial-failure toast), the inventory Migration column (defer entirely).

**Dev preview must have (cannot fake or defer):** the #121 decision + create-time stamping (data loss if skipped), PR#113 (labels invisible on stage runs otherwise), and URL filter serialization on the workflow-runs page (the landing pattern every scoped issue routes through). *(Correction 2026-08-12: a minimal hub#1115 association was listed here as unworkaroundable — wrong; launch-time selection is the workaround, and the issue is closed.)*