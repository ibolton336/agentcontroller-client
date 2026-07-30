/**
 * Contract types + helpers for the konveyor.io/v1alpha1 AgentRun surface.
 *
 * Source of truth: github.com/konveyor/agentic-controller api/v1alpha1/*.go
 * (the REAL controller, PR #4 era). Everything here is browser-safe: no
 * node builtins, no kube client — transports live elsewhere (see
 * ../transport-shim for the hub-shim HTTP transport).
 *
 * Verified controller facts encoded here:
 * - Sandbox pod name == status.sandboxName EXACTLY (real controller:
 *   sandboxName == run name). Never string-munge run names.
 * - ACP key Secret is named via status.secretKeyRef.name; the data key is
 *   "secret-key" (real controller) or "ACP_SECRET_KEY" (legacy simulator).
 * - ACP server: pod port 4000, path /acp, X-Secret-Key header auth.
 * - AgentRun spec is IMMUTABLE after create — delete+recreate, never patch.
 */

// ---------------------------------------------------------------- k8s meta

export interface ObjectMeta {
  name?: string;
  generateName?: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  uid?: string;
  resourceVersion?: string;
  creationTimestamp?: string;
}

export interface Condition {
  type: string;
  status: "True" | "False" | "Unknown";
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
  observedGeneration?: number;
}

// ---------------------------------------------------------------- env types

export interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: unknown;
}

export interface EnvFromSource {
  configMapRef?: { name: string; optional?: boolean };
  secretRef?: { name: string; optional?: boolean };
  prefix?: string;
}

// ---------------------------------------------------------------- AgentRun

export type AgentRunPhase = "Pending" | "Running" | "Succeeded" | "Failed";

export interface AgentRunParam {
  /** Matches an Agent param declaration; injected as KONVEYOR_PARAM_<NAME>. */
  name: string;
  value: string;
}

export interface AgentRunModelSelection {
  role: string;
  provider: string;
  model: string;
}

export interface AgentRunSpec {
  /** Name of the Agent CR to execute. Immutable (whole-spec CEL rule). */
  agentRef: string;
  params?: AgentRunParam[];
  /** Task-specific instructions, composed with the Agent's standing prompt. */
  instructions?: string;
  models?: AgentRunModelSelection[];
  env?: EnvVar[];
  envFrom?: EnvFromSource[];
}

export interface AgentRunStatus {
  phase?: AgentRunPhase;
  observedGeneration?: number;
  /**
   * Name of the Sandbox CR created for this run. The backing pod has this
   * EXACT name — resolve the pod by name, never by label (the pod carries
   * only agents.x-k8s.io/sandbox-name-hash, no konveyor.io/agentrun label).
   */
  sandboxName?: string;
  startTime?: string;
  completionTime?: string;
  /** Wall-clock duration of the run in seconds. */
  duration?: number;
  /** Secret holding the ACP auth key (X-Secret-Key header value). */
  secretKeyRef?: { name: string };
  conditions?: Condition[];
}

export interface AgentRun {
  apiVersion?: string;
  kind?: string;
  metadata: ObjectMeta;
  spec: AgentRunSpec;
  status?: AgentRunStatus;
}

// ------------------------------------------------------------------- Agent

export type AgentParamType = "string" | "number" | "boolean";

export interface AgentParam {
  name: string;
  type?: AgentParamType;
  description?: string;
  default?: string;
  required?: boolean;
}

export interface AgentResourceSpec {
  image: string;
  prompt?: string;
  params?: AgentParam[];
  providers?: { ref: string }[];
  skillCards?: { ref: string }[];
  skillCollections?: { ref: string }[];
}

/** An Agent CR ("AgentResource" to avoid clashing with UI "agent" concepts). */
export interface AgentResource {
  apiVersion?: string;
  kind?: string;
  metadata: ObjectMeta;
  spec: AgentResourceSpec;
  status?: { observedGeneration?: number; conditions?: Condition[] };
}

// ------------------------------------------------------------ ACP endpoint

/**
 * Secret data keys the ACP key may live under, tried in order: the real
 * agentic-controller writes "secret-key"; the legacy dev simulator wrote
 * "ACP_SECRET_KEY". If neither is present but the secret holds exactly one
 * entry, that sole entry is used.
 */
export const SECRET_DATA_KEYS = ["secret-key", "ACP_SECRET_KEY"] as const;

/** Port the sandbox pod's ACP server listens on. */
export const ACP_PORT = 4000;

/** HTTP/WebSocket path of the ACP server on the pod. */
export const ACP_PATH = "/acp";

