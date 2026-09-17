// Cluster-free mock HUB for tackle2-ui feature/agent-runs — hub-contract era.
// One listener, :18090, fronted by the express server's /hub proxy
// ("^/hub" -> ""). Serves BOTH the core inventory the app shell needs and
// the agentic/* surface per jortel:tackle2-hub@agentic (envelopes verified
// at 392a9493; /agent -> /agentic landed at 7751e27d, runs -> agentruns at
// 9ae3d72a, ACP nonce auth at a3af8307 = current head — this mock matches
// it; nonce statuses probe-verified 2026-08-11 against the live hub,
// quay.io/jortel/tackle2-hub:agent):
//   - lists return JSON arrays of full CRs
//   - create = POST full CR -> 201 CR (generateName honored,
//     konveyor.io/managed=true injected, like the hub)
//   - update = PUT full CR -> 204 NO BODY
//   - SkillCard / SkillCollection specs are checked the way the CRD does
//     (exactly one source; image xor skills) -> 422 with the apiserver's
//     message, as the hub passes it through
//   - run kinds: list/get/create only (no update/delete/cancel)
//   - POST /agentic/agentruns/:name/acp/nonce -> 201 nonce (single-use,
//     30s TTL), required by the WS upgrade in BOTH auth modes like the hub
//   - /agentic/agentruns/:name/acp?nonce=... answers a real WebSocket
//     upgrade (101) and speaks just enough ACP for the chat panel to reach
//     Connected (initialize, session/new, canned session/prompt) — and, for
//     the steer-* runs, the harness tee's side of a live run: the RUN's
//     session teed to every viewer plus goose's steer/cancel relay; a
//     missing/stale/reused nonce is refused with 401 like the real hub
//     (mint 201, fresh dial 101, reused/bare dial 401).
//   - skills-run-coolstore speaks that same tee for an agent that carries
//     skills (ADR 0014): goose's load_skill tool calls stream with their
//     rawInput (the skill, then skill/relative/file), then the turn ends
//     and the run flips to Succeeded. It also carries goose's custom
//     `_goose/unstable/session/update` channel the harness enables with
//     the customNotifications capability: usage_update (context occupancy
//     + accumulated tokens/cost), message_usage (one per model response)
//     and status_message (progress lines, and the harness's own closing
//     stage-outcome notice), plus the harness's final `git push` as a
//     harness-push-N tool_call — the read-only view's completeness case.
//   - Scripted runs replay the pod-boot race the panel has to ride out
//     (see SCRIPTED below): the clock starts on the first GET of the run's
//     detail, so restart the mock to replay.
// Every request is logged; POST/PUT bodies in full — the wire-shape proof.

import http from "node:http";
import crypto from "node:crypto";

const now = () => new Date().toISOString();
const ago = (mins) => new Date(Date.now() - mins * 60_000).toISOString();

const MANAGED = "konveyor.io/managed";
const APPLICATION = "konveyor.io/application";

// ---- ACP nonce (hub parity: single-use, 30s TTL, required in both modes)
const nonces = new Map(); // nonce -> expiry (epoch ms)
const issueNonce = () => {
  const n = crypto.randomBytes(8).toString("hex");
  nonces.set(n, Date.now() + 30_000);
  return n;
};
const redeemNonce = (n) => {
  const expiry = nonces.get(n);
  nonces.delete(n); // single-use: gone whether it validates or not
  return expiry !== undefined && Date.now() <= expiry;
};

// ---------------------------------------------------------------- fixtures

// agentic-controller#160: the controller reports ACPReady (True once the
// sandbox pod passes its tcpSocket:4000 readiness probe), and the UI dials
// exactly once on it and on nothing else. `legacy-boot-race-run` keeps the
// pre-#160 shape (no condition) to show the console waiting rather than
// dialing.
const acpCond = (listening, msg) => ({
  type: "ACPReady",
  status: listening ? "True" : "False",
  reason: listening ? "Listening" : "NotListening",
  message: msg ?? (listening ? "ACP endpoint accepts connections" : "Pod is Running but not Ready"),
});

// agentic-controller#157 controller: an image card's reference is accepted
// at face value (the image is pulled when a run starts), so Ready=True /
// ImageResolved the moment it is seen. agentic-controller#188 adds a separate
// best-effort Resolvable condition: whether the referenced artifact actually
// exists in its registry (Present / Missing / Unverified). `resolvable` lets a
// fixture override it; the default is Present.
const imageCardStatus = (image, resolvable) => ({
  observedGeneration: 1,
  resolvedImage: image,
  deliveryMode: "image",
  conditions: [
    { type: "Ready", status: "True", reason: "ImageResolved", message: `OCI image ref accepted: ${image}` },
    resolvable ?? {
      type: "Resolvable",
      status: "True",
      reason: "ArtifactPresent",
      message: `manifest found in registry: ${image}`,
    },
  ],
});

