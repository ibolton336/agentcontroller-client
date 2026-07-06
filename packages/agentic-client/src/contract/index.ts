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
  /** Pod env passthrough — opaque to this client. */
  env?: unknown;
  /** Pod envFrom passthrough — opaque to this client. */
  envFrom?: unknown;
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
  /** Container image carrying the agent runtime (ACP server on :4000/acp). */
  image: string;
  /** Standing instructions, composed with AgentRun.spec.instructions. */
  prompt?: string;
  params?: AgentParam[];
  providers?: { ref: string }[];
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

// ----------------------------------------------------------------- RunApi

/** Input for RunApi.createRun — params as a plain map, mapped by the transport. */
export interface CreateRunInput {
  agentRef: string;
  params?: Record<string, string>;
  instructions?: string;
}

/**
 * Transport-agnostic API over Agents + AgentRuns. Implemented today by
 * ShimClient (hub-shim HTTP); a future Konveyor Hub proxy exposes the same
 * shape. NOTE: AgentRun spec is immutable — there is deliberately no update.
 */
export interface RunApi {
  listAgents(): Promise<AgentResource[]>;
  listRuns(): Promise<AgentRun[]>;
  createRun(input: CreateRunInput): Promise<AgentRun>;
  getRun(name: string): Promise<AgentRun>;
  deleteRun(name: string): Promise<void>;
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