/**
 * Resolves the ACP secret key from a k8s Secret's `.data` map (values are
 * base64-encoded, as returned by the apiserver). Tries SECRET_DATA_KEYS in
 * order, then falls back to the sole entry if exactly one key exists.
 * Returns the DECODED utf-8 key (the X-Secret-Key header value).
 */
export function resolveSecretKeyFromData(data: Record<string, string>): string {
  const present = Object.keys(data);
  for (const key of SECRET_DATA_KEYS) {
    const value = data[key];
    if (value !== undefined) {
      return decodeBase64Utf8(value, key);
    }
  }
  if (present.length === 1) {
    const sole = present[0] as string;
    return decodeBase64Utf8(data[sole] as string, sole);
  }
  throw new Error(
    `No ACP secret key found in secret data: looked for ${SECRET_DATA_KEYS.join(", ")}, ` +
      (present.length === 0
        ? "but the secret has no data entries."
        : `and the secret has ${present.length} entries (${present.join(", ")}) so the ` +
          "sole-entry fallback does not apply.") +
      " Expected the AgentRun's <sandboxName>-acp-key secret.",
  );
}

function decodeBase64Utf8(b64: string, keyName: string): string {
  let binary: string;
  try {
    binary = atob(b64.replace(/\s+/g, ""));
  } catch (err) {
    throw new Error(
      `Secret data key "${keyName}" is not valid base64: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

// ------------------------------------------------- platform-resolved params

/**
 * Label marking Agents the Konveyor platform (Hub/UI) knows how to drive.
 * Platform agent lists filter on this; unlabeled Agents stay invisible to
 * Konveyor UIs without affecting other consumers of the generic CRD.
 */
export const MANAGED_LABEL = "konveyor.io/managed";

/**
 * Agent annotation mapping param name -> source identifier, e.g.
 * {"repository": "konveyor.io/application-repository-url"}. A param with a
 * source is resolved by the platform (Hub / hub-shim) at run creation;
 * params without one are supplied by the caller. Source identifiers are
 * namespaced strings, NOT a CRD enum — consumers that do not recognize a
 * value MUST fail open and treat the param as caller-supplied.
 * (Annotation today; graduates to an AgentParam field once proven.)
 */
export const PARAM_SOURCES_ANNOTATION = "konveyor.io/param-sources";

/**
 * Agent annotation mapping credential name -> source identifier, e.g.
 * {"git": "konveyor.io/application-identity"}. Same contract as param
 * sources but resolves to a Secret the platform mounts via
 * AgentRun.spec.envFrom instead of a string param value.
 */
export const CREDENTIAL_SOURCES_ANNOTATION = "konveyor.io/credential-sources";

/** Well-known source identifiers the prototype platform resolves. */
export const SOURCE_APPLICATION_REPOSITORY_URL = "konveyor.io/application-repository-url";
export const SOURCE_APPLICATION_REPOSITORY_BRANCH = "konveyor.io/application-repository-branch";
export const SOURCE_APPLICATION_IDENTITY = "konveyor.io/application-identity";

/**
 * Parses an Agent's param-sources (or credential-sources) annotation into a
 * name -> source map. Returns {} for a missing, malformed, or non-object
 * annotation — bad metadata must never break run creation (fail open).
 */
export function parseSourcesAnnotation(
  agent: Pick<AgentResource, "metadata"> | undefined,
  annotation: string = PARAM_SOURCES_ANNOTATION,
): Record<string, string> {
  const raw = agent?.metadata?.annotations?.[annotation];
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [name, source] of Object.entries(parsed)) {
      if (typeof source === "string" && source.trim() !== "") out[name] = source;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * A Konveyor application as the platform's application inventory exposes it.
 * Backed by real Konveyor Hub Application records (repository + linked
 * identities); the hub-shim reads Hub over HUB_URL and maps them here.
 */
export interface Application {
  id: string;
  name: string;
  repository?: { url: string; branch?: string };
  /**
   * The application's source-control credential as Hub holds it — a named
   * Identity in Hub's vault. Present when the app has a `source` identity.
   * NOTE: this is a reference, not a usable secret: materializing a Hub
   * identity into the sandbox is the open design question (see ADR 0005).
   */
  identity?: { name: string };
  /**
   * The materialized form of `identity`: a k8s Secret the platform mounts
   * via envFrom. Today the shim bridges known Hub identities to a
   * pre-created Secret; production Hub would decrypt its vault identity into
   * the sandbox itself. Unset when no bridge exists yet.
   */
  identitySecret?: string;
}

// -------------------------------------------------------------- AgentImage

export interface AgentImage {
  name: string;
  image: string;
  displayName: string;
  description: string;
  languages: string[];
  parent: string | null;
}

// --------------------------------------------------------------- SkillCard

export type SkillCardType = "skill" | "rule";

export interface SkillCardSpec {
  displayName?: string;
  description?: string;
  image?: string;
  inline?: string;
  source?: string;
  tags?: string[];
  type?: SkillCardType;
  version?: string;
}

export interface SkillCard {
  apiVersion?: string;
  kind?: string;
  metadata: ObjectMeta;
  spec: SkillCardSpec;
  status?: {
    observedGeneration?: number;
    resolvedImage?: string;
    conditions?: Condition[];
  };
}

// --------------------------------------------------------- SkillCollection

export interface SkillCollectionSkillRef {
  name: string;
  skillCardRef?: string;
  image?: string;
  source?: string;
}

export interface SkillCollectionSpec {
  skills?: SkillCollectionSkillRef[];
}

export interface SkillCollection {
  apiVersion?: string;
  kind?: string;
  metadata: ObjectMeta;
  spec: SkillCollectionSpec;
  status?: { observedGeneration?: number; conditions?: Condition[] };
}

// ------------------------------------------------------------- LLMProvider

export interface LLMProviderModel {
  name: string;
  contextWindow: number;
  tier?: string;
}

export interface LLMProvider {
  apiVersion?: string;
  kind?: string;
  metadata: ObjectMeta;
  spec: {
    endpoint: string;
    credentialRef: { secretName: string; key: string };
    models: LLMProviderModel[];
  };
  status?: {
    observedGeneration?: number;
    connectionVerified?: boolean;
    discoveredModels?: string[];
    conditions?: Condition[];
  };
}

// ---------------------------------------------------------- AgentWorkload

export const STAGE_NAME_PATTERN = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

export interface AgentWorkloadStage {
  name: string;
  agentRef: string;
  instructions?: string;
}

export interface AgentWorkloadSpec {
  guide?: string;
  stages: AgentWorkloadStage[];
}

export interface AgentWorkload {
  apiVersion?: string;
  kind?: string;
  metadata: ObjectMeta;
  spec: AgentWorkloadSpec;
  status?: { observedGeneration?: number; conditions?: Condition[] };
}

// ------------------------------------------------------- AgentWorkloadRun

export type AgentWorkloadRunPhase = "Pending" | "Running" | "Succeeded" | "Failed";

export interface AgentWorkloadRunStageStatus {
  name: string;
  phase?: AgentRunPhase;
  agentRunName?: string;
}

export interface AgentWorkloadRunStatus {
  phase?: AgentWorkloadRunPhase;
  observedGeneration?: number;
  currentStage?: string;
  stages?: AgentWorkloadRunStageStatus[];
  startTime?: string;
  completionTime?: string;
  conditions?: Condition[];
}

export interface AgentWorkloadRun {
  apiVersion?: string;
  kind?: string;
  metadata: ObjectMeta;
  spec: {
    workloadRef: string;
    models?: AgentRunModelSelection[];
    params?: AgentRunParam[];
    instructions?: string;
    env?: EnvVar[];
    envFrom?: EnvFromSource[];
  };
  status?: AgentWorkloadRunStatus;
}

// -------------------------------------------------------- naming / helpers

export const RESOURCE_NAME_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
export const RESOURCE_NAME_MAX = 253;

export const TARGET_BRANCH_PREFIX = "konveyor/migration-";

export function defaultTargetBranch(): string {
  return `${TARGET_BRANCH_PREFIX}${Math.floor(Date.now() / 1000)}`;
}

export function invalidTargetBranchReason(branch: string): string | undefined {
  if (!branch.trim()) return "Target branch is required";
  if (branch.includes("..")) return 'Branch name cannot contain ".."';
  if (branch.includes("~") || branch.includes("^") || branch.includes(":"))
    return "Branch name cannot contain ~, ^, or :";
  if (branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".lock"))
    return "Invalid branch name";
  return undefined;
}

export const RUN_ENV = {
  HUB_BASE_URL: "HUB_BASE_URL",
  HUB_TOKEN: "HUB_TOKEN",
  APP_ID: "APP_ID",
  TARGET_BRANCH: "TARGET_BRANCH",
} as const;

export function runEnvValue(run: AgentRun, key: string): string | undefined {
  return (run.spec.env as EnvVar[] | undefined)?.find((e) => e.name === key)?.value;
}

// ----------------------------------------------------------------- RunApi

export interface CreateRunInput {
  agentRef: string;
  params?: Record<string, string>;
  instructions?: string;
  applicationRef?: string;
  targetBranch?: string;
  model?: { provider: string; model: string };
}

export interface CreateWorkloadRunInput {
  workloadRef: string;
  params?: Record<string, string>;
  instructions?: string;
  applicationRef?: string;
  targetBranch?: string;
  model?: { provider: string; model: string };
}

export interface RunApi {
  listAgents(): Promise<AgentResource[]>;
  getAgent(name: string): Promise<AgentResource>;
  listApplications(): Promise<Application[]>;
  listImages(): Promise<AgentImage[]>;
  listRuns(): Promise<AgentRun[]>;
  createRun(input: CreateRunInput): Promise<AgentRun>;
  getRun(name: string): Promise<AgentRun>;
  deleteRun(name: string): Promise<void>;
  listWorkloads(): Promise<AgentWorkload[]>;
  listWorkloadRuns(): Promise<AgentWorkloadRun[]>;
  getWorkloadRun(name: string): Promise<AgentWorkloadRun>;
  createWorkloadRun(input: CreateWorkloadRunInput): Promise<AgentWorkloadRun>;
  deleteWorkloadRun(name: string): Promise<void>;
}

// ---------------------------------------------------------------- CatalogApi

export interface CatalogApi {
  listProviders(): Promise<LLMProvider[]>;
  getProvider(name: string): Promise<LLMProvider>;
  listSkillCards(): Promise<SkillCard[]>;
  getSkillCard(name: string): Promise<SkillCard>;
  createSkillCard(name: string, spec: SkillCardSpec): Promise<SkillCard>;
  updateSkillCard(name: string, spec: SkillCardSpec): Promise<SkillCard>;
  deleteSkillCard(name: string): Promise<void>;
  listSkillCollections(): Promise<SkillCollection[]>;
  getSkillCollection(name: string): Promise<SkillCollection>;
  createSkillCollection(name: string, spec: SkillCollectionSpec): Promise<SkillCollection>;
  updateSkillCollection(name: string, spec: SkillCollectionSpec): Promise<SkillCollection>;
  deleteSkillCollection(name: string): Promise<void>;
  createAgent(name: string, spec: AgentResourceSpec): Promise<AgentResource>;
  updateAgent(name: string, spec: AgentResourceSpec): Promise<AgentResource>;
  deleteAgent(name: string): Promise<void>;
  getWorkload(name: string): Promise<AgentWorkload>;
  createWorkload(name: string, spec: AgentWorkloadSpec): Promise<AgentWorkload>;
  updateWorkload(name: string, spec: AgentWorkloadSpec): Promise<AgentWorkload>;
  deleteWorkload(name: string): Promise<void>;
}

// ---------------------------------------------------------------- waiting

/** True when the run can no longer make progress (Succeeded or Failed). */
export function isTerminalPhase(p?: string): boolean {
  return p === "Succeeded" || p === "Failed";
}

export interface WaitForRunningOptions {
  /** Overall deadline. Default 120_000 ms. */
  timeoutMs?: number;
  /** Poll interval. Default 1_000 ms. */
  pollMs?: number;
  signal?: AbortSignal;
  /** Progress callback, invoked once per poll with the observed phase. */
  onPhase?: (phase: string, elapsedMs: number) => void;
}

/**
 * Polls the run until it is connectable: phase == Running AND
 * status.sandboxName AND status.secretKeyRef are set. Rejects on phase ==
 * Failed (with condition messages), on timeout (with an actionable
 * message), or when opts.signal aborts.
 */
export async function waitForRunning(
  api: RunApi,
  name: string,
  opts?: WaitForRunningOptions,
): Promise<AgentRun> {
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const pollMs = opts?.pollMs ?? 1_000;
  const started = Date.now();
  for (;;) {
    opts?.signal?.throwIfAborted();
    const run = await api.getRun(name);
    const phase = run.status?.phase ?? "Pending";
    const elapsed = Date.now() - started;
    opts?.onPhase?.(phase, elapsed);
    if (phase === "Failed") {
      const detail = (run.status?.conditions ?? [])
        .map((c) => c.message)
        .filter(Boolean)
        .join("; ");
      throw new Error(`AgentRun ${name} failed${detail ? `: ${detail}` : ""}`);
    }
    if (phase === "Running" && run.status?.sandboxName && run.status?.secretKeyRef?.name) {
      return run;
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for AgentRun ${name} to reach Running with a ` +
          `sandbox and ACP key (last phase=${phase}, sandboxName=${run.status?.sandboxName ?? "unset"}, ` +
          `secretKeyRef=${run.status?.secretKeyRef?.name ?? "unset"}). The sandbox may still be ` +
          `pulling its image or the controller may not be reconciling — check ` +
          `'kubectl describe agentrun ${name}' and the agentic-controller logs.`,
      );
    }
    await sleep(pollMs, opts?.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