const store = {
  agents: [
    {
      metadata: {
        name: "migration-analyzer",
        creationTimestamp: ago(400),
        labels: { [MANAGED]: "true" },
        annotations: {
          "konveyor.io/param-sources":
            '{"repository":"konveyor.io/application-repository-url","branch":"konveyor.io/application-repository-branch"}',
        },
      },
      spec: {
        image: "ghcr.io/ibolton336/agent-java:demo",
        gateways: [{ ref: "default-gateway" }],
        params: [
          { name: "repository", required: true },
          { name: "branch", required: false, default: "main" },
        ],
        // Both cards are rules (plan from the bundle image, house-rules
        // inline); the on-demand skills reach the agent through the
        // collection, which also carries plan again.
        skillCards: [{ ref: "plan" }, { ref: "house-rules" }],
        skillCollections: [{ ref: "java-migration" }],
      },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    },
    {
      // No skills at all — the harness proceeds without any.
      metadata: { name: "freeform-agent", creationTimestamp: ago(300) },
      spec: { image: "ghcr.io/ibolton336/agent-base:demo", gateways: [{ ref: "default-gateway" }] },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    },
    {
      // agentic-controller#215: no gateways declared — a Ready template
      // whose runs must name a gateway themselves (GatewayConfigured=False).
      metadata: { name: "template-agent", creationTimestamp: ago(20), labels: { [MANAGED]: "true" } },
      spec: { image: "ghcr.io/ibolton336/agent-base:demo" },
      status: {
        conditions: [
          { type: "Ready", status: "True", reason: "AllDependenciesReady" },
          { type: "GatewayConfigured", status: "False", reason: "NoGatewaysDeclared", message: "Agent declares no gateways; an AgentRun must name one to run" },
        ],
      },
    },
    {
      // Not Ready: its gateway never verified. The controller does not
      // reject a run against it — it parks the run on AgentNotReady with no
      // sandbox (see run-blocked-agent-not-ready) — so the create-run modal
      // must disable it up front.
      metadata: { name: "coolstore-quarkus-migrator", creationTimestamp: ago(45), labels: { [MANAGED]: "true" } },
      spec: { image: "ghcr.io/ibolton336/agent-java:demo", gateways: [{ ref: "vertex-gateway" }] },
      status: {
        conditions: [
          { type: "Ready", status: "False", reason: "GatewayNotReady", message: 'Gateway "vertex-gateway" is not Ready', lastTransitionTime: ago(45) },
        ],
      },
    },
  ],
  // SkillCards in the #157 shape: exactly one source (image + subPath,
  // inline SKILL.md, or git), status.deliveryMode and a Ready condition the
  // controller wrote. `legacy-card` keeps the pre-#157 status (no
  // deliveryMode, no type) and `broken-inline` is a card saved without
  // frontmatter after the skill loader rejected it.
  skills: [
    {
      metadata: { name: "plan", creationTimestamp: ago(390), labels: { [MANAGED]: "true" } },
      spec: {
        image: "quay.io/konveyor/skills:latest",
        subPath: "plan",
        displayName: "Migration Planning",
        description: "Analyzes a project and produces a structured migration plan.",
        type: "rule",
        version: "1.0.0",
        tags: ["migration", "planning"],
      },
      status: imageCardStatus("quay.io/konveyor/skills:latest"),
    },
    {
      // The issue #187 phantom: a card whose image tag was never pushed. The
      // controller accepts the ref (Ready=True) but the best-effort Resolvable
      // check finds no manifest, so a run would ImagePullBackOff. The console
      // flags "Missing" before anyone starts a run.
      metadata: { name: "javaee-to-quarkus", creationTimestamp: ago(390), labels: { [MANAGED]: "true" } },
      spec: {
        image: "quay.io/konveyor/skills:javaee-to-quarkus",
        displayName: "Java EE to Quarkus",
        description: "Migrates Java EE applications to Quarkus: javax to jakarta, EJB to CDI, persistence.xml to application.properties.",
        type: "skill",
        version: "1.0.0",
        tags: ["migration", "quarkus"],
      },
      status: imageCardStatus("quay.io/konveyor/skills:javaee-to-quarkus", {
        type: "Resolvable",
        status: "False",
        reason: "ArtifactMissing",
        message: "quay.io/konveyor/skills:javaee-to-quarkus: manifest unknown",
      }),
    },
    {
      // Private registry the controller cannot read without pull credentials:
      // the existence check is inconclusive, so Resolvable=Unknown and the
      // console shows "Unverified" rather than a false Missing.
      metadata: { name: "internal-conventions", creationTimestamp: ago(200), labels: { [MANAGED]: "true" } },
      spec: {
        image: "registry.acme.internal/skills/conventions:v2",
        displayName: "Internal conventions",
        description: "Acme's internal skill card, hosted on a private registry.",
        type: "rule",
        version: "2.0.0",
        tags: ["conventions", "acme"],
      },
      status: imageCardStatus("registry.acme.internal/skills/conventions:v2", {
        type: "Resolvable",
        status: "Unknown",
        reason: "ResolveInconclusive",
        message: "registry.acme.internal/skills/conventions:v2: unexpected status code 401 Unauthorized",
      }),
    },
    {
      // Inline rule: a single SKILL.md with valid frontmatter, delivered as
      // a ConfigMap and injected into every prompt of the agents that
      // reference it.
      metadata: { name: "house-rules", creationTimestamp: ago(250), labels: { [MANAGED]: "true" } },
      spec: {
        inline: [
          "---",
          "name: house-rules",
          "description: Conventions every change in this organisation must follow, on every task.",
          "---",
          "# House rules",
          "",
          "- Never change a public API signature without leaving a deprecated shim behind.",
          "- Keep every commit buildable: run the module's tests before moving to the next one.",
          "",
        ].join("\n"),
        displayName: "House rules",
        description: "Organisation-wide conventions, injected into every prompt.",
        type: "rule",
        tags: ["conventions"],
      },
      status: {
        observedGeneration: 1,
        deliveryMode: "inline",
        conditions: [{ type: "Ready", status: "True", reason: "InlineResolved", message: "SKILL.md delivered as a ConfigMap" }],
      },
    },
    {
      // Git source with no ref: cloned from the default branch on every run,
      // so the run is not reproducible — the modal warns about exactly this.
      metadata: { name: "acme-conventions", creationTimestamp: ago(120), labels: { [MANAGED]: "true" } },
      spec: {
        source: "https://github.com/acme/migration-skills.git",
        subPath: "skills/conventions",
        displayName: "Acme conventions",
        description: "Acme's naming and layout conventions for migrated services.",
        type: "skill",
        tags: ["conventions", "acme"],
      },
      status: {
        observedGeneration: 1,
        deliveryMode: "source",
        conditions: [{ type: "Ready", status: "True", reason: "SourceAccepted", message: "Cloned at pod start; ref unset, default branch" }],
      },
    },
    {
      // Inline content without the frontmatter block: the skill loader
      // refuses it, and the console must show why.
      metadata: { name: "broken-inline", creationTimestamp: ago(30), labels: { [MANAGED]: "true" } },
      spec: {
        inline: ["# Broken skill", "", "Saved without the YAML frontmatter the Agent Skills spec requires.", ""].join("\n"),
        description: "An inline card the skill loader rejected.",
        type: "skill",
      },
      status: {
        observedGeneration: 1,
        conditions: [{ type: "Ready", status: "False", reason: "InvalidSkillContent", message: "no YAML frontmatter: file does not start with ---" }],
      },
    },
    {
      // Pre-#157 card: image only, no type, status without deliveryMode.
      // Applied with kubectl before the hub fronted the API, so no managed
      // label either.
      metadata: { name: "legacy-card", creationTimestamp: ago(800) },
      spec: { image: "ghcr.io/ibolton336/legacy-skill:v1", description: "A card from before the skill loader." },
      status: {
        observedGeneration: 1,
        resolvedImage: "ghcr.io/ibolton336/legacy-skill:v1",
        conditions: [{ type: "Ready", status: "True", reason: "ImageResolved", message: "OCI image ref accepted: ghcr.io/ibolton336/legacy-skill:v1" }],
      },
    },
    {
      metadata: { name: "analyze-issues", creationTimestamp: ago(390), labels: { [MANAGED]: "true" } },
      spec: {
        image: "ghcr.io/ibolton336/analyze-issues-skill:demo",
        displayName: "Analyze issues",
        description: "Fetch and rank analysis insights.",
        type: "skill",
        version: "0.3.0",
        tags: ["analysis"],
      },
      status: imageCardStatus("ghcr.io/ibolton336/analyze-issues-skill:demo"),
    },
  ],
  skillcollections: [
    {
      // Explicit mode: three cards grouped by reference.
      metadata: { name: "java-migration", creationTimestamp: ago(390), labels: { [MANAGED]: "true" } },
      spec: {
        version: "2.0.0",
        skills: [
          { name: "plan", skillCardRef: "plan" },
          { name: "javaee-to-quarkus", skillCardRef: "javaee-to-quarkus" },
          { name: "house-rules", skillCardRef: "house-rules" },
        ],
      },
      status: {
        observedGeneration: 1,
        resolvedSkills: ["plan", "javaee-to-quarkus", "house-rules"],
        conditions: [{ type: "Ready", status: "True", reason: "AllSkillsReady", message: "3 skills resolved" }],
      },
    },
    {
      // Enumerate mode (#157): the controller listed the bundle image. Two
      // of the four names (execute, verify) have no SkillCard here, so the
      // drawer's link-if-the-card-exists path sees both cases.
      metadata: { name: "konveyor-bundle", creationTimestamp: ago(200), labels: { [MANAGED]: "true" } },
      spec: { image: "quay.io/konveyor/skills:latest", type: "skill" },
      status: {
        observedGeneration: 1,
        resolvedSkills: ["plan", "execute", "verify", "javaee-to-quarkus"],
        conditions: [{ type: "Ready", status: "True", reason: "Enumerated", message: "4 skills enumerated from quay.io/konveyor/skills:latest" }],
      },
    },
  ],
  gateways: [
    {
      metadata: { name: "default-gateway", creationTimestamp: ago(500) },
      spec: {
        provider: "aws-bedrock",
        endpoint: "https://bedrock-runtime.us-east-1.example",
        credentialRef: { secretName: "bedrock-creds" },
        model: { name: "us.anthropic.claude-sonnet-4-5", contextWindow: 200000 },
      },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    },
    {
      // agentic-controller#167: a native gcp-vertex-ai endpoint serves no
      // GET /v1/models, so the verification Job fails for good and the
      // Gateway parks at Ready=False/ConnectionFailed — the console names
      // the hold instead of a bare Not Ready.
      metadata: { name: "vertex-gateway", creationTimestamp: ago(400) },
      spec: {
        provider: "gcp-vertex-ai",
        endpoint: "https://us-central1-aiplatform.googleapis.com",
        credentialRef: { secretName: "vertex-creds", key: "service-account.json" },
        model: { name: "gemini-2.5-pro", contextWindow: 1048576, tier: "premium" },
      },
      status: {
        connectionVerified: false,
        conditions: [{ type: "Ready", status: "False", reason: "ConnectionFailed", message: 'Verification Job "vertex-gateway-verify-k2m9x" failed' }],
      },
    },
    {
      // Verification in flight: Ready=False/Verifying is a plain wait.
      metadata: { name: "openai-proxy", creationTimestamp: ago(1) },
      spec: {
        provider: "openai",
        endpoint: "https://llm-proxy.konveyor.svc:8321/v1",
        credentialRef: { secretName: "llm-proxy-key", key: "api-key" },
        model: { name: "gpt-4.1", contextWindow: 1000000 },
      },
      status: {
        conditions: [{ type: "Ready", status: "False", reason: "Verifying", message: "Verification Job created" }],
      },
    },
  ],
  workflows: [
    {
      // Every stage Agent declares no gateways: the run must name one.
      metadata: { name: "template-flow", creationTimestamp: ago(10), labels: { [MANAGED]: "true" } },
      spec: {
        guide: "Two stages on a gateway-less template agent.",
        stages: [
          { name: "assess", agentRef: "template-agent", instructions: "Assess." },
          { name: "remediate", agentRef: "template-agent", instructions: "Remediate." },
        ],
      },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    },
    {
      metadata: {
        name: "java-ee-to-quarkus",
        creationTimestamp: ago(240),
        labels: { [MANAGED]: "true" },
      },
      spec: {
        stages: [
          { name: "assess", agentRef: "migration-analyzer" },
          { name: "execute", agentRef: "freeform-agent" },
        ],
      },
      status: {
        conditions: [{ type: "Ready", status: "True", reason: "AgentsReady", message: "all stage agents ready" }],
      },
    },
    {
      // No status at all — the modal treats this as selectable (fails open).
      metadata: { name: "patternfly-migration", creationTimestamp: ago(180), labels: { [MANAGED]: "true" } },
      spec: { stages: [{ name: "migrate", agentRef: "freeform-agent" }] },
    },
    {
      // Ready per its status, but the stage references an agent that does
      // not exist — name refs fail at run, so the launch preflight must
      // name the dangling agent instead of fanning out doomed runs.
      metadata: { name: "dangling-stage-workflow", creationTimestamp: ago(60), labels: { [MANAGED]: "true" } },
      spec: { stages: [{ name: "migrate", agentRef: "ghost-agent" }] },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    },
  ],
  agentruns: [
    {
      // Running + populated status: the chat panel should dial the WS.
      metadata: {
        name: "single-run-coolstore",
        creationTimestamp: ago(120),
        labels: { [MANAGED]: "true", [APPLICATION]: "1" },
      },
      spec: { agentRef: "migration-analyzer", gateway: "default-gateway" },
      status: {
        phase: "Running",
        startTime: ago(120),
        sandboxName: "sandbox-coolstore-x1",
        secretKeyRef: { name: "sandbox-coolstore-x1-key" },
        conditions: [acpCond(true)],
      },
    },
    {
      // Scripted (SCRIPTED below): Pending -> Running with ACPReady=False
      // -> ACPReady=True. The chat panel must wait on the condition, then
      // connect on its first dial.
      metadata: {
        name: "boot-race-run",
        creationTimestamp: ago(1),
        labels: { [MANAGED]: "true", [APPLICATION]: "1" },
      },
      spec: { agentRef: "migration-analyzer", gateway: "default-gateway" },
      status: { phase: "Pending" },
    },
    {
      // Scripted: like boot-race-run but from a pre-#160 controller (no
      // ACPReady ever). The console dials on that condition and nothing
      // else now, so this run stays on its "no ACPReady condition"
      // notice — never dialed, never failed — until it finishes.
      metadata: {
        name: "legacy-boot-race-run",
        creationTimestamp: ago(1),
        labels: { [MANAGED]: "true", [APPLICATION]: "1" },
      },
      spec: { agentRef: "migration-analyzer", gateway: "default-gateway" },
      status: { phase: "Pending" },
    },
    {
      // Scripted: Running with ACPReady=False, then finishes before it ever
      // listens. The panel must land on "finished", not "failed".
      metadata: {
        name: "boot-race-finishes",
        creationTimestamp: ago(1),
        labels: { [MANAGED]: "true", [APPLICATION]: "1" },
      },
      spec: { agentRef: "migration-analyzer", gateway: "default-gateway" },
      status: {
        phase: "Running",
        startTime: ago(1),
        sandboxName: "sandbox-race-x2",
        secretKeyRef: { name: "sandbox-race-x2-key" },
      },
    },
    {
      // Scripted: connects, but the relay drops the socket a few seconds
      // after each session/new — the panel's bounded auto-reconnect.
      metadata: {
        name: "flaky-run",
        creationTimestamp: ago(5),
        labels: { [MANAGED]: "true", [APPLICATION]: "1" },
      },
      spec: { agentRef: "migration-analyzer", gateway: "default-gateway" },
      status: {
        phase: "Running",
        startTime: ago(5),
        sandboxName: "sandbox-flaky-x3",
        secretKeyRef: { name: "sandbox-flaky-x3-key" },
        conditions: [acpCond(true)],
      },
    },
    // The three steer-* runs speak the tee's side of a LIVE run (see
    // STEER_RUNS): the run's own session streams to every viewer and
    // `_goose/unstable/session/steer` / `session/cancel` naming it are
    // relayed (or refused) the way the harness does.
    ...["steer-run", "steer-late-run", "steer-off-run", "ask-run"].map((name, i) => ({
      metadata: {
        name,
        creationTimestamp: ago(3),
        labels: { [MANAGED]: "true", [APPLICATION]: "1" },
      },
      spec: { agentRef: "migration-analyzer", gateway: "default-gateway" },
      status: {
        phase: "Running",
        startTime: ago(3),
        sandboxName: `sandbox-steer-x${i + 1}`,
        secretKeyRef: { name: `sandbox-steer-x${i + 1}-key` },
        conditions: [acpCond(true)],
      },
    })),
    {
      // Live run of an agent that carries skills (STEER_RUNS below): the
      // transcript streams goose's load_skill calls and the run then
      // finishes as Succeeded — restart the mock to replay.
      metadata: {
        name: "skills-run-coolstore",
        creationTimestamp: ago(2),
        labels: { [MANAGED]: "true", [APPLICATION]: "1" },
      },
      spec: { agentRef: "migration-analyzer", gateway: "default-gateway" },
      status: {
        phase: "Running",
        startTime: ago(2),
        sandboxName: "sandbox-skills-x5",
        secretKeyRef: { name: "sandbox-skills-x5-key" },
        conditions: [acpCond(true)],
      },
    },
    {
      // Belongs to app 3 — must NOT appear in app 1's drawer tab.
      metadata: {
        name: "run-testapp-done",
        creationTimestamp: ago(60),
        labels: { [MANAGED]: "true", [APPLICATION]: "3" },
      },
      spec: { agentRef: "freeform-agent" },
      status: { phase: "Succeeded", startTime: ago(60), completionTime: ago(55) },
    },
    {
      // Pre-label-era run (no application label) — per-application views and
      // the runs-page application filter must leave it out, never crash on it.
      metadata: {
        name: "legacy-run-nolabel",
        creationTimestamp: ago(300),
        labels: { [MANAGED]: "true" },
      },
      spec: { agentRef: "freeform-agent" },
      status: {
        phase: "Failed",
        startTime: ago(300),
        completionTime: ago(295),
        conditions: [{ type: "Ready", status: "False", reason: "Failed", message: "Sandbox finished with reason: Error", lastTransitionTime: ago(295) }],
      },
    },
    {
      // Never started: the controller parks a run whose Agent is not Ready
      // on Ready=False/AgentNotReady, phase stays Pending (no sandbox).
      metadata: {
        name: "run-blocked-agent-not-ready",
        creationTimestamp: ago(30),
        labels: { [MANAGED]: "true", [APPLICATION]: "3" },
      },
      spec: { agentRef: "ghost-agent" },
      status: {
        phase: "Pending",
        conditions: [{ type: "Ready", status: "False", reason: "AgentNotReady", message: 'Agent "ghost-agent" is not Ready', lastTransitionTime: ago(30) }],
      },
    },
    {
      // Finished before its Agent stopped being Ready (the gateway broke
      // afterwards): "Run again" prefills the modal with an agent it must
      // refuse to submit, saying why.
      metadata: {
        name: "run-earlier-coolstore",
        creationTimestamp: ago(120),
        labels: { [MANAGED]: "true", [APPLICATION]: "1" },
      },
      spec: { agentRef: "coolstore-quarkus-migrator", gateway: "vertex-gateway" },
      status: {
        phase: "Failed",
        sandboxName: "sandbox-earlier-x7",
        startTime: ago(119),
        completionTime: ago(100),
        conditions: [{ type: "Ready", status: "False", reason: "Failed", message: "Sandbox finished with reason: Error", lastTransitionTime: ago(100) }],
      },
    },
  ],
  workflowruns: [
    {
      metadata: {
        name: "upgrade-run-1",
        creationTimestamp: ago(10),
        labels: { [MANAGED]: "true", [APPLICATION]: "1" },
      },
      spec: { workflowRef: "java-ee-to-quarkus" },
      status: { phase: "Running", startTime: ago(10) },
    },
    {
      // Second application so the workflow-runs application filter has two
      // buckets to separate.
      metadata: {
        name: "modernize-testapp",
        creationTimestamp: ago(90),
        labels: { [MANAGED]: "true", [APPLICATION]: "3" },
      },
      spec: { workflowRef: "patternfly-migration" },
      status: {
        phase: "Succeeded",
        startTime: ago(90),
        completionTime: ago(70),
        stages: [{ name: "migrate", phase: "Succeeded" }],
      },
    },
    {
      // A stage failed: the workflow run fails with StageFailed naming it.
      metadata: {
        name: "upgrade-run-failed",
        creationTimestamp: ago(200),
        labels: { [MANAGED]: "true", [APPLICATION]: "1" },
      },
      spec: { workflowRef: "java-ee-to-quarkus" },
      status: {
        phase: "Failed",
        startTime: ago(200),
        completionTime: ago(190),
        stages: [
          { name: "assess", phase: "Succeeded", agentRunName: "run-testapp-done" },
          { name: "migrate", phase: "Failed", agentRunName: "legacy-run-nolabel" },
        ],
        conditions: [{ type: "Ready", status: "False", reason: "StageFailed", message: 'Stage "migrate" failed: AgentRun "legacy-run-nolabel" Failed', lastTransitionTime: ago(190) }],
      },
    },
  ],
};

