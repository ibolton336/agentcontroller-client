/**
 * Seed plan for POST /api/defaults.
 *
 * Two demo sets (Java EE → Quarkus, PatternFly 5→6) plus the image catalog
 * ConfigMap. The set is PLANNED per request, not a static list: agents bind
 * to the cluster's real Gateway (discovered, or pinned via SEED_GATEWAY)
 * and take their images from the resolved catalog. A set whose gateway or
 * image the cluster cannot supply is reported "skipped" with a reason —
 * never created broken. Gateways themselves are install-time
 * infrastructure (they need real credentials) and are never seeded here;
 * likewise inline SkillCards are excluded until the controller supports
 * inline sources (today they reconcile to Ready=False/InlineNotSupported).
 *
 * All resources carry konveyor.io/managed: "true" so they appear in the UI.
 * Create-only: re-seeding never clobbers edits (existing resources are
 * reported "exists" and left alone).
 */
import { API_VERSION, PLURALS } from "../../agentrun-client/src/types.js";

export interface SeedResource {
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

// ------------------------------------------------------------- plan inputs

export interface SeedImages {
  /** Resolved catalog ref for each language set's agents; absent = set skipped. */
  java?: string;
  nodejs?: string;
  /** Skill-content OCI refs (env-parameterized; not part of the agent catalog). */
  skillJavaEe: string;
  skillPatternFly: string;
}

export interface SeedPlanInputs {
  /** Gateway name every seeded agent references; absent = agent sets skipped. */
  gateway?: string;
  /** Why no gateway was resolved — becomes the per-entry skip reason. */
  noGatewayReason?: string;
  images: SeedImages;
}

export interface SkippedSeed { kind: string; name: string; reason: string }
export interface SeedPlan { resources: SeedResource[]; skipped: SkippedSeed[] }

// ---------------------------------------- Java EE → Quarkus migration set

function javaSet(gateway: string, image: string): SeedResource[] {
  return [
    cr("Agent", "java-migration-analyzer", {
      image,
      prompt: "You are a Java EE migration analyzer. Examine the application at /workspace and produce a migration plan under .konveyor/plan.md.",
      gateways: [{ ref: gateway }],
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
    }),
    cr("Agent", "java-migration-remediator", {
      image,
      prompt: "You are a Java EE migration executor. Apply the plan from .konveyor/plan.md to the source at /workspace. Commit each logical change.",
      gateways: [{ ref: gateway }],
      params: [
        { name: "repository", type: "string", description: "Git URL of the application", required: true },
        { name: "branch", type: "string", description: "Working branch", default: "main" },
        { name: "mode", type: "string", description: '"serve" or "batch"', default: "batch" },
      ],
    }),
    cr("Agent", "java-migration-validator", {
      image,
      prompt: "You are a migration validator. Build and test the migrated application at /workspace. Report results to .konveyor/verify.md.",
      gateways: [{ ref: gateway }],
      params: [
        { name: "repository", type: "string", description: "Git URL of the application", required: true },
        { name: "branch", type: "string", description: "Working branch", default: "main" },
        { name: "mode", type: "string", description: '"serve" or "batch"', default: "batch" },
      ],
    }),
    cr("AgentWorkflow", "javaee-to-quarkus", {
      guide: "Three-stage Java EE to Quarkus migration pipeline. All stages share the same branch and push their output back to it.",
      stages: [
        { name: "plan", agentRef: "java-migration-analyzer", instructions: "Stage 1: analyze the application and produce a migration plan." },
        { name: "execute", agentRef: "java-migration-remediator", instructions: "Stage 2: apply the migration plan from .konveyor/plan.md." },
        { name: "verify", agentRef: "java-migration-validator", instructions: "Stage 3: build and test the migrated application, report results." },
      ],
    }),
  ];
}

// ---------------------------------------- PatternFly migration set

function pfSet(gateway: string, image: string): SeedResource[] {
  return [
    cr("Agent", "pf-migration-analyzer", {
      image,
      prompt: "You are a PatternFly migration analyzer. Examine the frontend application at /workspace and produce a PF5→PF6 migration plan.",
      gateways: [{ ref: gateway }],
      params: [
        { name: "repository", type: "string", description: "Git URL of the frontend application", required: true },
        { name: "branch", type: "string", description: "Branch to analyze", default: "main" },
        { name: "mode", type: "string", description: '"serve" or "batch"', default: "serve" },
      ],
    }),
    cr("Agent", "pf-migration-remediator", {
      image,
      prompt: "You are a PatternFly migration executor. Apply the PF5→PF6 migration plan to the frontend at /workspace.",
      gateways: [{ ref: gateway }],
      params: [
        { name: "repository", type: "string", description: "Git URL of the frontend application", required: true },
        { name: "branch", type: "string", description: "Working branch", default: "main" },
        { name: "mode", type: "string", description: '"serve" or "batch"', default: "batch" },
      ],
    }),
    cr("Agent", "pf-migration-validator", {
      image,
      prompt: "You are a PatternFly migration validator. Build and test the migrated frontend at /workspace.",
      gateways: [{ ref: gateway }],
      params: [
        { name: "repository", type: "string", description: "Git URL of the frontend application", required: true },
        { name: "branch", type: "string", description: "Working branch", default: "main" },
        { name: "mode", type: "string", description: '"serve" or "batch"', default: "batch" },
      ],
    }),
    cr("AgentWorkflow", "patternfly-migration", {
      guide: "Three-stage PatternFly 5→6 migration pipeline for frontend applications.",
      stages: [
        { name: "analyze", agentRef: "pf-migration-analyzer", instructions: "Stage 1: analyze the frontend and produce a PF5→PF6 migration plan." },
        { name: "migrate", agentRef: "pf-migration-remediator", instructions: "Stage 2: apply the migration plan — codemods, component API changes, token updates." },
        { name: "validate", agentRef: "pf-migration-validator", instructions: "Stage 3: build, lint, and test the migrated frontend." },
      ],
    }),
  ];
}

// -------------------------------------------------------------- the plan

interface AgentSetDef {
  /** Image catalog key the set's agents run on. */
  catalogKey: "agent-java" | "agent-nodejs";
  image: (images: SeedImages) => string | undefined;
  build: (gateway: string, image: string) => SeedResource[];
  /** Kind/name of every member — used to report a skipped set entry-by-entry. */
  members: { kind: string; name: string }[];
}

const AGENT_SETS: AgentSetDef[] = [
  {
    catalogKey: "agent-java",
    image: (images) => images.java,
    build: javaSet,
    members: [
      { kind: "Agent", name: "java-migration-analyzer" },
      { kind: "Agent", name: "java-migration-remediator" },
      { kind: "Agent", name: "java-migration-validator" },
      { kind: "AgentWorkflow", name: "javaee-to-quarkus" },
    ],
  },
  {
    catalogKey: "agent-nodejs",
    image: (images) => images.nodejs,
    build: pfSet,
    members: [
      { kind: "Agent", name: "pf-migration-analyzer" },
      { kind: "Agent", name: "pf-migration-remediator" },
      { kind: "Agent", name: "pf-migration-validator" },
      { kind: "AgentWorkflow", name: "patternfly-migration" },
    ],
  },
];

/**
 * Computes the seed plan for this cluster. Pure: no cluster reads/writes —
 * the caller resolves gateway + images first and applies the plan after.
 */
export function planSeed(inputs: SeedPlanInputs): SeedPlan {
  const resources: SeedResource[] = [
    // Skill cards always seed: the controller accepts OCI image refs at face
    // value (Ready/ImageResolved), so they are green on any cluster.
    cr("SkillCard", "javaee-to-quarkus", {
      displayName: "Java EE to Quarkus migration",
      description: "Analyzes Java EE / Jakarta dependencies and generates a Quarkus migration plan.",
      type: "skill",
      version: "0.1.0",
      tags: ["java", "migration", "quarkus"],
      image: inputs.images.skillJavaEe,
    }),
    cr("SkillCard", "patternfly-migration", {
      displayName: "PatternFly 5 to 6 migration",
      description: "Guides PF5→PF6 migration: codemods, component API changes, token/CSS updates.",
      type: "skill",
      version: "0.1.0",
      tags: ["javascript", "typescript", "patternfly", "migration"],
      image: inputs.images.skillPatternFly,
    }),
  ];
  const skipped: SkippedSeed[] = [];

  for (const set of AGENT_SETS) {
    const image = set.image(inputs.images);
    let reason: string | undefined;
    if (!inputs.gateway) {
      reason = inputs.noGatewayReason ?? "no Gateway available";
    } else if (!image) {
      reason = `image "${set.catalogKey}" is not in this cluster's catalog — add it to the agent-image-catalog ConfigMap and re-seed`;
    }
    if (reason) {
      skipped.push(...set.members.map((m) => ({ ...m, reason: reason! })));
    } else {
      resources.push(...set.build(inputs.gateway!, image!));
    }
  }
  return { resources, skipped };
}

/** Plurals map for seeding — maps Kind to the k8s API plural. */
export const KIND_TO_PLURAL: Record<string, string> = {
  Gateway: PLURALS.Gateway,
  Agent: PLURALS.Agent,
  SkillCard: PLURALS.SkillCard,
  SkillCollection: PLURALS.SkillCollection,
  AgentWorkflow: PLURALS.AgentWorkflow,
  AgentWorkflowRun: PLURALS.AgentWorkflowRun,
};
