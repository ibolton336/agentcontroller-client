# PR #35 → next level: the management UX on PR #53's world

Planning doc, 2026-07-28. Source-verified against the PR #53 head
(b446262, checked out and read file-by-file) and the current
`clients-reference-stack` tree (PR #35 head). Companion to
`issue-22-contract.md` (the Hub placement decision) — this doc is about
the *client stack's* next phase, which can proceed in parallel with the
Hub/harness/controller tracks.

**The one-line thesis:** PR #35 today is a *run console* (create runs,
chat, watch playbooks). Next level = a *management console* — define
agents (image + skills), author skillcards/collections, compose
playbooks, launch against real applications, track executions — built on
the CR shapes, images, and harness contract PR #53 establishes.

---

## What #53 changes under our feet (verified)

- **Harness-pulls is implemented.** `migration-harness` hard-requires
  `HUB_BASE_URL`, `APP_ID`, `KONVEYOR_ACP_SECRET_KEY`, and
  `KONVEYOR_MODEL_PRIMARY_{MODEL,PROVIDER}` (`HUB_TOKEN` is optional —
  public repos work), fetches the application,
  decrypted git identity (`x-access-token` default username), and
  analysis insights from the Hub, writes `.konveyor/analysis.json`,
  strips credentials from the remote URL, unsets the Hub env vars before
  goose starts, and is the only thing that pushes. There is **no
  non-Hub path**.
- **The ADR-0005 annotation machinery is dead for run construction.**
  No more `konveyor.io/param-sources` → repository/branch params, no
  more identity-Secret envFrom bridge. (`applicationRef` is a
  client-stack create-input concept, not a #53 CR field — #53's seeds
  feed `HUB_BASE_URL`/`APP_ID`/`TARGET_BRANCH` via plain `spec.env`.)
  The *shim* must translate `applicationRef` into that env injection,
  and `ParseAppID` requires a numeric id — the shim's `coolstore` stub
  id is un-runnable.
- **`TARGET_BRANCH` is required and caller-minted.** The harness
  validates non-empty + differs-from-source-branch, and continues
  `origin/<branch>` if it exists (that's how stages chain). Nothing in
  the system generates the name — the test scaffolding stamps
  `konveyor/migration-<unix-ts>`. **The branch question is launcher UX.**
- **Skills are mandatory at runtime.** SkillCard → OCI image →
  `ImageVolumeSource` mounted at `/opt/skills/<name>`; the harness
  fatals on zero `SKILL.md` matches. Image-sourced cards are the only
  Ready kind (inline/git-source reconcile to NotReady "Phase 3").
- **One prompt, four layers.** `KONVEYOR_PROMPT` (Agent) +
  `KONVEYOR_PLAYBOOK_INSTRUCTIONS` (guide) + concatenated skills +
  `KONVEYOR_INSTRUCTIONS` (stage/run). The harness owns the ACP session
  (cwd `/workspace/repo`) and sends that prompt itself.
- **Models are hard-required** (`KONVEYOR_MODEL_PRIMARY_*`); the shim's
  model injection graduates from workaround to contract. Provider name
  maps to a goose provider id *verbatim* (lowercased, `-`→`_`) — the CR
  must be named e.g. `gcp-vertex-ai`; a provider named `bedrock` no
  longer maps to `aws_bedrock`.
- **No HITL anywhere.** Plan approval was deleted; the playbook
  controller auto-advances stages. `handoff.md` is claimed by ADR 0006
  but not implemented; token usage is parsed then discarded.
- **What survives untouched:** sandboxName == run name, `<run>-acp-key`
  Secret + `status.secretKeyRef`, ACP `:4000/acp`, `KONVEYOR_PARAM_*` /
  `KONVEYOR_MODEL_<ROLE>_*` injection, keyless-credentialRef → envFrom,
  spec immutability, playbook stage labels + deterministic stage-run
  names. The UI's run pages and `waitForRunning` keep working; the WS
  bridge *should* keep working but dials with the `X-Secret-Key` header
  while #53's own client uses `?token=` — header auth on unpinned goose
  "stable" is exactly the drift feedback #1 is about, so treat it as
  conditional until verified.

## Upstream feedback to file on #53 *now* (it's still open)

| # | Finding | Why it matters |
|---|---------|----------------|
| 1 | `images/agent-base/Containerfile` installs `block/goose` **stable** (unpinned), replacing the pinned fork v1.39.0 the ACP contract (header + `?token=` auth, plain HTTP, connection semantics) was source-verified against | Contract drift lands silently on every image rebuild; ask for a pin |
| 2 | `StartServe` omits `--host 0.0.0.0` (old entrypoint had it) and the harness dials `127.0.0.1` | If goose binds loopback-only, pod-external ACP attach — the entire UI/Hub chat surface promised by ADR 0002/0003 — breaks; needs a bind check or the flag restored |
| 3 | Seed Agents in `hack/harness-test/` carry no `konveyor.io/managed: "true"` label | Invisible to the Konveyor UI list filter; label the seeds |
| 4 | Old harness `README.md` + `meta-skill/` describe the deleted five-stage CLI | Stale contract docs will mislead the next integrator |
| 5 | Token usage (`PromptResult.Usage`) is parsed and discarded; no `handoff.md` despite ADR 0006 | Both are exactly what an execution console wants to display — cheap wins if kept |

## Phase 0 — Re-base the run path on #53 (prereq for everything)

Goal: the stack can create runs the #53 harness actually executes.
Develop against a kind cluster running the `pr-53` branch CRDs.

1. **Retire obsoleted pieces:** `harness-goose` image + entrypoint
   (keep `harness-mock` as the e2e fixture), the `goose-bedrock`
   manifests' annotation params, the `IDENTITY_SECRET_BRIDGE`, and the
   shim's param/credential resolution path. (The annotations remain a
   documented mechanism for non-Hub callers per issue-22, but the
   samples and shim stop exercising them.)
