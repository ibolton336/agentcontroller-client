# Coolstore Java EE → Quarkus: flow explainer + 3-stage playbook design

Path shorthand:
- `PR53` = `/private/tmp/claude-501/-Users-ibolton-agentcontroller-client/94969a53-3f25-4173-ad05-1b4727bbb3f7/scratchpad/pr53`
- `ACMAIN` = `/private/tmp/claude-501/-Users-ibolton-agentcontroller-client/a772e825-5117-4f35-861a-a9b7bedb57d1/scratchpad/acmain`

See also: [harness-mental-model.md](harness-mental-model.md) — diagram-first summary of how the #53 harness operates across a playbook run.

---

## DELIVERABLE 1 — How it flows (Hub → controller → harness → goose → git push)

### 1. Where the work comes from: tackle2-hub

The harness is **self-serving**: nothing hands it a repo URL or credentials. Given only `HUB_BASE_URL` + `APP_ID` (+ optional `HUB_TOKEN`), it calls the Hub API to fetch the Application (repo URL + source branch) and the decrypted **source** git Identity — Direct("source") then Indirect("source") fallback; empty identity user defaults to `x-access-token` (`PR53/harness/internal/hub/client.go:32-45`, `PR53/harness/cmd/migration-harness/main.go:250-285`). It also fetches Hub analysis Insights and writes them to `<workdir>/.konveyor/analysis.json` (warn-only on failure, `main.go:287-315`). Live Hub in-cluster URL: `http://tackle-hub.konveyor-tackle.svc:8080` (verified on run `fork-w8vfb`).

### 2. AgentRun → Sandbox → pod env injection

Creating an `AgentRun` (konveyor.io/v1alpha1) makes the controller create a **Sandbox CR** (agents.x-k8s.io/v1beta1); the agent-sandbox controller v0.5.0 stamps out the pod. The container runs `agent.spec.image` with **no command/args override** — the image ENTRYPOINT `["migration-harness"] CMD ["run"]` executes (`PR53/internal/controller/agentrun_controller.go:370-390`; `PR53/images/agent-base/Containerfile:62-63`). RestartPolicy `OnFailure` (:371), no resource limits (BestEffort), a 10Gi emptyDir `workspace` mounted at `/workspace` (:332-344).

Env built in this exact order (`buildEnvVars`, `agentrun_controller.go:406-509`):

| Pod env var | Source |
|---|---|
| `KONVEYOR_PARAM_<UPPER(name)>` | params **declared on the Agent**, run values override defaults; empty values skipped; undeclared run params are rejected (`Failed/InvalidParams`, :213-242) |
| `KONVEYOR_ACP_SECRET_KEY` | generated per-run Secret `<run>-acp-key` via secretKeyRef (:296-315, :436-444) |
| `KONVEYOR_INSTRUCTIONS` | `run.spec.instructions` (:447-452) |
| `KONVEYOR_PROMPT` | `agent.spec.prompt` (:455-460) |
| `KONVEYOR_MODEL_<ROLE>_{PROVIDER,MODEL,ENDPOINT}` (+`_API_KEY` only for keyed credentialRef; keyless creds like AWS SigV4 arrive as whole-secret `envFrom`) | `run.spec.models` + LLMProvider lookup (:462-506). **No controller defaults models** — the run creator must set them; empty models = no model env = harness fatal at startup |
| `run.spec.env` | appended **last, verbatim** (:509) — this is the only channel for `HUB_BASE_URL`, `HUB_TOKEN`, `APP_ID`, `TARGET_BRANCH` |

Skills: each `agent.spec.skillCards[].ref` resolves to `SkillCard.status.resolvedImage` mounted as a read-only **ImageVolume** at `/opt/skills/<name>`; any unresolvable skill fails sandbox creation entirely (:517-590).

### 3. Harness lifecycle (`runStage`, `PR53/harness/cmd/migration-harness/main.go:45-186`)

Required env (fatal if unset): `KONVEYOR_MODEL_PRIMARY_MODEL`, `KONVEYOR_MODEL_PRIMARY_PROVIDER`, `HUB_BASE_URL`, `APP_ID`, `KONVEYOR_ACP_SECRET_KEY` (`config.go:28-40`) plus `TARGET_BRANCH`, which must **differ from the Hub source branch** (`main.go:67-71, 317-325`).