// Run kinds are create-only (no PUT/DELETE) — hub parity.
const CONFIG_KINDS = ["agents", "skills", "skillcollections", "gateways", "workflows"];
const RUN_KINDS = ["agentruns", "workflowruns"];

let createCounter = 0;

const applications = [
  {
    id: 1,
    name: "coolstore",
    description: "Java EE monolith storefront",
    repository: { kind: "git", url: "https://github.com/ibolton336/coolstore.git", branch: "main" },
    // Source-role credential assigned — the push-preflight happy case.
    identities: [{ id: 900, name: "coolstore-github-pat", role: "source" }],
    tags: [],
  },
  { id: 2, name: "binary-only-app", description: "No repository — the bulk-run exclusion case", tags: [] },
  {
    id: 3,
    name: "tackle-testapp",
    description: "Test app on a develop branch",
    // No identities — eligible to launch, but the modal must warn the push
    // will be denied (the fleet-smoke 3-of-4 failure mode).
    repository: { kind: "git", url: "https://github.com/konveyor/tackle-testapp.git", branch: "develop" },
    tags: [],
  },
];

// Archetypes exercise the archetype-row "Run agent workflow" fan-out: launching
// against JavaEE Monolith opens the bulk modal populated with its three members
// — coolstore (eligible + credential), tackle-testapp (eligible, push-warning),
// binary-only-app (excluded, no repository). The empty archetype proves the
// action is disabled when there are no members.
const archetypes = [
  {
    id: 1,
    name: "JavaEE Monolith",
    description: "Java EE apps to migrate to Quarkus",
    criteria: [{ tag: "Java" }],
    applications: [
      { id: 1, name: "coolstore" },
      { id: 2, name: "binary-only-app" },
      { id: 3, name: "tackle-testapp" },
    ],
    assessed: false,
    assessments: [],
  },
  {
    id: 2,
    name: "Empty Archetype",
    description: "No members — the disabled run-action case",
    criteria: [],
    applications: [],
    assessed: false,
    assessments: [],
  },
];

