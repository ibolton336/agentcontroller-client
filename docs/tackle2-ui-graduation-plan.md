# Graduating the agentic console into tackle2-ui — course of action

Planning doc, 2026-07-28. Source-verified against all three trees the same
afternoon: the nested clients tree (`agentic-controller/clients`, branch
`clients-reference-stack`, 5 commits ahead of the fork + 14 files of
uncommitted polish), the tackle2-ui port (`~/Development/tackle2-ui`,
branch `feature/agent-runs`, single commit `1666ed2f`, +6,209 lines,
typechecks clean), and this demo repo.

**The one-line thesis:** tackle2-ui `feature/agent-runs` becomes the
product/demo home of the console; agentic-controller PR #35 stays the
canonical home of everything behind the proxy — shim (SHIM API v1 = the
Hub route proposal), gateway RBAC, manifests, seeds, demo scripts — plus
the reference UI that exercises the contract. The two meet at one seam:
`/agentic` → `AGENTIC_SHIM_URL` → shim `/api`.

## Where the port actually stands (verified, corrects earlier notes)

| Piece | On `feature/agent-runs`? |
|---|---|
| Runs list/detail + ACP chat (WS through `/agentic`, `ws: true`) | yes |
| Agents / Skills / Workloads CRUD pages + composer | yes |
| **Image catalog** — `useFetchImagesWithSource`, Designer image dropdown **with custom-image escape** | **yes** (earlier note claiming it was missing is wrong) |
| Workload **runs** (REST/queries/pages/launch modal) | no — contract **types already present** in `api/agentic/contract.ts`, nothing implemented |
| Load defaults (`POST /defaults`) | no |
| Run-detail extras (BranchPanel commit feed, PLAN.md/analysis links, run-spec env/branch panel) | no — detail page is chat + 4 fields |
| Sidebar gating / i18n | no — Agentic group ungated, hardcoded English |
| CI status | **lint FAILS**: 24 warnings vs `--max-warnings=20`; the branch adds exactly 4 (ChatPanel icon imports ×2, Designer set-state-in-effect, unused `LLMProvider` import) |

## Track 1 — agentic-controller PR #35: commit and keep the machinery

Order matters: land these first so Track 2 ports the *fixed* component
versions, not the stale ones.

1. **Commit the 14-file working set** on `clients-reference-stack` as three
   logical commits:
   - *shim hardening*: `safePathname()` (malformed target / bad
     percent-encoding no longer kill the process or the WS bridges),
     `k8sMessage` error bodies, workload models from the **intersection**
     of stage-agent provider lists.
   - *UI polish*: hash deep-links, Designer `imageTouched` + unlisted-ref
     rows, workload-run param **union** + disabled non-universal params,
     stub-application disable, `/HTTP 404\b/` tightening, re-run branch
     gating, workload-run delete affordance, BranchPanel retry,
     `format.ts` URL-normalization order.
   - *ops*: gateway.yaml RBAC widening (llmproviders create, secrets
     create/update, configmaps get/create) + demo-up.sh
     `konveyor-tackle/tackle-hub` defaults.