1. Hub resolve app + creds → **clone all refs** to `$HARNESS_WORK_DIR` (default `/workspace/repo`) → strip creds from remote URL → `hub.ClearEnv()` unsets HUB_BASE_URL/HUB_TOKEN/APP_ID so goose never sees them (`main.go:85`; `hub/client.go:70-74`).
2. `CheckoutBranch(TARGET_BRANCH)`: if `origin/<TARGET_BRANCH>` exists, the local branch is created **at that remote hash** — stage N+1 resumes exactly where stage N pushed (`git/git.go:88-110`). This is the entire inter-stage handoff mechanism; there is no PVC or status-file chaining.
3. Write `.konveyor/analysis.json` (warn-only; committed to the branch since `.json` is a stageable ext).
4. `goose serve --port 4000 --with-builtin developer`; ACP WebSocket `ws://127.0.0.1:4000/acp?token=<secret>`; `session/new` with cwd = clone dir, no MCP servers (`goose/lifecycle.go:38-82`; `main.go:108-115`).
5. Prompt = concatenation of (`buildPrompt`, `main.go:222-246`):
   - `KONVEYOR_PROMPT` (Agent persona)
   - `## Migration Context` = `KONVEYOR_PLAYBOOK_INSTRUCTIONS` (playbook guide)
   - `## Skill Instructions` = **all** `/opt/skills/*/SKILL.md` concatenated (zero skills = fatal; `main.go:197-220`). Skills reach goose **only** as prompt text.
   - `## Stage Task` = `KONVEYOR_INSTRUCTIONS`
6. One `session/prompt`, tool-call budget `KONVEYOR_PARAM_MAX_TURNS` (default 200; exhaustion = stage failed but work still pushed). A filesystem watcher auto-commits ("konveyor: auto-commit progress") after 30s quiet periods with warn-only push errors (`main.go:130-143`).
7. **Final commit+push always runs** ("konveyor: stage complete") on a fresh 60s context; final push failure IS fatal (`main.go:169-177`). Push is a plain non-force refspec; commits authored `migration-harness <migration-harness@konveyor.io>` (`git.go:157-183`).
8. Untracked-file staging gate: `pom.xml` always; otherwise ext must be in `{.md,.json,.yaml,.yml,.xml,.properties,.txt}` + `HARNESS_SOURCE_EXTS` (`watcher/patterns.go:11-64`). agent-java bakes `HARNESS_SOURCE_EXTS=".java,.gradle,.kts,.kt,.groovy"` (`PR53/images/agent-java/Containerfile:15-19`), so new `.java` files DO get pushed on this image.