// ------------------------------------------------------------------ helpers

const readBody = (req) =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });

const send = (res, status, body) => {
  if (body === undefined) {
    res.writeHead(status);
    return res.end();
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

// CRD rules the apiserver enforces on SkillCard / SkillCollection specs
// (#157 shape) — the hub passes the 422 through, so the console must meet
// the same refusal here. Presence counts, not truthiness (CEL has()
// parity): a leftover `image: ""` beside `inline` is still two sources.
// SkillCard `tags` is `x-kubernetes-list-type: set`: duplicates are refused.
const specError = (kind, name, spec) => {
  const has = (field) => spec?.[field] !== undefined;
  const rule = (crd, path, detail) => `${crd}.konveyor.io "${name}" is invalid: ${path}: Invalid value: ${detail}`;
  if (kind === "skills" && ["image", "source", "inline"].filter(has).length !== 1)
    return rule("SkillCard", "spec", '"object": exactly one of image, source, or inline must be set');
  if (kind === "skills" && Array.isArray(spec?.tags)) {
    const dup = spec.tags.findIndex((tag, i) => spec.tags.indexOf(tag) !== i);
    if (dup >= 0)
      return `SkillCard.konveyor.io "${name}" is invalid: spec.tags[${dup}]: Duplicate value: ${JSON.stringify(spec.tags[dup])}`;
  }
  if (kind === "skillcollections") {
    if (has("image") === has("skills")) return rule("SkillCollection", "spec", '"object": set either image or skills, not both');
    if (has("skills") && !(Array.isArray(spec.skills) && spec.skills.length > 0))
      return rule("SkillCollection", "spec.skills", "0: spec.skills in body should have at least 1 items");
  }
  return undefined;
};

// ------------------------------------------------- scripted run timelines

// Timelines are relative to the first GET of the run's detail (t0), so
// each page open replays the script from the top until the mock restarts.
// `status(ms)` overrides the fixture's status; `acp(ms)` says what the
// relay does to a dial at that instant:
//   "listening" — the pod's :4000 is up: speak ACP
//   "refused"   — hub-relay parity for a pod that isn't listening yet:
//                 Relay() upgrades the browser socket, its own dial to the
//                 sandbox fails, it returns and the deferred Close() drops
//                 the browser socket with no close frame
//   "flaky"     — listening, but the socket is dropped FLAKY_DROP_MS after
//                 session/new
const RACE_RUNNING_MS = 6_000; // boot-race-run: Pending -> Running
const RACE_LISTENING_MS = 18_000; // boot-race-run: :4000 comes up
const FINISHES_AT_MS = 12_000; // boot-race-finishes: Running -> Succeeded
const FLAKY_DROP_MS = 8_000;

const SCRIPTED = {
  "boot-race-run": {
    // #160 controller: Pending (pod not running) -> Running with
    // ACPReady=False while the agent boots -> ACPReady=True.
    status: (ms) =>
      ms < RACE_RUNNING_MS
        ? { phase: "Pending" }
        : {
            phase: "Running",
            startTime: new Date(Date.now() - (ms - RACE_RUNNING_MS)).toISOString(),
            sandboxName: "sandbox-race-x1",
            secretKeyRef: { name: "sandbox-race-x1-key" },
            conditions: [acpCond(ms >= RACE_LISTENING_MS)],
          },
    acp: (ms) => (ms < RACE_LISTENING_MS ? "refused" : "listening"),
  },
  "boot-race-finishes": {
    // #160 controller: Running + ACPReady=False, then Succeeded before it
    // ever listened (ACPReady=False/Finished).
    status: (ms) =>
      ms < FINISHES_AT_MS
        ? {
            phase: "Running",
            startTime: new Date(Date.now() - ms).toISOString(),
            sandboxName: "sandbox-race-x2",
            secretKeyRef: { name: "sandbox-race-x2-key" },
            conditions: [acpCond(false)],
          }
        : {
            phase: "Succeeded",
            startTime: new Date(Date.now() - ms).toISOString(),
            completionTime: new Date(Date.now() - (ms - FINISHES_AT_MS)).toISOString(),
            sandboxName: "sandbox-race-x2",
            secretKeyRef: { name: "sandbox-race-x2-key" },
            conditions: [{ type: "ACPReady", status: "False", reason: "Finished", message: "The run has finished; its ACP endpoint is gone" }],
          },
    acp: () => "refused",
  },
  "legacy-boot-race-run": {
    // Pre-#160 controller: Running the moment the Sandbox exists, no
    // ACPReady at all — the console must NOT dial (the acp() script is
    // kept so a regression that dials again is visible in the log).
    status: (ms) =>
      ms < RACE_RUNNING_MS
        ? { phase: "Pending" }
        : {
            phase: "Running",
            startTime: new Date(Date.now() - (ms - RACE_RUNNING_MS)).toISOString(),
            sandboxName: "sandbox-race-x4",
            secretKeyRef: { name: "sandbox-race-x4-key" },
          },
    acp: (ms) => (ms < RACE_LISTENING_MS ? "refused" : "listening"),
  },
  "flaky-run": { acp: () => "flaky" },
};
const scriptStart = new Map(); // run name -> t0 (epoch ms)
const scriptClock = (name, start = false) => {
  if (!SCRIPTED[name]) return undefined;
  if (start && !scriptStart.has(name)) {
    scriptStart.set(name, Date.now());
    console.log(`[hub] SCRIPT ${name}: t0`);
  }
  return scriptStart.has(name) ? Date.now() - scriptStart.get(name) : 0;
};
// Status overrides set by ACP events (a viewer's cancel fails the run).
const runOverrides = new Map(); // run name -> status
// The run as the hub would serve it right now (scripted status applied).
const runView = (run, start = false) => {
  const ms = scriptClock(run.metadata.name, start);
  const status = ms === undefined ? undefined : SCRIPTED[run.metadata.name].status?.(ms);
  const view = status ? { ...run, status } : run;
  const override = runOverrides.get(run.metadata.name);
  return override ? { ...view, status: { ...view.status, ...override } } : view;
};
const acpBehavior = (name) => {
  const ms = scriptClock(name);
  return ms === undefined ? "listening" : SCRIPTED[name].acp(ms);
};

// -------------------------------------------------------------- mock hub

const hub = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  console.log(`[hub] ${req.method} ${req.url}`);

  // ---- core inventory ----
  if (req.method === "GET" && p === "/applications") return send(res, 200, applications);
  if (req.method === "GET" && p === "/archetypes") return send(res, 200, archetypes);
  {
    const am = /^\/archetypes\/(\d+)$/.exec(p);
    if (req.method === "GET" && am) {
      const found = archetypes.find((a) => a.id === Number(am[1]));
      return found ? send(res, 200, found) : send(res, 404, { error: "not found" });
    }
  }

  // ---- agentic surface ----
  const m = /^\/agentic\/([a-z]+)(?:\/([^/]+))?(\/acp(?:\/nonce)?)?$/.exec(p);
  if (m) {
    const [, kind, name, acp] = m;
    const known = CONFIG_KINDS.includes(kind) || RUN_KINDS.includes(kind);
    if (!known) return send(res, 404, { error: `unknown agent resource "${kind}"` });
    const list = store[kind];

    if (acp === "/acp/nonce") {
      // Hub parity: POST-only, Gets the run first (404 when absent), 201
      // with the JSON-encoded nonce string as the created resource.
      if (kind !== "agentruns" || !name)
        return send(res, 404, { error: "nonce is minted per agent run" });
      if (req.method !== "POST")
        return send(res, 405, { error: "nonce mint is POST-only" });
      if (!list.some((r) => r.metadata.name === name))
        return send(res, 404, { error: `${kind}/${name} not found` });
      const nonce = issueNonce();
      console.log(`[hub] NONCE minted for ${name}: ${nonce}`);
      return send(res, 201, nonce);
    }

    if (acp) return send(res, 400, { error: "acp is websocket-only (see upgrade handler)" });

    if (req.method === "GET" && !name) return send(res, 200, list.map((r) => runView(r)));
    if (req.method === "GET") {
      const item = list.find((r) => r.metadata.name === name);
      return item
        ? send(res, 200, runView(item, true))
        : send(res, 404, { error: `${kind}/${name} not found` });
    }

    if (req.method === "POST" && !name) {
      const raw = await readBody(req);
      console.log(`[hub] CREATE ${kind} body: ${raw}`);
      let cr;
      try {
        cr = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: "invalid JSON" });
      }
      if (!cr?.metadata || (!cr.metadata.name && !cr.metadata.generateName))
        return send(res, 400, { error: "metadata.name or metadata.generateName required" });
      if (cr.metadata.generateName && !cr.metadata.name)
        cr.metadata.name = `${cr.metadata.generateName}${(++createCounter).toString(36)}${crypto.randomBytes(2).toString("hex")}`;
      const invalid = specError(kind, cr.metadata.name, cr.spec);
      if (invalid) {
        console.log(`[hub] REJECT ${kind}/${cr.metadata.name}: ${invalid}`);
        return send(res, 422, { error: invalid });
      }
      cr.metadata.creationTimestamp = now();
      cr.metadata.labels = { ...(cr.metadata.labels ?? {}), [MANAGED]: "true" }; // hub injectLabels parity
      if (list.some((r) => r.metadata.name === cr.metadata.name))
        return send(res, 409, { error: `${kind}/${cr.metadata.name} already exists` });
      list.push(cr);
      return send(res, 201, cr);
    }

    if (req.method === "PUT" && name && CONFIG_KINDS.includes(kind)) {
      const raw = await readBody(req);
      console.log(`[hub] UPDATE ${kind}/${name} body: ${raw}`);
      const idx = list.findIndex((r) => r.metadata.name === name);
      if (idx < 0) return send(res, 404, { error: `${kind}/${name} not found` });
      let cr;
      try {
        cr = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: "invalid JSON" });
      }
      const invalid = specError(kind, name, cr.spec ?? list[idx].spec);
      if (invalid) {
        console.log(`[hub] REJECT ${kind}/${name}: ${invalid}`);
        return send(res, 422, { error: invalid });
      }
      list[idx] = { ...list[idx], spec: cr.spec ?? list[idx].spec };
      return send(res, 204); // hub returns 204 NO BODY on update
    }

    if (req.method === "DELETE" && name && CONFIG_KINDS.includes(kind)) {
      const idx = list.findIndex((r) => r.metadata.name === name);
      if (idx < 0) return send(res, 404, { error: `${kind}/${name} not found` });
      list.splice(idx, 1);
      return send(res, 204);
    }

    // PUT/DELETE on run kinds, or anything else: no such route on the hub.
    return send(res, 405, { error: `no ${req.method} route for /agentic/${kind}` });
  }

  // Everything else the inventory screens enumerate (tags, archetypes,
  // assessments, waves, trackers, tasks, ...) tolerates an empty list.
  if (req.method === "GET") {
    console.log(`[hub] catch-all [] for ${p}`);
    return send(res, 200, []);
  }
  return send(res, 200, {});
});