2. **Browser contract additions** (`agentic-client/src/contract`):
   `skillCards`/`skillCollections` on `AgentResourceSpec`; typed
   `env`/`envFrom` on `AgentRunSpec` *and* `AgentPlaybookRunSpec`;
   create inputs grow `targetBranch` (`applicationRef` already exists
   on both create inputs and both shim POST parsers — don't re-add it;
   the node-side `agentrun-client/src/types.ts` already matches #53,
   only the browser contract lags).
3. **Shim create-path rewrite:** `applicationRef` →
   `HUB_BASE_URL`/`HUB_TOKEN`/`APP_ID` env + `TARGET_BRANCH` from the
   request (shim mints the default `konveyor/migration-<ts>` if the
   caller omits it). Numeric application ids only — fix the stub.
   Pre-flight validation: provider name resolves to a goose provider
   id; agent has ≥1 resolvable skill.
4. **Chat becomes observer-first:** the harness owns the run session —
   the UI's default view is `session/load` replay/streaming of *that*
   session; "open interactive session" becomes an explicit secondary
   action rooted at `/workspace/repo`.

## Phase 1 — The management UX (maps 1:1 to the notes)

| Notes line | Feature | Grounding |
|---|---|---|
| "defining agents, specify image, specify skills" | **Agent Designer**: name, image (dropdown from the image catalog, Phase 2), prompt, providers picker, skillCards/skillCollections pickers showing Ready + `resolvedImage` (loud warning at zero skills — runs will fatal), params editor (name/type/default/required; CEL forbids required+default) | `agent_types.go`, zero-skills fatal in `main.go` |
| "skill cards and skill collections need a UX for creation" | **Skill Library**: read-only list ships immediately (shim GET routes exist, UI never consumed them); create = image-ref cards only (the one Ready kind: name, displayName, image, type `skill|rule`, tags); inline authoring marked demo-only/NotReady; collection composer = ordered member refs (members with direct `image` need no SkillCard) | `skillcard_controller.go` Phase-3 gates |
| "playbook — agent in sequence, agent with prompt, then agent with *that* prompt" | **Playbook Composer**: guide + ordered stages `{name, agentRef, instructions}`; validate label-safe stage names and provider overlap across stage agents (run-time constraint: one shared model selection forwarded to all stages). **Stage chaining today is artifact-based, not prompt-based**: stage N commits its output to `TARGET_BRANCH` (plan writes `PLAN.md`), stage N+1's skill reads it from the branch — there is no mechanism that feeds one stage's prompt/output into the next stage's prompt. If literal prompt-chaining is wanted, that's the unimplemented `handoff.md` from ADR 0006 fed into the next stage's `KONVEYOR_INSTRUCTIONS` — file it upstream (extends feedback #5), don't fake it client-side | `agentplaybook_types.go`, forwarding in playbookrun controller, `git.go` branch-continuation |
| "input parameter — custom on the fly vs hub pulled" / "prompt as input" / "hub fields" | **Run Launcher**: application picker (Hub inventory) answers *hub-pulled* — repo/branch/creds/analysis are harness-fetched, never form fields; *custom* = the agent's declared params (typed widgets from `AgentParam.type`: string/number/boolean) + instructions (the "prompt as input"); model picker (provider+model role `primary`, default = shim policy shown as a preview); **target-branch field, prefilled `konveyor/migration-<ts>`, editable** — the branch UX decision; the "hub fields" (repo URL, source branch, identity, analysis) appear as a read-only preview of what the harness will pull, never as inputs | harness config contract |
| "manage … executions" | **Execution Console** upgrades: show run spec (params/models/instructions/branch — currently hidden), TARGET_BRANCH link to the repo branch, incremental-commit feed ("konveyor: auto-commit progress"), stage outputs by convention (`PLAN.md`, `.konveyor/analysis.json`), re-run = delete+recreate affordance (spec is immutable), playbook-run delete button (client exists, UI missing), deep-link routing | watcher/commit contract |
| "we need Labels konveyor.io/managed" | Today the filter exists **only** in the shim's Agent list; the UI has no label code and nothing the stack creates stamps the label. Keep the filter, extend it to the other list routes, stamp the label on everything the UI creates, and get #53's seeds labeled (feedback #3) | shim `server.ts` `LIST_LABEL_SELECTORS` |
| — | **Write routes on the shim** (POST/PUT/DELETE agents, skillcards, skillcollections, playbooks) — these become the R1 route proposal for the Hub, same as the run routes did; fix the stale gateway RBAC — the deployed Role covers only agentruns/agents/llmproviders, so agentplaybooks, **agentplaybookruns** (the shipped playbook-run pages!), skillcards, and skillcollections all 403 in-cluster | ADR 0004 handover role, `deploy/manifests/gateway.yaml` |

## Phase 2 — Image catalog + seeded defaults + demo

- **"Resource to track images":** start with a labeled ConfigMap
  (`konveyor.io/managed`) cataloging the #53 image hierarchy
  (`quay.io/konveyor/agent-{base,java,go,csharp,nodejs}` + per-language
  notes); shim serves it, Agent Designer's image field becomes a
  dropdown with free-text escape. Propose an `AgentImage` CRD upstream
  only if the ConfigMap proves insufficient — don't block on controller
  work.
- **"Seed reasonable defaults":** mirror `hack/harness-test` as
  API-seeded defaults (a "Load defaults" action through the new write
  routes, replacing `demo-up.sh` kubectl): provider named as a goose
  provider id, three stage Agents (plan/execute/verify) on
  `agent-java`, the four `quay.io/konveyor/skills:<name>` cards,
  the `java-ee-to-quarkus` playbook — all labeled managed. (Note: the
  *playbook* is `java-ee-to-quarkus`, the *skillcard* is
  `javaee-to-quarkus` — don't mix them up in scripts.)
- **"goose base – skills – patternfly migrations":** the demo stretch —
  author a PatternFly-migration *domain* skill as a scratch OCI image,
  pair it with the stage skills on the `agent-nodejs` image, seed it as
  a second playbook. Proves the skill model generalizes beyond Java in
  one afternoon of skill-writing, zero code.
- **"use agent run against a real application":** the acceptance test —
  launcher → real Hub app id → real repo → branch link with commits.

## Deferred / decisions to park (from the notes)

- **Enum / JSON-schema params:** `AgentParam` is string/number/boolean
  with no enum and no coercion. Typed widgets now; file an upstream CRD
  proposal (enum values or a schema field) — don't block the launcher.
- **Archetype → skill association** ("if app is part of archetype, add
  skill to migration"): Hub-side roadmap — tag SkillCards, map
  archetype tags → suggestions. Note the inherent tension with "skills
  are baked into agent, no app discovery": under today's model skills
  live on the Agent spec and mount at pod creation, so there is no
  per-run skill selection. Archetype suggestions therefore belong at
  *authoring* time (suggest skills while building an agent/playbook for
  an archetype), not at launch time — launch-time selection would need
  an upstream CR change (run-level skill refs). Needs Hub archetype
  data the client doesn't have yet; park behind Phase 2.
- **RHDH always-hub-pulled:** already the model — RHDH posts
  `{agentRef/playbookRef, applicationRef, params?}` to the same
  endpoints; nothing extra needed beyond Phase 0.
- **HITL for plan approval:** deleted upstream in #53. If the demo
  needs an approval beat, it's a playbook-composer feature request
  upstream (pause-between-stages), not client work. Flag, don't build.

## Sequencing

```
now ──► file #53 feedback (5 items) ── while #53 is still open
     ├► Phase 0 (contract + shim + observer chat)      ~ the unblocker
     ├► Phase 1 screens in parallel once Phase 0 lands:
     │     Skill Library (read-only) → Agent Designer → Playbook
     │     Composer → Launcher → Execution Console upgrades
     └► Phase 2 (catalog, seeded defaults, patternfly demo, real-app run)
```

Phase 0 is small and surgical (contract fields + one shim path swap).
The screens are additive PatternFly work against routes that mostly
already exist read-only. The riskiest external dependency is #53's
goose pin / bind address (feedback #1/#2) — if external ACP attach
breaks, the Execution Console loses its live stream, so file that
feedback first.
