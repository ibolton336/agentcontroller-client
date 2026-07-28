/**
 * Seeded default resources for POST /api/defaults.
 *
 * Two domain sets plus the image catalog ConfigMap — mirrors
 * hack/harness-test/resources.yaml from the controller repo and adds
 * the PatternFly-migration stretch demo. All resources carry
 * konveyor.io/managed: "true" so they appear in the UI. Create-only:
 * re-seeding never clobbers edits (existing resources are skipped).
 */
import { API_VERSION, GROUP, VERSION, PLURALS } from "../../agentrun-client/src/types.js";

interface SeedResource {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: Record<string, unknown>;
}

const NS = "konveyor-agents";
const MANAGED: Record<string, string> = { "konveyor.io/managed": "true" };

function cr(kind: string, name: string, spec: Record<string, unknown>, extra?: {
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}): SeedResource {
  return {
    apiVersion: API_VERSION,
    kind,
    metadata: {
      name,
      namespace: NS,
      labels: { ...MANAGED, ...extra?.labels },
      ...(extra?.annotations ? { annotations: extra.annotations } : {}),
    },
    spec,
  };
}

// -------------------------------------------------------- shared provider

const providerVertexAi = cr("LLMProvider", "gcp-vertex-ai", {
  endpoint: "global-aiplatform.googleapis.com",
  credentialRef: { secretName: "vertex-credentials" },
  models: [
    { name: "claude-sonnet-4-5", contextWindow: 200_000, tier: "premium" },
  ],
});

// ---------------------------------------- Java EE → Quarkus migration set

const skillJavaEeToQuarkus = cr("SkillCard", "javaee-to-quarkus", {
  displayName: "Java EE to Quarkus migration",
  description: "Analyzes Java EE / Jakarta dependencies and generates a Quarkus migration plan.",
  type: "skill",
  version: "0.1.0",
  tags: ["java", "migration", "quarkus"],
  image: "quay.io/konveyor/skill-javaee-to-quarkus:dev",
});

const skillPlan = cr("SkillCard", "plan-phase", {
  displayName: "Plan phase rules",
  description: "Constraints for the planning stage: read-only analysis, no code changes.",
  type: "rule",
  version: "0.1.0",
  tags: ["migration", "phase"],
  inline: "# Plan phase\n\n- Read-only: never modify source in the plan stage.\n- Produce a migration plan under .konveyor/plan.md.\n",
});

const skillExecute = cr("SkillCard", "execute-phase", {
  displayName: "Execute phase rules",
  description: "Constraints for the execution stage: apply the plan, commit each logical change.",
  type: "rule",
  version: "0.1.0",
  tags: ["migration", "phase"],
  inline: "# Execute phase\n\n- Apply changes from .konveyor/plan.md.\n- One logical change per commit.\n- Never remove tests.\n",
});

const skillVerify = cr("SkillCard", "verify-phase", {
  displayName: "Verify phase rules",
  description: "Constraints for the verification stage: build, test, validate the migration.",
  type: "rule",
  version: "0.1.0",
  tags: ["migration", "phase"],
  inline: "# Verify phase\n\n- Run the build system.\n- Run the test suite.\n- Report pass/fail under .konveyor/verify.md.\n",
});

const agentJavaAnalyzer = cr("Agent", "java-migration-analyzer", {
  image: "quay.io/konveyor/agent-java:dev",
  prompt: "You are a Java EE migration analyzer. Examine the application at /workspace and produce a migration plan under .konveyor/plan.md.",
  providers: [{ ref: "gcp-vertex-ai" }],
  params: [
    { name: "repository", type: "string", description: "Git URL of the application", required: true },
    { name: "branch", type: "string", description: "Branch to analyze", default: "main" },
    { name: "mode", type: "string", description: '"serve" or "batch"', default: "serve" },
  ],
}, {
  annotations: {
    "konveyor.io/param-sources": JSON.stringify({
      repository: "konveyor.io/application-repository-url",
      branch: "konveyor.io/application-repository-branch",
    }),
    "konveyor.io/credential-sources": JSON.stringify({
      git: "konveyor.io/application-identity",
    }),
  },
});

const agentJavaRemediator = cr("Agent", "java-migration-remediator", {
  image: "quay.io/konveyor/agent-java:dev",
  prompt: "You are a Java EE migration executor. Apply the plan from .konveyor/plan.md to the source at /workspace. Commit each logical change.",
  providers: [{ ref: "gcp-vertex-ai" }],
  params: [
    { name: "repository", type: "string", description: "Git URL of the application", required: true },
    { name: "branch", type: "string", description: "Working branch", default: "main" },
    { name: "mode", type: "string", description: '"serve" or "batch"', default: "batch" },
  ],
});