// ------------------------------------------------ websocket frames (RFC 6455)

// Server->client frames are unmasked; lengths up to 64 KiB are plenty here.
const wsFrame = (opcode, payload = Buffer.alloc(0)) => {
  const len = payload.length;
  const head =
    len < 126
      ? Buffer.from([0x80 | opcode, len])
      : Buffer.concat([Buffer.from([0x80 | opcode, 126]), Buffer.from([len >> 8, len & 0xff])]);
  return Buffer.concat([head, payload]);
};
const wsText = (obj) => wsFrame(0x1, Buffer.from(JSON.stringify(obj)));
const wsClose = () => wsFrame(0x8, Buffer.from([0x03, 0xe8])); // 1000

// Client->server frames are always masked. Yields {opcode, payload} per
// complete frame; leaves partial frames in the buffer.
const wsParse = (buf) => {
  const frames = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const opcode = buf[off] & 0x0f;
    const masked = (buf[off + 1] & 0x80) !== 0;
    let len = buf[off + 1] & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    const mask = masked ? buf.subarray(p, p + 4) : null;
    if (masked) p += 4;
    if (buf.length - p < len) break;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    frames.push({ opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
};

// -------------------------------------------------------- ACP responder

// Just enough of the agent side of ACP for the chat panel: initialize,
// session/new, session/prompt (canned reply), session/cancel. session/load
// is refused so a reconnect falls back to session/new (what a fresh goose
// would do). "flaky" drops the socket FLAKY_DROP_MS after session/new.
// ---- the tee's side of a live run (agentic-controller#96), for steer-* runs
//
// Every viewer attached to one of these runs gets the RUN session's frames
// (harness plan ladder replayed on attach, then a slow agent stream) on top
// of its own private session. Frames naming the run session are handled
// the way the tee relays them to goose (v1.45.0 shapes, source-verified):
//   - `_goose/unstable/session/steer` {sessionId, expectedRunId, prompt}
//       -> {runId, messageId}; a session_info_update with
//          _meta.goose.queuedSteer; STEER_PICKUP_MS later the pickup
//          streams as user_message_chunk flagged _meta.goose.steer and an
//          agent acknowledgement. Empty/stale expectedRunId -> -32602 with
//          goose's data (the stale case names the actual run id, which is
//          how a late viewer learns it); no active run -> -32602 too.
//   - `session/cancel` naming the run session ends the turn: activeRunId
//       null, the run's status flips to Failed (human abort != success).
// Variants: "early" announces activeRunId right after attach (the viewer
// was there when the turn started); "late" never does (the turn started
// before the viewer attached — the tee replays only harness frames, so the
// id must be discovered); "off" mirrors HARNESS_HITL_STEER=off (steer
// -32601, cancel dropped).
//   - a steer that asks to pause / check in / report status / wait makes
//       the "agent" do what the harness guideline tells the model to do:
//       stop working and raise a question (elicitation/create with
//       continue / stop choices); the stream resumes when it is answered.
//   - `elicitation/create` (ask-run only): the "agent" asks the human a
//       question the way the harness's ask_user tool does — forwarded to
//       every viewer under a harness-style `kask-<n>` id (first an enum
//       question, then a free-text one after the first is answered); the
//       viewer's {action, content} answer is echoed into the stream; a
//       viewer attaching mid-question is shown the pending ask, as the tee
//       does.
//   - a `transcript` (skills-run-coolstore) replaces the endless ticker
//       with goose's stream for an Agent that carries skills (ADR 0014):
//       load_skill is an ordinary tool_call whose rawInput.name is the
//       skill, or skill/relative/file for a supporting file, and its
//       tool_call_update carries what goose returned; a plain shell call
//       follows, then the turn ends and the run flips to Succeeded.
const STEER_RUNS = {
  "steer-run": { variant: "early" },
  "steer-late-run": { variant: "late" },
  "steer-off-run": { variant: "off" },
  "ask-run": { variant: "early", ask: true },
  "skills-run-coolstore": { variant: "early", transcript: "skills" },
};
const ASK_FIRST_MS = 6_000; // ask-run: first question after attach
const ASK_SECOND_MS = 8_000; // ask-run: free-text follow-up after the first answer
const ASKS = [
  {
    message: "Which database should the migrated service target? The repo's persistence.xml names an EAP datasource; I can wire Quarkus to either.",
    requestedSchema: {
      type: "object",
      properties: { answer: { type: "string", title: "Answer", description: "Target database", enum: ["postgres", "mysql"] } },
      required: ["answer"],
    },
  },
  {
    message: "Anything I should know before I touch the persistence layer (naming conventions, tables to leave alone)?",
    requestedSchema: {
      type: "object",
      properties: { answer: { type: "string", title: "Answer", description: "Free text; leave empty for no preference" } },
      required: ["answer"],
    },
  },
];
// Transcripts are [ms, update] cues on agent time — the clock only runs
// while a viewer is attached and no ask is pending, like the ticker — and a
// null update ends the turn. The skills one is goose's turn with the
// javaee-to-quarkus skill available: load_skill, the supporting file it
// names, then ordinary work.
// The scripted runs' own configuration, as the harness would know it.
const RUN_BRANCH = "konveyor/migration-1755770000";
const RUN_MODEL = "us.anthropic.claude-sonnet-4-5";
const RUN_MAX_TURNS = 40;
const TRANSCRIPT_TICK_MS = 250;
const SKILL_DIR = "/home/harness/.agents/skills/javaee-to-quarkus";
const says = (text) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
// goose's custom channel (wire shape per goose-sdk-types custom_notifications.rs).
const CONTEXT_LIMIT = 200_000;
// MOCK_UNMETERED_CONTEXT=1: the shape goose's Bedrock provider sends on a real
// cluster (ROKS 2026-09-17) -- a context limit and cost, but `used` stuck at
// 0. The console must not show that as a reading ("0 / 200K").
const UNMETERED = process.env.MOCK_UNMETERED_CONTEXT === "1";
const usage = (used, inTok, outTok, cost) => ({
  sessionUpdate: "usage_update",
  used: UNMETERED ? 0 : used,
  contextLimit: CONTEXT_LIMIT,
  accumulatedInputTokens: inTok,
  accumulatedOutputTokens: outTok,
  ...(cost === undefined ? {} : { accumulatedCost: cost }),
});
const messageUsage = (messageId, inputTokens, outputTokens, cost) => ({
  sessionUpdate: "message_usage",
  messageId,
  usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cost, costSource: "estimated" },
});
const notice = (message) => ({ sessionUpdate: "status_message", status: { type: "notice", message } });
const progress = (message) => ({ sessionUpdate: "status_message", status: { type: "progress", message } });
const GOOSE = "_goose/unstable/session/update"; // cue channel marker
const calls = (toolCallId, title, kind, rawInput) => ({ sessionUpdate: "tool_call", toolCallId, title, kind, status: "in_progress", ...(rawInput ? { rawInput } : {}) });
const returns = (toolCallId, text) => ({ sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text } }] });
const TRANSCRIPTS = {
  skills: [
    [300, progress("Thinking…"), GOOSE],
    [500, says("Coolstore is a Java EE monolith and the stage asks for Quarkus. The javaee-to-quarkus skill covers exactly that — loading it before I touch anything. ")],
    [1_200, messageUsage("msg-1", 9_800, 120, 0.031), GOOSE],
    [1_200, usage(9_920, 9_800, 120, 0.031), GOOSE],
    [1_500, calls("ls-1", "load_skill", "other", { name: "javaee-to-quarkus" })],
    [
      2_500,
      returns(
        "ls-1",
        [
          "Migrates Java EE applications to Quarkus: javax.* to jakarta.*, EJBs to CDI beans, persistence.xml to application.properties.",
          "",
          "## Workflow",
          "",
          "1. Inventory javax.* imports and Java EE annotations module by module.",
          "2. Apply references/annotation-map.md; never invent a replacement that is not in the table.",
          "3. Move the datasource into application.properties and build with ./mvnw verify.",
          "",
          `Skill directory: ${SKILL_DIR}`,
          "Supporting files:",
          `  ${SKILL_DIR}/references/annotation-map.md`,
        ].join("\n")
      ),
    ],
    [3_200, messageUsage("msg-2", 11_400, 90, 0.036), GOOSE],
    [3_200, usage(21_410, 21_200, 210, 0.067), GOOSE],
    [3_500, says("The skill keeps its annotation table in a supporting file — loading that too. ")],
    [4_000, calls("ls-2", "load_skill", "other", { name: "javaee-to-quarkus/references/annotation-map.md" })],
    [
      5_000,
      returns(
        "ls-2",
        [
          "# Annotation map",
          "",
          "| Java EE | Quarkus |",
          "| --- | --- |",
          "| @Stateless | @ApplicationScoped |",
          "| @Stateful | @SessionScoped, or refactor to request scope |",
          "| @MessageDriven | @Incoming (SmallRye Reactive Messaging) |",
          "| @PersistenceContext EntityManager | @Inject EntityManager |",
          "| @EJB | @Inject |",
          "| javax.* | jakarta.* |",
        ].join("\n")
      ),
    ],
    [5_800, messageUsage("msg-3", 12_600, 70, 0.039), GOOSE],
    [5_800, usage(34_080, 33_800, 280, 0.106), GOOSE],
    [6_000, says("Inventorying javax.* usages before changing anything. ")],
    [6_500, calls("tc-1", `shell: rg -n "javax\." src/`, "execute")],
    [7_700, returns("tc-1", "23 matches in 6 files")],
    [9_000, says("23 usages in 6 files, all covered by the annotation map. Applying the mapping module by module, then pushing the branch. ")],
    [9_300, messageUsage("msg-4", 13_900, 260, 0.045), GOOSE],
    [9_300, usage(48_240, 47_700, 540, 0.151), GOOSE],
    // The harness's own tail: the final push as a harness tool call on the
    // run session, then its closing outcome notice (tee.EmitRunNotice).
    [9_800, calls("harness-push-1", `git push to branch ${RUN_BRANCH} (final)`, "execute")],
    [10_300, { sessionUpdate: "tool_call_update", toolCallId: "harness-push-1", status: "completed" }],
    [10_400, notice("stage succeeded — results pushed to branch konveyor/migration-1755770000"), GOOSE],
    [10_500, null],
  ],
};
const STEER_PICKUP_MS = 3_000;
const runStates = new Map(); // run name -> { sessionId, runId, active, viewers:Set<notify>, tick }
const runState = (name) => {
  if (!runStates.has(name)) {
    runStates.set(name, {
      sessionId: `run-session-${name}`,
      runId: `run_${crypto.randomUUID().slice(0, 8)}`,
      active: true,
      viewers: new Set(),
      tick: 0,
      askSeq: 0,
      pendingAsks: new Map(), // kask id -> frame (replayed to late viewers)
      askFollowUps: new Map(), // kask id -> fn run after its answer
      askTimer: undefined,
      paused: false, // blocked on an ask: the stream ticker idles
      played: 0, // transcript runs: ms of agent time streamed so far
      cue: 0, // transcript runs: index of the next cue
    });
  }
  return runStates.get(name);
};
const runUpdate = (st, update) => {
  for (const notify of st.viewers) {
    notify("session/update", { sessionId: st.sessionId, update });
  }
};
// goose's custom channel, teed to viewers unchanged (same params shape).
const gooseUpdate = (st, update) => {
  for (const notify of st.viewers) {
    notify(GOOSE, { sessionId: st.sessionId, update });
  }
};
// The harness's plan ladder (agentic-controller#230): every rung is built
// from the run's own configuration, and the middle one is re-emitted on
// every tool_call with progress against the turn budget. Each plan frame
// carries the whole ladder; the console replaces its card in place.
const PLAN = (agentStatus, turns = 0, pushStatus = "pending") => ({
  sessionUpdate: "plan",
  entries: [
    { content: "Prepare workspace: github.com/konveyor/coolstore on branch " + RUN_BRANCH + ", 49 analysis insights", status: "completed", priority: "medium" },
    {
      content:
        "Agent works the task: \u201cMigrate the coolstore Java EE services to Quarkus, module by module.\u201d (" +
        RUN_MODEL + ", " + (turns > 0 ? `turn ${turns} of ${RUN_MAX_TURNS}` : `up to ${RUN_MAX_TURNS} turns`) + ")",
      status: agentStatus,
      priority: "medium",
    },
    { content: "Push results to branch " + RUN_BRANCH, status: pushStatus, priority: "medium" },
  ],
});
// One turn per tool_call, as the harness counts them (TurnsUsed), and a
// fresh ladder each time — the tee keys plan frames so only the latest
// is replayed to late viewers.
const turnAdvanced = (st) => {
  st.turns = (st.turns ?? 0) + 1;
  runUpdate(st, PLAN("in_progress", st.turns));
};
// The agent asks the human: forward under kask-<n> to every viewer (and
// to anyone attaching while it waits), like the tee's ForwardElicitation.
const askHuman = (name, ask, { lead = "I need a decision from you before I continue. ", followUp } = {}) => {
  const st = runState(name);
  if (!st.active || !ask) return;
  const id = `kask-${++st.askSeq}`;
  const frame = { jsonrpc: "2.0", id, method: "elicitation/create", params: { sessionId: st.sessionId, mode: "form", ...ask } };
  st.pendingAsks.set(id, frame);
  st.askFollowUps.set(id, followUp);
  st.paused = true; // the agent's turn is blocked on the tool call
  console.log(`[hub] RUN ${name}: asking viewers ${id}: ${JSON.stringify(ask.message.slice(0, 60))}…`);
  runUpdate(st, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: lead } });
  runUpdate(st, { sessionUpdate: "tool_call", toolCallId: id, title: "ask_user", status: "in_progress", kind: "other" });
  for (const notify of st.viewers) notify.raw?.(frame);
};
const PAUSE_RE = /\b(pause|check in|check with me|status report|report status|wait|hold on|stop and confirm|confirm with me)\b/i;
const pauseAsk = (steerText) => ({
  message: `You asked me to pause ("${steerText.slice(0, 80)}"). Status: I have scanned ${"${N}"} modules for javax.* usages and found nothing blocking so far. How should I continue?`,
  requestedSchema: {
    type: "object",
    properties: { answer: { type: "string", title: "Answer", description: "Pick one", enum: ["continue as planned", "skip the remaining scans and summarize", "stop here"] } },
    required: ["answer"],
  },
});
const resolveAsk = (name, id, result) => {
  const st = runStates.get(name);
  if (!st || !st.pendingAsks.has(id)) {
    console.log(`[hub] RUN ${name}: late/duplicate answer for ${id} — ignoring`);
    return;
  }
  st.pendingAsks.delete(id);
  const followUp = st.askFollowUps.get(id);
  st.askFollowUps.delete(id);
  st.paused = st.pendingAsks.size > 0;
  const action = result?.action;
  const answer = result?.content?.answer;
  console.log(`[hub] RUN ${name}: ${id} ${action}${answer !== undefined ? `: ${JSON.stringify(answer)}` : ""}`);
  runUpdate(st, { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", content: [{ type: "content", content: { type: "text", text: action === "accept" ? `The human answered: ${answer ?? ""}` : "No answer given" } }] });
  if (action === "accept") {
    runUpdate(st, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Thanks — you answered "${answer ?? ""}". Continuing with that. ` } });
    if (/^stop/i.test(String(answer ?? ""))) endRunTurn(name, "stopped by human answer");
  } else {
    runUpdate(st, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Understood — no answer given; I'll proceed with my best judgement. " } });
  }
  followUp?.();
};
const attachRunStream = (name, notify) => {
  const st = runState(name);
  st.viewers.add(notify);
  // Harness replay ring: where the run stands, before anything live.
  notify("session/update", { sessionId: st.sessionId, update: PLAN(st.active ? "in_progress" : "completed", st.turns ?? 0, st.active ? "pending" : "completed") });
  // Pending questions go after the status frames, as the tee replays them.
  for (const frame of st.pendingAsks.values()) notify.raw?.(frame);
  if (STEER_RUNS[name].ask && st.askSeq === 0 && !st.askTimer && st.active) {
    st.askTimer = setTimeout(
      () => askHuman(name, ASKS[0], { followUp: () => { st.askTimer = setTimeout(() => askHuman(name, ASKS[1]), ASK_SECOND_MS); } }),
      ASK_FIRST_MS
    );
  }
  if (STEER_RUNS[name].variant === "early" && st.active) {
    // goose announced the active run when the turn started (the viewer saw it).
    setTimeout(() => {
      if (!st.viewers.has(notify)) return;
      notify("session/update", {
        sessionId: st.sessionId,
        update: { sessionUpdate: "session_info_update", _meta: { goose: { activeRunId: st.runId } } },
      });
    }, 800);
  }
  // A transcript run plays its cues once, on agent time; the null cue
  // ends the turn (endRunTurn flips the run to Succeeded).
  const cues = TRANSCRIPTS[STEER_RUNS[name].transcript];
  if (cues && !st.ticker && st.active) {
    st.ticker = setInterval(() => {
      if (!st.active || st.paused || st.viewers.size === 0) return;
      st.played += TRANSCRIPT_TICK_MS;
      while (st.active && st.cue < cues.length && cues[st.cue][0] <= st.played) {
        const [, update, channel] = cues[st.cue++];
        if (update === null) endRunTurn(name, "finished");
        else if (channel === GOOSE) gooseUpdate(st, update);
        else {
          runUpdate(st, update);
          if (update.sessionUpdate === "tool_call" && !String(update.toolCallId).startsWith("harness-")) turnAdvanced(st);
        }
      }
    }, TRANSCRIPT_TICK_MS);
  }
  // A slow agent stream so the transcript looks alive.
  if (!st.ticker && st.active) {
    st.ticker = setInterval(() => {
      if (!st.active || st.paused || st.viewers.size === 0) return;
      st.tick += 1;
      const n = st.tick;
      runUpdate(st, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Step ${n}: inspecting the next module… ` } });
      gooseUpdate(st, messageUsage(`msg-${n}`, 8_000 + n * 600, 90, 0.02 + n * 0.004));
      gooseUpdate(st, usage(8_000 + n * 1_200, 8_000 + n * 1_100, n * 90, 0.02 + n * 0.012));
      if (n % 3 === 0) gooseUpdate(st, progress(`Compacting context (${n} steps in)…`));
      runUpdate(st, { sessionUpdate: "tool_call", toolCallId: `tc-${n}`, title: `shell: rg -n "javax\." src/ (batch ${n})`, status: "in_progress", kind: "execute" });
      turnAdvanced(st);
      setTimeout(() => runUpdate(st, { sessionUpdate: "tool_call_update", toolCallId: `tc-${n}`, status: "completed", content: [{ type: "content", content: { type: "text", text: `${3 + n} matches` } }] }), 1200);
    }, 6_000);
  }
  return () => {
    st.viewers.delete(notify);
  };
};
const endRunTurn = (name, reason) => {
  const st = runState(name);
  if (!st.active) return;
  st.active = false;
  clearInterval(st.ticker);
  st.ticker = undefined;
  clearTimeout(st.askTimer);
  st.pendingAsks.clear();
  st.askFollowUps.clear();
  st.paused = false;
  runUpdate(st, { sessionUpdate: "session_info_update", _meta: { goose: { activeRunId: null } } });
  runUpdate(st, PLAN("completed", st.turns ?? 0, "in_progress"));
  // The harness's final push, then the ladder closes out.
  runUpdate(st, { sessionUpdate: "tool_call", toolCallId: "harness-push-final", title: `git push to branch ${RUN_BRANCH} (final)`, kind: "execute", status: "in_progress" });
  setTimeout(() => {
    runUpdate(st, { sessionUpdate: "tool_call_update", toolCallId: "harness-push-final", status: "completed" });
    runUpdate(st, PLAN("completed", st.turns ?? 0, "completed"));
  }, 700);
  console.log(`[hub] RUN ${name}: turn ended (${reason})`);
  // A played-out transcript succeeded; a human abort is not a success.
  if (reason === "cancelled" || reason === "finished") {
    runOverrides.set(name, {
      phase: reason === "finished" ? "Succeeded" : "Failed",
      completionTime: new Date().toISOString(),
      conditions: [{ type: "ACPReady", status: "False", reason: "Finished", message: "The run has finished; its ACP endpoint is gone" }],
    });
  }
};
// Handles a viewer frame that names the run session (returns true if consumed).
const interceptRunFrame = (name, msg, { reply, fail, notify }) => {
  const st = runStates.get(name);
  const { id, method, params } = msg;
  if (!st || params?.sessionId !== st.sessionId) return false;
  const { variant } = STEER_RUNS[name];
  switch (method) {
    case "_goose/unstable/session/steer": {
      if (variant === "off") {
        fail(id, -32601, "viewer steering is disabled by harness policy (HARNESS_HITL_STEER=off)");
        return true;
      }
      const expected = params.expectedRunId;
      const text = (params.prompt ?? []).map((b) => b?.text ?? "").join("");
      if (!expected) return fail(id, -32602, "Invalid params", "expectedRunId must not be empty"), true;
      if (!st.active) return fail(id, -32602, "Invalid params", "no active run to steer"), true;
      if (expected !== st.runId) {
        fail(id, -32602, "Invalid params", {
          message: `expected active run id \`${expected}\` but found \`${st.runId}\``,
          expectedRunId: expected,
          actualRunId: st.runId,
        });
        return true;
      }
      if (!text) return fail(id, -32602, "Invalid params", "prompt must not be empty"), true;
      const messageId = `steer_${crypto.randomUUID()}`;
      console.log(`[hub] RUN ${name}: steer queued ${messageId}: ${JSON.stringify(text)}`);
      reply(id, { runId: st.runId, messageId });
      runUpdate(st, { sessionUpdate: "session_info_update", _meta: { goose: { queuedSteer: { messageId, runId: st.runId } } } });
      setTimeout(() => {
        if (!st.active) return; // goose discards steers the turn never reached
        console.log(`[hub] RUN ${name}: steer picked up ${messageId}`);
        runUpdate(st, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text },
          messageId,
          _meta: { goose: { messageId, steer: true, created: Math.floor(Date.now() / 1000) } },
        });
        if (PAUSE_RE.test(text)) {
          // The guideline's contract: a pause/check-in redirect becomes a
          // blocking ask_user call; nothing else happens until it's answered.
          const ask = pauseAsk(text);
          ask.message = ask.message.replace("${N}", String(st.tick));
          askHuman(name, ask, { lead: `Pausing as you asked — ${text.slice(0, 60)}${text.length > 60 ? "…" : ""}. ` });
          return;
        }
        runUpdate(st, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Understood — redirecting: ${text.slice(0, 60)}${text.length > 60 ? "…" : ""}. ` } });
      }, STEER_PICKUP_MS);
      return true;
    }
    case "session/cancel":
      if (variant === "off") {
        console.log(`[hub] RUN ${name}: viewer cancel dropped — steering disabled`);
        return true;
      }
      console.log(`[hub] RUN ${name}: viewer cancelled the run session`);
      setTimeout(() => endRunTurn(name, "cancelled"), 500);
      return true;
    case "session/prompt":
      if (st.active) {
        fail(id, -32602, "session already has an active run; use _goose/unstable/session/steer");
        return true;
      }
      return false;
    default:
      return false;
  }
};

let sessionCounter = 0;
const speakAcp = (socket, name, behavior) => {
  let buf = Buffer.alloc(0);
  let dropTimer;
  let detachRun;
  const reply = (id, result) => socket.write(wsText({ jsonrpc: "2.0", id, result }));
  const fail = (id, code, message, data) =>
    socket.write(wsText({ jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } }));
  const notify = (method, params) => socket.write(wsText({ jsonrpc: "2.0", method, params }));
  notify.raw = (frame) => socket.write(wsText(frame)); // a harness-allocated ask (has its own id)
  if (STEER_RUNS[name]) detachRun = attachRunStream(name, notify);
  const handle = (msg) => {
    const { id, method, params } = msg;
    console.log(`[hub] ACP ${name} <- ${method ?? `response to ${id}`}${id === undefined ? " (notification)" : ""}`);
    // A viewer's answer to a harness-style ask never reaches goose's pipe.
    if (method === undefined && typeof id === "string" && id.startsWith("kask-")) {
      if (STEER_RUNS[name]) resolveAsk(name, id, msg.result);
      return;
    }
    if (STEER_RUNS[name] && interceptRunFrame(name, msg, { reply, fail, notify })) return;
    switch (method) {
      case "initialize":
        return reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: false } });
      case "session/new": {
        const sessionId = `mock-${name}-${++sessionCounter}`;
        reply(id, { sessionId });
        if (behavior === "flaky") {
          dropTimer = setTimeout(() => {
            console.log(`[hub] ACP ${name}: dropping socket (flaky)`);
            socket.end(); // no close frame — a dead relay, not a polite goodbye
          }, FLAKY_DROP_MS);
        }
        return;
      }
      case "session/load":
        return fail(id, -32601, "session/load not supported");
      case "session/prompt": {
        const sessionId = params?.sessionId;
        const chunk = (text) =>
          notify("session/update", {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
          });
        chunk("Mock agent here — ");
        setTimeout(() => chunk("I received your prompt."), 300);
        setTimeout(() => reply(id, { stopReason: "end_turn" }), 600);
        return;
      }
      case "session/cancel":
        return; // notification; the prompt still ends on its own
      case "_goose/unstable/session/steer":
        // A private session with nothing running: goose's own answer.
        return fail(id, -32602, "Invalid params", "no active run to steer");
      default:
        if (id !== undefined) fail(id, -32601, `unknown method ${method}`);
    }
  };
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const { frames, rest } = wsParse(buf);
    buf = rest;
    for (const f of frames) {
      if (f.opcode === 0x8) {
        socket.write(wsClose());
        return socket.end();
      }
      if (f.opcode === 0x9) {
        socket.write(wsFrame(0xa, f.payload));
        continue;
      }
      if (f.opcode !== 0x1) continue;
      try {
        handle(JSON.parse(f.payload.toString("utf8")));
      } catch (err) {
        console.log(`[hub] ACP ${name}: bad frame: ${err.message}`);
      }
    }
  });
  socket.on("close", () => {
    clearTimeout(dropTimer);
    detachRun?.();
  });
};

// WS upgrade for /agentic/agentruns/:name/acp?nonce=... — nonce is redeemed
// FIRST (hub parity: required in both auth modes), then RFC6455 handshake.
// What happens next is the run's script: speak ACP, or mirror the real
// relay when the pod isn't listening yet (101, then the socket just goes
// away — the ChatPanel has to re-dial through that, fresh nonce each time).
hub.on("upgrade", (req, socket) => {
  const u = new URL(req.url, "http://localhost");
  const m = /^\/agentic\/agentruns\/([^/]+)\/acp$/.exec(u.pathname);
  const key = req.headers["sec-websocket-key"];
  if (!m || !key) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    return socket.destroy();
  }
  const name = decodeURIComponent(m[1]);
  if (!redeemNonce(u.searchParams.get("nonce") ?? "")) {
    console.log(`[hub] WS refused (missing/stale/reused nonce): ${req.url}`);
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return socket.destroy();
  }
  const accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.on("error", () => {});
  const behavior = acpBehavior(name);
  console.log(`[hub] WS upgraded: ${req.url} (${behavior})`);
  if (behavior === "refused") return socket.end(); // relay's upstream dial failed
  speakAcp(socket, name, behavior);
});

// PORT override lets a second instance run beside the default one (e.g.
// two Claude sessions verifying different working trees on one machine).
const PORT = Number(process.env.PORT ?? 18090);
hub.listen(PORT, () => console.log(`mock hub on :${PORT} (core inventory + /agentic/*)`));
