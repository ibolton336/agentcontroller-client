# Skills — UX gap analysis (author → attach → run)

**Status:** recon complete, pre-implementation · **Date:** 2026-08-21 · **Scope:** creating a skill and using it in an AgentRun, as a user of the console sees it

**Evidence base:** tackle2-ui `feature/agent-runs` @ 7ce9cf137 ([ui#3546](https://github.com/konveyor/tackle2-ui/pull/3546)) — `pages/skills/*`, `AgentDesignerModal`, `CreateRunModal`, `ChatPanel`, `api/agentic/contract.ts`; tackle2-hub [#1119](https://github.com/konveyor/tackle2-hub/pull/1119) @ 26ec8a0 (`/agentic/skills`, `/agentic/skillcollections`); agentic-controller `main` @ a7dfc73 (SkillCard/SkillCollection CRDs, `skillcard_controller.go`, `agentrun_controller.go`, harness `main.go`/`prompt.go`, ADR 0010/0014/0015) and [PR #157](https://github.com/konveyor/agentic-controller/pull/157) @ efc511f5 (skill packaging + loader, djzager-approved 08-20, unmerged); `hack/mock-inventory-stack.mjs`; `docs/UPSTREAM-FEEDBACK.md` items 4–5; the 2026-08-11 UX prototype call notes. No cluster was touched.

---

## Implementation status — 2026-08-21 (same day)

Phase 1 and the UI-only half of phase 2 are **built and browser-verified** on tackle2-ui `feature/agent-runs` (uncommitted on top of 7ce9cf137) plus the mock rig in this repo (`hack/mock-inventory-stack.mjs`, uncommitted). `tsc`, `eslint`, `prettier` clean; the change went through a three-lens review with adversarial verification (12 findings → 9 confirmed → all fixed, incl. a keyboard trap on clickable rows and a YAML `key: value` plain-scalar case the client validator accepted but `yaml.v3` would not).

| Gap | Status | Where |
| --- | --- | --- |
| A1 inline/git authoring | **Done** — Source toggle Inline · Image · Git; inline `SKILL.md` editor with template insertion and live Agent-Skills validation (errors block, warnings don't); edit preselects the existing kind and switching shows an info alert instead of silently converting | `SkillCardModal.tsx`, `SkillCardMarkdownEditor.tsx`, `utils/skills.ts` |
| A2 `subPath` / `ref` | **Done** — on image and git cards and on collection entries; unpinned git ref shows a reproducibility warning | same + `SkillCollectionModal.tsx` |
| A3 content / description visibility | **Done** — Description column; detail drawer with Details / Status (delivery mode, conditions in full) / Content (parsed frontmatter + markdown) / Referenced-by (agents, collections) | `skills-page.tsx`, `SkillCardDetailDrawer.tsx`, `SkillCollectionDetailDrawer.tsx` |
| A4 face-value Ready | **Mitigated** — Ready label tooltip shows reason + message; image cards carry "Reference accepted… pulled when a run starts"; client-side frontmatter validation catches the inline cases before the controller does | `ReadyLabel.tsx`, `SkillLabels.tsx` |
| A5 collections | **Done** — Group-existing (card picker auto-fills names; Image/Git members with subPath/ref/type) vs Enumerate-an-image modes; drawer lists `resolvedSkills` and links the cards that exist | `SkillCollectionModal.tsx`, `SkillCollectionMemberCardSelect.tsx` |
| A6 import / doc-to-skill | Not built (phase 3; [#158](https://github.com/konveyor/agentic-controller/issues/158)) | — |
| B1–B3 designer | **Done** — type/Ready/description per row; danger alert replaced by "N rules always loaded · M on-demand skills · K collections" + guidance; agents table shows a plain count | `AgentDesignerModal.tsx`, `agents-page.tsx` |
| C1 launch visibility | **Done** (read-only) — "Skills this agent brings" block; per-run selection still needs the API | `CreateRunModal.tsx`, `RunSkillsSummary.tsx` |
| C2 run detail | **Done** (client-side join) — Skills group on the run's DescriptionList; the ground-truth `status.skills` stays an upstream ask (Draft 2) | `agent-run-detail-page.tsx` |
| C3 transcript | **Done** — `load_skill` tool calls render as "Loaded skill X" / "Loaded file from skill X" with a book icon; every other tool call unchanged | `ChatPanel.tsx` |
| C4 skill-load failures on the run | Upstream (Draft 1 below) | — |
| D1 `rule` no-op on main | Copy now says "injected into every prompt" without promising enforcement; the upgrade hazard stays an upstream release-note item | i18n |
| E1/E2 rig + contract | **Done** — real-shape fixtures (image+subPath, inline, git, broken inline, legacy, enumerated collection), 422 parity for exactly-one-source / image-xor-skills / duplicate tags, scripted run `skills-run-coolstore` emitting `load_skill`; `contract.ts` on the #157 shape | `hack/mock-inventory-stack.mjs`, `contract.ts` |

**Browser evidence (mock hub :18090 + dev server :9000):** inline rule created through the modal → `POST /agentic/skills` body `{displayName, description, type:"rule", inline}` only; invalid frontmatter (uppercase name, missing description, unknown field `owner`, `Use when:` plain scalar) blocks Create with the right messages; enumerate collection → `{"image":…, "type":"rule"}`; explicit collection → `[{name:"plan",skillCardRef:"plan"},{name:"verify",image,subPath,type}]`; designer summary flips to "2 rules always loaded · 0 on-demand skills · 1 collections"; run detail shows the Skills group and the transcript shows both `load_skill` rows over a live ACP websocket.

One thing checked and ruled out: with a wide table and the 500 px drawer open, the page-drawer's hidden-overflow container can be scrolled horizontally by `scrollIntoView`/focus — identical on the application inventory page, i.e. pre-existing PF behaviour, not a regression.

---

## 1. Verdict

1. **The console has a skills surface, but it is a CRUD form over the POC CRD.** It can author exactly one kind of SkillCard — an OCI image reference — which is the one path a user cannot finish from a browser (write `SKILL.md`, build an image, push it to a registry the cluster pulls from, on a runtime that supports ImageVolumes). The two paths that need no registry (inline markdown, git URL) cannot be created, and editing a card that has one silently converts it to an image card.
2. **Nothing shows what a skill *is* or whether it was *used*.** No content view, no description column, no "skills in this run" panel at launch or in run detail; a `load_skill` call renders as a generic tool call; rules (always-loaded) are invisible; skill-load failures never reach the AgentRun status, so the UI has nothing to render.
3. **Two signals the UI does show are hollow today.** SkillCard `Ready` is the image ref copied into status ("accepted at face value" per the controller comment) — it proves nothing pulls. And `type: rule` has **no effect on any harness built from `main`** today: `KONVEYOR_RULES` was never wired, and #157's own changelog says "A SkillCard with type: rule has had no effect until now." The Rule/Skill toggle in the modal is a promise the cluster does not keep yet — and on upgrade to #157, every card already typed `rule` starts changing prompts without being edited.
4. **#157 changes the shape the UI was built against.** `subPath` (required to use the shipped bundle `quay.io/konveyor/skills:latest` at all), `ref`, `status.deliveryMode`, `SkillCollection.spec.image` (enumerate an image into generated cards), per-entry `type`, `status.resolvedSkills`. The UI contract has none of these; a user on a post-#157 cluster cannot reference the default skills from the console without hand-editing YAML.
5. **Upstream already knows most of the authoring gap** ([#153](https://github.com/konveyor/agentic-controller/issues/153) authoring surface, [#158](https://github.com/konveyor/agentic-controller/issues/158) doc-to-skill, [#81](https://github.com/konveyor/agentic-controller/issues/81) docs, [#154](https://github.com/konveyor/agentic-controller/issues/154) private sources). What nobody has filed is the **run-side** half: per-run visibility of mounted/loaded skills and a skill-load failure condition on AgentRun. That is where the console team can lead.

## 2. The journey as it stands

What a console user has to do to get a skill of their own in front of a model, and what the product offers at each step.

| Step | Where it happens | What the console offers | What actually happens / breaks |
| --- | --- | --- | --- |
| 1. Write `SKILL.md` with AgentSkills.io frontmatter (`name`, `description`) | Editor, outside the product | Nothing — no template, no validator, no hint that frontmatter is load-bearing (ADR 0014: a skill without it is invisible to goose) | Frontmatter `description` is the model's entire selection surface; nothing in the product says to write it for retrieval |
| 2. Package it | Shell: `skillctl build/push` (main) or `podman build` from a `Containerfile` (#157); push to a registry the cluster can pull | Nothing; empty state says "No SkillCard resources found. Create one to get started." | Needs registry creds + an ImageVolume-capable runtime (containerd ≥ 2.0 / CRI-O + gate). On docker-runtime clusters the pod sticks in `CreateContainerError` while the run reads `Running` forever (UPSTREAM-FEEDBACK §4) |
| 3. Create the SkillCard | Skills page → *Create skill card* | Name, display name, description, Type (Skill/Rule), **Image (required)**, version, tags | No inline, no git, no `subPath`/`ref`. `Ready` flips True immediately (ref copied, not pulled). Under #157 a card on the bundle image without `subPath` fails at pod init ("resolves to more than one skill") — the form cannot express the fix |
| 4. (Optional) group into a SkillCollection | Skills page → *Create skill collection* | Rows of free-text *name* + kind (SkillCard / Direct image) + free-text value, reorder arrows | SkillCard names typed by hand, no picker, no existence check. No `source`/`ref`/`subPath`/`type` per entry; #157's `spec.image` enumeration (the thing that removes hand-typed `subPath`s) not reachable |
| 5. Attach to an Agent | Agents page → designer | Checkbox per card (display name + Ready + resolved image), checkbox per collection (name only) | No description, no type, no cost hint (rules are always in context). Zero skills → red `0` in the table and a **danger** alert "An agent without skills has no tools to work with" — false since #83 made skills optional, and wrong in kind (skills are knowledge, not tools) |
| 6. Launch a run | *Create run* modal / inventory launch | Agent, gateway, params | Skills not shown. No per-run selection — `AgentRunSpec` has no skills field (UPSTREAM-FEEDBACK §5); every run mounts everything its Agent lists |
| 7. Watch it run | Run detail + chat | Phase label, agentRef, ACP transcript | No "skills in this run" panel. A `load_skill` call is a generic tool row titled whatever goose sends. Rules are injected server-side (post-#157) and never appear. ADR 0014 measured the model **not** calling `load_skill` unless the stage instructions name the skill — the user cannot tell "ignored" from "used" |
| 8. When it fails | Run detail | `Failed` (or `Running`, indefinitely) | Missing SkillCard → `SandboxCreationFailed` condition message, which run detail does not display (already tracked as "failure reasons on runs"). Bad `subPath` / missing frontmatter / duplicate skill name (#157 loader) → pod `Failed`, reason only in the init container's termination message. Unsupported ImageVolume or a hung git clone → `Running` forever. No AgentRun condition exists for any skill-load outcome |

## 3. Gap table

Severity: **P1** blocks the happy path for a console user · **P2** misleads or hides state · **P3** polish / rig.

### Authoring

| # | Gap | Evidence | Sev |
| --- | --- | --- | --- |
| A1 | Only image-sourced cards can be created; inline and git cannot; editing an inline/git card converts it to image (a warning, but still destructive) | `SkillCardModal.tsx` `canSubmit` requires `image`; `isConvertingSource` alert | P1 |
| A2 | No `subPath` / `ref` → cannot reference one skill out of a multi-skill image (the shipped default after #157) or pin a git source | `contract.ts` `SkillCardSpec`; #157 `skillcard_types.go` | P1 (post-#157) |
| A3 | No way to see a skill's content or even its description: table columns are Name/Display name/Type/Source/Ready/Tags/Age; no detail view; inline body never rendered | `skills-page.tsx` | P2 |
| A4 | Zero validation before a run: `Ready` is face-value; no frontmatter check client-side; the first signal a card is wrong is a failed pod | `skillcard_controller.go` `reconcileImage` comment; #157 validates inline only at reconcile | P2 |
| A5 | Collections: SkillCard refs typed as free text, no picker or existence check; no per-entry `type`/`source`/`subPath`; no `spec.image` enumeration; `status.resolvedSkills` not shown | `SkillCollectionModal.tsx`; #157 `skillcollection_types.go` | P2 |
| A6 | No import path at all — no file upload, no doc-to-skill, no "paste SKILL.md"; the designer asked for file import + a source column (organization / Red Hat / user) on 08-11 | prototype call notes; [#158](https://github.com/konveyor/agentic-controller/issues/158) | P2 |
| A7 | Out-of-band toolchain is invisible: nothing tells the user they need to build/push an image, what runtime the cluster needs, or that the hub seeds defaults (one generic hint string) | i18n `agentic.skills.*`, `emptyStateSeedHint` | P3 |

### Attaching to an Agent

| # | Gap | Evidence | Sev |
| --- | --- | --- | --- |
| B1 | Designer shows no description, no type, no indication which selections are always-loaded (context cost) vs on-demand | `AgentDesignerModal.tsx` 309–380 | P2 |
| B2 | "No skills" is a **danger** alert + red `0`; copy says skills are tools. Contradicts #83 (optional) and ADR 0014 (knowledge, progressively disclosed) | `AgentDesignerModal.tsx` 382–390; `agents-page.tsx` 145; i18n `agents.noSkillsSelected*` | P2 |
| B3 | Nothing tells an author that a stage must *name* the skill it depends on in its instructions, or type it `rule`, for it to be read (ADR 0014 measurement) | ADR 0014 "Anything that must run is a rule" | P2 |

### Using in a run

| # | Gap | Evidence | Sev |
| --- | --- | --- | --- |
| C1 | Launch shows no skills; no per-run selection (API has none) | `CreateRunModal.tsx` has no skill reference; `agentrun_types.go` | P2 (UI) / upstream decision (API) |
| C2 | Run detail has no "skills in this run" (what was mounted, type, delivery mode, source) | `agent-run-detail-page.tsx` shows `agentRef` only | P1 for trust — users cannot see what knowledge the run had |
| C3 | Skill activations are indistinguishable from other tool calls; injected rules never appear | `ChatPanel.tsx` `tool_call` → generic `Message` | P2 |
| C4 | Skill-load failures do not reach AgentRun status: no condition, reason only in pod termination message / kubelet events; unsupported runtime or hung clone reads `Running` forever | #157 `agentrun_controller.go` reason list (no skill/loader reason); UPSTREAM-FEEDBACK §4 | P1 |
| C5 | No feedback loop: whether the model read a skill is knowable only by scanning the transcript; nothing aggregates "skills loaded" per run or per skill | ADR 0014 alternatives ("visible in the ACP stream… as it happens") | P2 |

### Semantics and trust

| # | Gap | Evidence | Sev |
| --- | --- | --- | --- |
| D1 | `type: rule` is a no-op on today's `main` harness; #157 turns it on and existing `rule` cards change agent behaviour on upgrade. The UI offers the toggle with no caveat either way | `grep KONVEYOR_RULES` over `main` Go: none; `prompt.go` has no rules layer; #157 changelog "Rules start working" | P1 (today) |
| D2 | Two descriptions — `spec.description` (human, UI) and frontmatter `description` (model selection). Nothing links or displays them together | CRD + ADR 0014 consequences | P2 |
| D3 | Two names — SkillCard `metadata.name` (k8s rules, dots allowed per the UI helper) vs frontmatter `name` (1–64, lowercase + single hyphens). Post-#157 the skill lands under the frontmatter name; collisions fail the pod and the UI cannot see them coming | ADR 0015 §7; `nameValidationHelper` | P2 |
| D4 | `Ready` on a card means "ref accepted". Post-#157 a `deliveryMode` and real `InvalidSkillContent` for inline exist; the UI maps neither | `SkillCardStatus` (#157) | P2 |

### Rig / contract

| # | Gap | Evidence | Sev |
| --- | --- | --- | --- |
| E1 | Mock inventory stack skill fixtures predate the contract: `skills[].spec = {description}` (no image/type/status), `skillcollections[].spec.skills = ["analyze-issues"]` (strings, not `{name, skillCardRef}`) — the collection row renders with an empty name and the modals are never exercised against real shapes; no scripted run emits a `load_skill` tool call | `hack/mock-inventory-stack.mjs` 93–103 | P3 |
| E2 | `contract.ts` will drift from #157: missing `subPath`, `ref`, `status.deliveryMode`, `SkillCollectionSpec.image/type`, entry `ref/subPath/type`, `status.resolvedSkills` | `contract.ts` 181–227 | P2 |

## 4. What good looks like

Grounded in the API that exists (main) or is approved (#157). Ordered cheapest-first; nothing here needs a new CRD field until phase 3.

### Phase 1 — console-only, ship with ui#3546 or right after

- **Inline authoring as the primary path.** A "Content" tab in the SkillCard modal: `SKILL.md` textarea pre-filled with frontmatter from the Name/Description fields, client-side validation with the Agent Skills rules (name regex, description ≤ 1024, frontmatter present), type selector with a one-line cost hint ("Rule: always in context; Skill: loaded when the agent decides"). Inline is the only path a browser user can finish. It resolves only on a #157 controller — on `main` it reports `InlineNotSupported`, so render the condition message and let the user see why.
- **Source picker: Image / Git / Inline**, with `subPath` on image and git, `ref` on git (warn when empty: unreproducible). Stop converting sources on edit.
- **Description column + detail drawer** (spec, status incl. `deliveryMode` and condition message, inline body, "referenced by" agents computed client-side). `Ready` tooltip: "Reference accepted by the controller; the image is pulled when a run starts."
- **Fix the copy**: drop the danger alert and red zero; "Skills are optional. Rules are injected into every prompt; skills are loaded when the agent judges them relevant."
- **Collections**: SkillCard picker (select, not free text), per-entry type/subPath, and once #157 lands, an "Enumerate an image" mode with `resolvedSkills` listed.
- **Rig**: fix the fixtures to the real shapes and add one scripted run with a `load_skill` tool call so the transcript treatment can be verified cluster-free.

### Phase 2 — needs a small upstream change each, file now

- **Run detail "Skills" panel.** Cheapest source today: resolve the run's Agent and list its cards/collections with type and delivery mode (client-side join). Correct source: the loader already writes `/opt/skills/.konveyor-skills.json`; ask for it (or its summary) on `AgentRun.status` so the panel shows what was *actually* assembled, not what was declared.
- **Skill activations in the transcript.** Mark `tool_call`s whose title/name is `load_skill` as "Loaded skill *X*" with the skill name pulled from the arguments; cheap client heuristic, no API change. Rules: show "N rules injected" from the same status.
- **A skill-load condition on AgentRun.** `SkillsReady` (or fold into the coming `Succeeded` condition work in [#119](https://github.com/konveyor/agentic-controller/issues/119)) carrying the loader's termination message; unsupported ImageVolume / hung clone must stop reading `Running`. This is the same mechanism as the drafted "failure reasons on runs" issue — post them together.
- **Launch modal**: read-only "This agent brings: …" list; per-run selection stays parked until upstream decides whether `AgentRunSpec` grows a skills field.

### Phase 3 — product decisions

- **Import**: file upload → inline (single `SKILL.md`) or git (multi-file); **doc-to-skill** per [#158](https://github.com/konveyor/agentic-controller/issues/158) as a guided generator feeding the same inline path.
- **Provenance / source column**: `konveyor.io/managed` already distinguishes seeded from user-created; "organization" needs either a label convention or the RHDH catalog pull the designer proposed.
- **Authoring surface**: [#153](https://github.com/konveyor/agentic-controller/issues/153) may make SkillCollection the thing users write and cards generated records — the console should not over-invest in per-card editing until that lands.

## 5. Upstream threads to join rather than duplicate

- [#151](https://github.com/konveyor/agentic-controller/issues/151) / [#157](https://github.com/konveyor/agentic-controller/pull/157) — packaging + loader (shape changes above); [#147](https://github.com/konveyor/agentic-controller/issues/147) versioned bundle tags.
- [#153](https://github.com/konveyor/agentic-controller/issues/153) — collections as authoring surface; [#158](https://github.com/konveyor/agentic-controller/issues/158) — doc-to-skill; [#154](https://github.com/konveyor/agentic-controller/issues/154) — private git / authenticated images; [#81](https://github.com/konveyor/agentic-controller/issues/81) — authoring docs; [#126](https://github.com/konveyor/agentic-controller/issues/126) — out-of-box image.
- [#120](https://github.com/konveyor/agentic-controller/issues/120) boundary pass, [#75](https://github.com/konveyor/agentic-controller/issues/75) idempotent stage skills, [#98](https://github.com/konveyor/agentic-controller/pull/98) stage skills (changes requested) — content, not UX, but they decide what the default skills *are*.
- Hub [#1112](https://github.com/konveyor/tackle2-hub/issues/1112) / [#1119](https://github.com/konveyor/tackle2-hub/pull/1119) — pass-through CRUD, namespace forced, no validation; RBAC: admin/architect write, migrator read-only.
- Not filed anywhere yet: run-side visibility (C2/C3/C5) and the skill-load condition (C4). UPSTREAM-FEEDBACK §4/§5 cover the runtime and per-run-selection halves.

---

## Appendix — upstream issue drafts (not posted; Ian posts)

Both are deliberately short per the house style: state the gap, ask the question, offer a design. Target repo: konveyor/agentic-controller.

### Draft 1 — comment on [#119](https://github.com/konveyor/agentic-controller/issues/119) (or its own issue if djzager prefers): skill-loader failures and never-starting pods must reach `AgentRun.status`

> Two more outcomes for the Succeeded condition, both from the skills side, both invisible on the run today:
>
> 1. **The #157 `skill-loader` init container fails** (bad `subPath`, missing frontmatter, duplicate skill name, unreachable git host). The pod goes `Failed` with the agent container never started, and the only human-readable reason is the init container's termination message (`initContainerStatuses[].state.terminated.message`, thanks to `FallbackToLogsOnError`). The AgentRun gets a generic `Failed` and nothing says "skill `plan`: duplicate name" — a user who typed the wrong sub-path in the console has no way to find out short of `kubectl describe pod`.
> 2. **The pod never starts at all**: ImageVolume on a runtime without support (cri-dockerd → `CreateContainerError`), `ImagePullBackOff` on a skill image, or a git clone that hangs in the loader. Anything short of Finished maps to `Running`, so these runs read `Running` forever.
>
> Since this issue already gives the controller pod read RBAC to lift the agent container's termination message, could the same pass cover the init container and the waiting reasons?
>
> - loader terminated non-zero → `Succeeded{False, reason: SkillLoadFailed, message: <loader's termination message>}`, phase `Failed`.
> - any container `waiting` with reason in {`CreateContainerError`, `ImagePullBackOff`, `ErrImagePull`, `CreateContainerConfigError`} for longer than a grace period → `Succeeded{False, reason: PodNotStarting, message: <waiting reason + message>}` (phase `Failed`, or at least not `Running`).
> - an activeDeadline on the loader container so a hung clone terminates with a message instead of hanging the run.
>
> Happy to take the tackle2-ui side once the reasons exist — the run detail page will render `message` next to the phase.

### Draft 2 — new issue: expose the skills a run actually assembled on `AgentRun.status`

> After #157 a run's skills come from several sources (image + subPath, inline ConfigMap, git clone) and the loader decides the final directory from each skill's frontmatter name. None of that is visible on the AgentRun: a client can only re-resolve the Agent's refs and guess.
>
> Two small additions would make the run self-describing:
>
> 1. **Declared, at sandbox creation** — the controller already builds `KONVEYOR_SKILL_SOURCES`; mirror it as `status.skillSources: [{name, type, delivery: image|inline|source, image?, subPath?, source?, ref?}]`. No new RBAC, available from `Pending`.
> 2. **Assembled, after init** — the loader already writes `/opt/skills/.konveyor-skills.json` (name, description, type, source, rules list). Have it also write a compact form to `/dev/termination-log` on success (it is an init container, so it terminates normally; 4 KiB budget). With #119's pod read, the controller copies it to `status.skills: [{name, type, source}]` + `status.rules: [names]`. That is the list the console should show on the run detail page, and it is the ground truth the "did the model load skill X" question (the `load_skill` tool calls in the ACP stream) can be matched against.
>
> Is (1) acceptable as a first step on its own? It is a status-only change on the existing code path. (2) can follow #119.