const agentJavaValidator = cr("Agent", "java-migration-validator", {
  image: "quay.io/konveyor/agent-java:dev",
  prompt: "You are a migration validator. Build and test the migrated application at /workspace. Report results to .konveyor/verify.md.",
  providers: [{ ref: "gcp-vertex-ai" }],
  params: [
    { name: "repository", type: "string", description: "Git URL of the application", required: true },
    { name: "branch", type: "string", description: "Working branch", default: "main" },
    { name: "mode", type: "string", description: '"serve" or "batch"', default: "batch" },
  ],
});

const playbookJavaEeToQuarkus = cr("AgentPlaybook", "javaee-to-quarkus", {
  guide: "Three-stage Java EE to Quarkus migration pipeline. All stages share the same branch and push their output back to it.",
  stages: [
    { name: "plan", agentRef: "java-migration-analyzer", instructions: "Stage 1: analyze the application and produce a migration plan." },
    { name: "execute", agentRef: "java-migration-remediator", instructions: "Stage 2: apply the migration plan from .konveyor/plan.md." },
    { name: "verify", agentRef: "java-migration-validator", instructions: "Stage 3: build and test the migrated application, report results." },
  ],
});

// ---------------------------------------- PatternFly migration set

const skillPatternFly = cr("SkillCard", "patternfly-migration", {
  displayName: "PatternFly 5 to 6 migration",
  description: "Guides PF5→PF6 migration: codemods, component API changes, token/CSS updates.",
  type: "skill",
  version: "0.1.0",
  tags: ["javascript", "typescript", "patternfly", "migration"],
  image: "quay.io/konveyor/skill-patternfly-migration:dev",
});

const agentPfAnalyzer = cr("Agent", "pf-migration-analyzer", {
  image: "quay.io/konveyor/agent-nodejs:dev",
  prompt: "You are a PatternFly migration analyzer. Examine the frontend application at /workspace and produce a PF5→PF6 migration plan.",
  providers: [{ ref: "gcp-vertex-ai" }],
  params: [
    { name: "repository", type: "string", description: "Git URL of the frontend application", required: true },
    { name: "branch", type: "string", description: "Branch to analyze", default: "main" },
    { name: "mode", type: "string", description: '"serve" or "batch"', default: "serve" },
  ],
});

const agentPfRemediator = cr("Agent", "pf-migration-remediator", {
  image: "quay.io/konveyor/agent-nodejs:dev",
  prompt: "You are a PatternFly migration executor. Apply the PF5→PF6 migration plan to the frontend at /workspace.",
  providers: [{ ref: "gcp-vertex-ai" }],
  params: [
    { name: "repository", type: "string", description: "Git URL of the frontend application", required: true },
    { name: "branch", type: "string", description: "Working branch", default: "main" },
    { name: "mode", type: "string", description: '"serve" or "batch"', default: "batch" },
  ],
});

const agentPfValidator = cr("Agent", "pf-migration-validator", {
  image: "quay.io/konveyor/agent-nodejs:dev",
  prompt: "You are a PatternFly migration validator. Build and test the migrated frontend at /workspace.",
  providers: [{ ref: "gcp-vertex-ai" }],
  params: [
    { name: "repository", type: "string", description: "Git URL of the frontend application", required: true },
    { name: "branch", type: "string", description: "Working branch", default: "main" },
    { name: "mode", type: "string", description: '"serve" or "batch"', default: "batch" },
  ],
});

const playbookPatternFly = cr("AgentPlaybook", "patternfly-migration", {
  guide: "Three-stage PatternFly 5→6 migration pipeline for frontend applications.",
  stages: [
    { name: "analyze", agentRef: "pf-migration-analyzer", instructions: "Stage 1: analyze the frontend and produce a PF5→PF6 migration plan." },
    { name: "migrate", agentRef: "pf-migration-remediator", instructions: "Stage 2: apply the migration plan — codemods, component API changes, token updates." },
    { name: "validate", agentRef: "pf-migration-validator", instructions: "Stage 3: build, lint, and test the migrated frontend." },
  ],
});

// -------------------------------------------------------- full seed set

export const SEED_RESOURCES: SeedResource[] = [
  providerVertexAi,
  // Java EE → Quarkus
  skillJavaEeToQuarkus, skillPlan, skillExecute, skillVerify,
  agentJavaAnalyzer, agentJavaRemediator, agentJavaValidator,
  playbookJavaEeToQuarkus,
  // PatternFly
  skillPatternFly,
  agentPfAnalyzer, agentPfRemediator, agentPfValidator,
  playbookPatternFly,
];

/** Plurals map for seeding — maps Kind to the k8s API plural. */
export const KIND_TO_PLURAL: Record<string, string> = {
  LLMProvider: PLURALS.LLMProvider,
  Agent: PLURALS.Agent,
  SkillCard: PLURALS.SkillCard,
  SkillCollection: PLURALS.SkillCollection,
  AgentPlaybook: PLURALS.AgentPlaybook,
  AgentPlaybookRun: PLURALS.AgentPlaybookRun,
};