2. **Stamp `konveyor.io/managed` on the samples-manifest seeds**
   (`analyze-java-ee`, `cloud-readiness-rules`, mock agent's workloads) —
   the extended list filter now hides unlabeled resources from BOTH UIs.
   This was the open thread when the Phase 1 session paused.
3. Push to the fork → PR #35 updated. The PR keeps: shim + write routes +
   `/api/images` + `/api/defaults` (these ARE the Hub R1/R2 route
   proposal), `defaults.ts` seed set, `image-catalog.yaml`, gateway RBAC,
   demo scripts, and the prototype UI as the reference client. Do **not**
   delete the prototype UI yet — it is the only working workload-run and
   BranchPanel implementation until Track 2 reaches parity, and PR #35 is
   by charter the *reference stack*.
4. Follow-up (non-blocking): propose `skills/patternfly-migration/` (this
   repo, committed at `15e3e64`) to upstream #53's `skills/` tree — it is
   authored in exactly that shape. Until then it stays demo-repo-only and
   the seeds reference `quay.io/konveyor/skills:patternfly-migration`.

## Track 2 — tackle2-ui `feature/agent-runs`: reach demo parity

Each item is one commit, in this order:

1. **Unbreak CI first** (minutes): fix the branch's 4 lint warnings —
   named icon imports in ChatPanel, drop the unused `LLMProvider` import,
   restructure the Designer effect setState. Everything after this pushes
   against a green baseline. (CI = prettier, eslint ≤20 warnings, tsc via
   prebuild, jest, lockfile check.)
2. **Workload runs** (biggest demo gap): REST fns + react-query hooks for
   `/agentic/agentworkloadruns`, WorkloadRunsPage (list + delete),
   WorkloadRunDetailPage (stage ladder → links to stage AgentRuns),
   CreateWorkloadRunModal, and a "Run" action on the workloads page.
   Contract types are already on the branch; port the component logic from
   the *post-Track-1* prototype (union param merge, disabled
   non-universal params, stub-app disable, 404 regex).
3. **Load defaults**: one REST fn + mutation; surface as toolbar action +
   empty-state action on the Agents and Workloads pages ("populate this
   cluster with the reference migration set"). Empty catalog screens are
   the first thing a demo audience sees — this is the fix.
4. **Run-detail parity**: run-spec panel (application id, target branch,
   model, token-hidden env) + BranchPanel (branch link, commit feed with
   its retry fix, PLAN.md / `.konveyor/analysis.json` presence checks).
   This is what makes the workload demo legible — stages visibly chain
   through commits on one branch.
5. **Upstream-readiness pass** (before opening the konveyor PR, not
   before demoing): gate the Agentic sidebar group + routes behind a
   ClientEnv boolean following the existing `isRWXSupported` pattern
   (there is no feature-flag framework; ad-hoc env booleans are the
   house style), and wrap the hardcoded strings in `t()`. Tests: CI only
   requires the existing suites to pass; add Cypress e2e coverage later
   as upstream review demands rather than pre-empting it.

## The demo (the acceptance run, relocated)

- Bring-up: `hack/demo-up.sh` (cluster + shim + prototype UI), then
  tackle2-ui dev via the `tackle2-ui-dev` launch entry —
  `AGENTIC_SHIM_URL=http://127.0.0.1:7080` (the default) with the dev
  server on :9000 fronting the no-auth Hub. Shim on :7080 must postdate
  the crash fixes (restart any process started before them).
- Script: tackle2-ui → Agentic group → **Load defaults** → Skills/Agents
  show the seeded set → Agent Designer (catalog dropdown) → Workloads →
  launch `java-ee-to-quarkus` against the real `coolstore` app (Hub #1,
  live inventory) → watch stage ladder + branch commits.
- Runnability caveat (unchanged): actually *executing* the seeded
  workloads needs the #53 images (`agent-java`/`agent-nodejs` +
  `skills:*`) plus ImageVolume support (containerd/kind — this minikube's
  cri-dockerd cannot mount SkillCards; the local fallback is the
  baked-skill image pattern in `skills/README.md` and the goose-bedrock
  path). Until then the mock agent covers the create-flow beat and the
  RHDH workload covers the real-run beat.

## Housekeeping

- Commit `skills/README.md` (untracked) in this repo; add `.DS_Store` and
  `.~lock.*#` to `slides/.gitignore` (both currently untracked junk; the
  deck may be open in LibreOffice).
- The `docs/issue-22-*.md` set, `pr35-next-level-plan.md`, `slides/`, and
  `launch.json` are demo-repo-only — nothing to move.

## Sequencing

```
1. Track 1 commits + push (fork/clients-reference-stack → PR #35)
2. tackle2-ui lint fix                      ── unblocks every later push
3. Workload runs → Load defaults → Run-detail parity   (demo-ready here)
4. Demo rehearsal on :9000 against the live shim
5. Gate + i18n pass → open konveyor/tackle2-ui PR (links #3504)
6. Upstream follow-ups: PF skill → #53 skills/, AGENTIC_SHIM_URL operator wiring
```