The harness consumes exactly two `KONVEYOR_PARAM_*` vars (`MAX_TURNS`; `MAX_FIX_ITERATIONS` is parsed but dead in Go — though the **verify skill's prose** tells goose to honor it). All other params are ignored by the harness but inherited into goose's env.

### 4. How #36 playbooks wrap this

`AgentPlaybook.spec` = `guide` (string) + `stages[]`, each stage exactly `{name, agentRef, instructions}` — **no per-stage params/env/models** (`ACMAIN/api/v1alpha1/agentplaybook_types.go:25-60`; deployed CRD confirms). `AgentPlaybookRun.spec` = `{playbookRef, models, params, env, envFrom}`, **immutable** (CEL `self == oldSelf`), and the run won't start until the playbook is Ready (all stage Agents Ready).

`createAgentRunForStage` (`ACMAIN/internal/controller/agentplaybookrun_controller.go:305-343`) builds each stage AgentRun as: `agentRef`/`instructions` from the stage; `models`/`params`/`envFrom` copied **identically** from the playbook run; `env` = `[KONVEYOR_PLAYBOOK_INSTRUCTIONS=guide]` (if set) + `pbRun.spec.env` verbatim. Strictly sequential: current stage = first non-Succeeded; stage success = child AgentRun Succeeded = Sandbox condition `Finished=True/PodSucceeded` (`agentrun_controller.go:597-628`); any stage failure fails the whole run immediately, no retries (`agentplaybookrun_controller.go:250-262`).

### 5. Live-vs-code drift

- **Controller: no behavioral drift.** `agentrun_controller.go` is byte-identical between PR53 and ACMAIN (last touched fff23af/#36); every observable detail of the live `fork-w8vfb` pod matches the code. Caveat: the deployed `agentic-controller:dev` tag (namespace `agentic-controller-system`, pod up since 2026-07-21T18:13:43Z) has no digest→commit provenance.
- **Image drifts from Containerfile.** The loaded `quay.io/konveyor/agent-java:dev` has extra local-build layers baking five skills into `/opt/skills` (`plan, execute, verify, javaee-to-quarkus, patternfly-migration`, md5-identical to tree sources); no Containerfile COPYs skills, and CI publishes only `skills/examples/*`. goose comes from a floating `stable` tag (1.44.0 in the loaded image).
- **Agent drift:** `java-hub-analyzer` gained `skillCards: [javaee-to-quarkus]` *after* the fork-w8vfb run, so future runs of that agent will exercise the **never-yet-tested** ImageVolume mount path on this kubelet.
- **`ACMAIN/harness/` is the OLD pre-#53 harness** (`GIT_TARGET_BRANCH`, CLI-arg request) — ignore it.

---

## DELIVERABLE 2 — Coolstore demo playbook design

### 2.1 Design choices (why the YAML looks like this)

- **One Agent for all three stages.** Per-stage variance is instructions-only anyway, and playbook-run params are forwarded to every stage — a single Agent guarantees the params-declared-by-all-stages rule can't bite. The existing `java-hub-analyzer` is a trap: it declares `repository` as **required with no default** (any run not supplying it → `Failed/InvalidParams`) and now carries `skillCards`, which would exercise the untested ImageVolume path. Define a fresh Agent instead.
- **No skillCards on the demo Agent.** The five skills are already baked into `agent-java:dev` at `/opt/skills` and the harness globs that dir regardless of mounts. Zero ImageVolume risk.
- **Env, not params, for Hub/branch plumbing.** Params only ever become `KONVEYOR_PARAM_<UPPER>`; nothing translates them to plain names. `HUB_BASE_URL`/`APP_ID`/`TARGET_BRANCH` must ride `AgentPlaybookRun.spec.env`, which is copied verbatim to every stage AgentRun and appended last onto each container's env — the confirmed, validation-free channel.
- **Models must be set on the AgentPlaybookRun** (no controller defaulting; kubectl-created runs that omit them produce a pod missing `KONVEYOR_MODEL_PRIMARY_*` → harness fatal → OnFailure crash-loop). LLMProvider `aws-bedrock` in `konveyor-agents` is Ready with keyless SigV4 credentialRef (`aws-bedrock-creds` envFrom).
- **Fresh playbook name** — `java-ee-to-quarkus` and `javaee-to-quarkus` playbooks already exist in the cluster with Ready=False; don't collide with them.
- **Turn budget as a declared Agent param** with default 150 (assess/remediate need headroom; java-hub-analyzer's 40 is far too low for remediate). Not `required` (CEL forbids required+default).

### 2.2 Manifests (namespace `konveyor-agents`)

```yaml
# 1. Agent — one agent drives all three stages; skills are baked in the image
apiVersion: konveyor.io/v1alpha1
kind: Agent
metadata:
  name: coolstore-quarkus-migrator
  namespace: konveyor-agents
spec:
  image: quay.io/konveyor/agent-java:dev   # skills baked at /opt/skills: plan, execute, verify, javaee-to-quarkus, patternfly-migration
  providers:
    - ref: aws-bedrock                     # must match a Ready LLMProvider; validateModels checks membership
  params:
    - name: max_turns
      type: number
      description: Tool-call budget per stage
      default: "150"                       # harness reads KONVEYOR_PARAM_MAX_TURNS; default-not-required (CEL forbids both)
  prompt: |
    You are a senior Java engineer performing one stage of a staged Java EE 7 to
    Quarkus 3 migration. Work only inside the workspace repository. Never run git
    commands yourself; the harness commits and pushes your file writes automatically.
---
# 2. AgentPlaybook — guide becomes KONVEYOR_PLAYBOOK_INSTRUCTIONS in every stage
apiVersion: konveyor.io/v1alpha1
kind: AgentPlaybook
metadata:
  name: coolstore-quarkus-demo
  namespace: konveyor-agents
spec:
  guide: |
    Three-stage migration of the coolstore application from Java EE 7 (WAR on an
    app server) to Quarkus 3: assess -> remediate -> validate. All stages share one
    git branch; each stage builds on the files the previous stage committed there.
    A Konveyor Hub static-analysis report is available at .konveyor/analysis.json
    in the repo root. The patternfly-migration skill does not apply to this
    application (no PatternFly UI) — ignore it in every stage.
  stages:
    - name: assess
      agentRef: coolstore-quarkus-migrator
      instructions: |
        Stage 1 of 3 (assess). Follow the `plan` skill exactly: run graphify, read
        .konveyor/analysis.json (Konveyor Hub analysis insights for this app), and
        use the javaee-to-quarkus skill's phase list and references to identify what
        must change. Write PLAN.md in the repo root, ordering steps by the
        javaee-to-quarkus phases (build config -> app config -> EJB-to-CDI ->
        messaging -> lifecycle -> cleanup). Set `mvn compile` as the Verification
        build command. Do NOT modify any source files and do NOT run the
        javaee-to-quarkus per-phase build gates — planning only.
    - name: remediate
      agentRef: coolstore-quarkus-migrator
      instructions: |
        Stage 2 of 3 (remediate). PLAN.md already exists in the repo root from the
        assess stage. Follow the `execute` skill exactly: work through every PLAN.md
        step in order, applying the transformation patterns from the
        javaee-to-quarkus modules and references (annotation-map, dependency-map,
        config-map, pattern-map). Do NOT run builds or tests, do NOT modify PLAN.md,
        and do NOT follow the javaee-to-quarkus build gates — the validate stage
        handles compilation.
    - name: validate
      agentRef: coolstore-quarkus-migrator
      instructions: |
        Stage 3 of 3 (validate). Follow the `verify` skill exactly: run the build
        command from PLAN.md's Verification section (mvn compile), fix compiler
        errors minimally using the javaee-to-quarkus references/verify-errors.md
        mappings, and iterate. Then run the tests and report results without fixing
        test failures. Do NOT modify PLAN.md.
---
# 3. AgentPlaybookRun — spec is immutable; models + env are copied to ALL stages
apiVersion: konveyor.io/v1alpha1
kind: AgentPlaybookRun
metadata:
  name: coolstore-quarkus-demo-1
  namespace: konveyor-agents
spec:
  playbookRef: coolstore-quarkus-demo
  models:                                  # REQUIRED by hand — no controller defaults these
    - role: primary
      provider: aws-bedrock
      model: us.anthropic.claude-sonnet-4-5-20250929-v1:0
  params:
    - name: max_turns
      value: "150"                         # declared on the (single) Agent, so valid for every stage
  env:                                     # copied verbatim to every stage pod, appended last
    - name: HUB_BASE_URL
      value: http://tackle-hub.konveyor-tackle.svc:8080
    - name: APP_ID
      value: "1"                           # coolstore in the Hub -> resolves https://github.com/ibolton336/coolstore.git + source identity
    - name: TARGET_BRANCH
      value: quarkus-migration-demo-1      # ONE branch for all three stages; must differ from the Hub source branch (main)
```

### 2.3 How APP_ID / TARGET_BRANCH / HUB_BASE_URL reach each stage pod

Confirmed chain, no gaps for **env**: `AgentPlaybookRun.spec.env` → copied verbatim onto each stage AgentRun's `spec.env` (`agentplaybookrun_controller.go:323,340`) → appended last onto the sandbox container env (`agentrun_controller.go:508-509`) → read by the harness under those exact plain names. The playbook `guide` additionally arrives as `KONVEYOR_PLAYBOOK_INSTRUCTIONS` prepended to that env list. **The needed path exists; no workaround required.** What does NOT exist: per-stage env/params/models (stage fields are only name/agentRef/instructions), and any params→plain-name translation. If you ever need a per-stage env value, the smallest workarounds are (a) different Agents per stage (Agent prompt differs) or (b) the fallback in 2.5.

Branch continuity: assess creates `quarkus-migration-demo-1` from the clone's HEAD and pushes PLAN.md/graph.json/.konveyor/analysis.json; remediate's fresh pod clones all refs and `CheckoutBranch` lands on `origin/quarkus-migration-demo-1` at assess's tip; same for validate. Each stage has a brand-new 10Gi emptyDir — git is the only shared state.

### 2.4 Gaps / blockers, ranked by demo risk

1. **Fail-path crash-loop (HIGH — known #36 gap).** Pods are `RestartPolicy: OnFailure`; a harness exit 1 (MaxTurns exhausted, goose error, missing env) restarts the container in place, so the Sandbox never reports Finished/failed and the playbook run sits `Running` while the stage **re-runs from scratch repeatedly, burning Bedrock tokens**. Mitigation: watch `kubectl get pods -w`; on a crash-looping stage, `kubectl delete agentplaybookrun` (needs a human, since spec is immutable — no cancel field). Budget max_turns generously so exhaustion doesn't trigger this mid-demo.
2. **Params-declared-by-all-stages rule (HIGH if ignored, ELIMINATED by this design).** pbRun params go to every stage; any stage agent that doesn't declare one → that stage `Failed/InvalidParams` (which then hits gap #1's stuck-Running or fails the playbook). Single shared Agent declaring exactly `max_turns` removes the risk. Never reuse `java-hub-analyzer` (required `repository` param).
3. **Models injection for kubectl-created runs (HIGH if forgotten).** No controller defaults `spec.models`. Omitting it validates fine but yields a pod without `KONVEYOR_MODEL_PRIMARY_*` → harness fatal at startup → crash-loop per #1. The manifest above sets it explicitly.
4. **Verify "success" is not build success (MEDIUM, narrative risk).** The harness derives stage success from ACP errors/goose liveness only; a verify stage that *reports* "build still failing" exits 0 and the playbook shows Succeeded. Demo script should show the pushed branch/`mvn compile` output, not just the CR phase.
5. **Skill-steering hazard (MEDIUM).** All five SKILL.md files are in every prompt; javaee-to-quarkus's own per-phase build gates contradict plan ("no source changes") and execute ("no builds"), and patternfly-migration is irrelevant. The stage instructions + guide above explicitly demote/exclude them — keep that text.
6. **Memory pressure (MEDIUM).** ~7.65 GiB allocatable node, BestEffort pods, goose + graphify + (validate) Maven JVM concurrently. Stages run one-at-a-time which helps; avoid running other heavy pods during the demo. First `mvn` run cold-downloads the Quarkus tree into `~/.m2` — expect several extra minutes in validate.
7. **Maven availability: NOT a blocker.** agent-java:dev has Maven 3.9.9 + OpenJDK 21 verified live; coolstore's system-scope `audit-logging-library` jar is in-repo. Residual: pre-migration pom pins maven-compiler-plugin 3.0 (2013) which may fail on JDK 21 — moot because validate runs *after* remediate rewrites the pom, and the verify skill fixes compile breakage (UNCERTAIN only for a pre-migration baseline build).
8. **Non-fast-forward push (LOW).** Final push is non-force and fatal on failure; stages are sequential so the only realistic collision is a human pushing to TARGET_BRANCH mid-demo. Don't.
9. **Housekeeping (LOW).** `.konveyor/analysis.json` + `graph.json` get committed to the demo branch (arguably a feature — shows Hub provenance). Playbook run name/branch must be fresh per attempt (spec immutable; reusing TARGET_BRANCH from a bad run resumes its history).

### 2.5 Fallback: three sequential AgentRuns (no playbook CRD)

Same story, human-sequenced — use if anything in the playbook plumbing misbehaves on the day. Uses only the AgentRun path already proven live today (fork-w8vfb pushed to the real fork). Since there's no playbook, supply the migration-context text yourself via `KONVEYOR_PLAYBOOK_INSTRUCTIONS` in `spec.env` (the harness reads it as a plain env var; it doesn't care who set it).

```yaml
apiVersion: konveyor.io/v1alpha1
kind: AgentRun
metadata:
  name: coolstore-assess-1
  namespace: konveyor-agents
spec:
  agentRef: coolstore-quarkus-migrator
  models:
    - role: primary
      provider: aws-bedrock
      model: us.anthropic.claude-sonnet-4-5-20250929-v1:0
  params:
    - name: max_turns
      value: "150"
  instructions: |
    <assess stage instructions from 2.2, verbatim>
  env:
    - name: KONVEYOR_PLAYBOOK_INSTRUCTIONS
      value: "<guide text from 2.2, verbatim>"
    - name: HUB_BASE_URL
      value: http://tackle-hub.konveyor-tackle.svc:8080
    - name: APP_ID
      value: "1"
    - name: TARGET_BRANCH
      value: quarkus-migration-demo-1
```

Then wait for `phase: Succeeded` (`kubectl get agentrun coolstore-assess-1 -w`), and create `coolstore-remediate-1` and `coolstore-validate-1` identically, changing only `metadata.name` and `instructions` (remediate/validate text from 2.2). **Identical env — especially TARGET_BRANCH — in all three**; branch-resume via `origin/<TARGET_BRANCH>` does the chaining exactly as in the playbook. Advantages: you can inspect the pushed branch between beats, tune the next stage's instructions from what actually landed, and a crash-looping stage only wedges itself (delete the one AgentRun, fix, recreate) instead of wedging an immutable playbook run.

---

## LOAD_BEARING_CLAIMS

See structured field.
