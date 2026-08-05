/**
 * hub-shim — localhost gateway serving the SHIM HTTP API v1.
 *
 * Stands in for the future Konveyor Hub passthrough proxy so browser UIs
 * can drive the real agentic-controller today. Browsers cannot set the
 * X-Secret-Key upgrade header nor reach the sandbox pod; this shim owns
 * both: it resolves a run's ACP endpoint (pod by status.sandboxName, key
 * from status.secretKeyRef), reaches the pod (port-forward tunnel on a
 * laptop, direct service-DNS dial in-cluster), and pipes WebSocket frames
 * between the browser and the pod's :4000/acp.
 *
 * Routes:
 *   GET    /healthz                     -> 200 "ok"
 *   GET    /api/applications            -> 200 Application[] (mock inventory)
 *   GET    /api/agents[/:name]          -> 200 Agent[] | Agent | 404
 *                                          (list filtered: konveyor.io/managed=true)
 *   GET    /api/gateways[/:name]        -> 200 Gateway[] | Gateway | 404
 *   GET    /api/skillcards[/:name]      -> 200 SkillCard[] | SkillCard | 404
 *   GET    /api/skillcollections[/:name]-> 200 SkillCollection[] | SkillCollection | 404
 *   GET    /api/agentworkflows[/:name]  -> 200 AgentWorkflow[] | AgentWorkflow | 404
 *   GET    /api/images                  -> 200 AgentImage[] (image catalog)
 *   POST   /api/defaults[?dryRun=true]  -> 200 seed result (create-only;
 *                                          agents bind to the cluster's real
 *                                          Gateway and catalog images;
 *                                          dryRun computes the same plan and
 *                                          statuses without writing)
 *   GET    /api/agentruns               -> 200 AgentRun[]
 *   POST   /api/agentruns               -> 201 AgentRun (generateName "ui-")
 *   GET    /api/agentruns/:name         -> 200 AgentRun | 404
 *   DELETE /api/agentruns/:name         -> 204 | 404
 *   WS     /api/agentruns/:name/acp     -> bidirectional pipe to the pod
 *
 * No auth on the shim itself — localhost dev tool only. CORS `*` on /api/*.
 */
import * as http from "node:http";
import * as k8s from "@kubernetes/client-node";
import { WebSocket as WsWebSocket, WebSocketServer, type RawData } from "ws";
// Reused from the sibling POC package (tsx resolves cross-package TS imports).
// kube.ts implements waitForAcpEndpoint with the verified real-controller
// semantics: pod resolved by status.sandboxName (NOT labels), secret key read
// from "secret-key" / "ACP_SECRET_KEY" / sole-entry fallback.
import { AgentRunClient } from "../../agentrun-client/src/kube.js";
import { openTunnel, type Tunnel } from "../../agentrun-client/src/portforward.js";
import {
  API_VERSION,
  GROUP,
  VERSION,
  PLURALS,
  type Agent,
  type AgentRun,
  type AgentRunSpec,
  type EnvFromSource,
  type EnvVar,
  type Gateway,
} from "../../agentrun-client/src/types.js";
import {
  CREDENTIAL_SOURCES_ANNOTATION,
  MANAGED_LABEL,
  PARAM_SOURCES_ANNOTATION,
  RUN_ENV,
  SOURCE_APPLICATION_IDENTITY,
  SOURCE_APPLICATION_REPOSITORY_BRANCH,
  SOURCE_APPLICATION_REPOSITORY_URL,
  defaultTargetBranch,
  invalidTargetBranchReason,
  parseSourcesAnnotation,
  type AgentImage,
  type AgentWorkflow,
  type Application,
} from "../../agentic-client/src/contract/index.js";
import { planSeed, KIND_TO_PLURAL, type SeedPlan } from "./defaults.js";

const PORT = Number(process.env.PORT ?? 7080);
const HOST = process.env.HOST ?? "127.0.0.1";
const NAMESPACE = process.env.NAMESPACE ?? "konveyor-agents";
const ACP_RESOLVE_TIMEOUT_MS = 60_000;

/**
 * How to reach a sandbox pod's :4000.
 *  - "tunnel": Kubernetes port-forward (the laptop-dev substitute).
 *  - "direct": dial the run's headless-Service DNS name — the in-cluster
 *    path, and what the real Hub proxy will do.
 * Auto-detect: in-cluster (serviceaccount env present) means direct.
 */
const ACP_DIAL =
  process.env.ACP_DIAL === "direct" || process.env.ACP_DIAL === "tunnel"
    ? process.env.ACP_DIAL
    : process.env.KUBERNETES_SERVICE_HOST
      ? "direct"
      : "tunnel";

const log = (msg: string) => console.log(`[hub-shim] ${msg}`);
const warn = (msg: string) => console.warn(`[hub-shim] ${msg}`);

// runClient owns its own KubeConfig (loadFromDefault: respects $KUBECONFIG).
// A second KubeConfig is loaded from this package's @kubernetes/client-node
// copy for list calls — the two copies' classes have private members, so
// instances must never cross between them.
const runClient = new AgentRunClient({ namespace: NAMESPACE });
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const custom = kc.makeApiClient(k8s.CustomObjectsApi);

async function listCustom<T extends { apiVersion?: string; kind?: string }>(
  plural: string,
  kind: string,
  labelSelector?: string,
): Promise<T[]> {
  const res = (await custom.listNamespacedCustomObject({
    group: GROUP,
    version: VERSION,
    namespace: NAMESPACE,
    plural,
    labelSelector,
  })) as { items?: T[] };
  // List items omit apiVersion/kind; restore them so clients get full CRs.
  return (res.items ?? []).map((item) => ({ apiVersion: API_VERSION, kind, ...item }));
}

async function getCustom(plural: string, kind: string, name: string): Promise<object> {
  const obj = (await custom.getNamespacedCustomObject({
    group: GROUP,
    version: VERSION,
    namespace: NAMESPACE,
    plural,
    name,
  })) as Record<string, unknown>;
  return { apiVersion: API_VERSION, kind, ...obj };
}

/** Resources that support POST/PUT/DELETE through the shim. */
const WRITABLE: Record<string, string> = {
  [PLURALS.Agent]: "Agent",
  [PLURALS.SkillCard]: "SkillCard",
  [PLURALS.SkillCollection]: "SkillCollection",
  [PLURALS.AgentWorkflow]: "AgentWorkflow",
};

/** Resources served read-only as full CRs: list + get by name. */
const READ_ONLY: Record<string, string> = {
  ...WRITABLE,
  [PLURALS.Gateway]: "Gateway",
  [PLURALS.AgentWorkflowRun]: "AgentWorkflowRun",
};

const LIST_LABEL_SELECTORS: Record<string, string> = {
  [PLURALS.Agent]: `${MANAGED_LABEL}=true`,
  [PLURALS.SkillCard]: `${MANAGED_LABEL}=true`,
  [PLURALS.SkillCollection]: `${MANAGED_LABEL}=true`,
  [PLURALS.AgentWorkflow]: `${MANAGED_LABEL}=true`,
};

/**
 * Real Konveyor Hub REST base. In-cluster this is the Hub service DNS
 * (http://tackle2-hub.<ns>.svc:8080); on a laptop, a port-forward or
 * NodePort. When unset/unreachable the shim falls back to STUB_APPLICATIONS
 * so it still runs offline. This is the production-shaped knob: the real
 * Hub-proxy reads its own Application table; the shim reads it over HTTP.
 */
const HUB_URL = process.env.HUB_URL?.replace(/\/+$/, "");

/**
 * Hub base URL injected into run pods (RUN_ENV.HUB_BASE_URL). The POD dials
 * this, not the shim — on a laptop, where HUB_URL is typically a localhost
 * port-forward the pod cannot reach, set RUN_HUB_BASE_URL to the Hub's
 * in-cluster service DNS. In-cluster (the gateway) the two are the same.
 */
const RUN_HUB_BASE_URL = process.env.RUN_HUB_BASE_URL?.replace(/\/+$/, "") ?? HUB_URL;

/**
 * Bridges a Hub source-control Identity to a pre-created k8s Secret — the
 * STUB for the one thing Hub doesn't expose over REST: the decrypted
 * credential. Production Hub would materialize its vault identity into the
 * sandbox itself; until then, known identities map to a Secret here.
 */
const IDENTITY_SECRET_BRIDGE: Record<string, string> = {
  "coolstore-git": "git-credentials-coolstore",
};

/** Offline fallback when HUB_URL is unset or the Hub is unreachable. */
const STUB_APPLICATIONS: Application[] = [
  {
    id: "coolstore",
    name: "Coolstore (stub — Hub unavailable)",
    repository: { url: "https://github.com/konveyor-ecosystem/coolstore.git", branch: "main" },
    identitySecret: "git-credentials-coolstore",
  },
];

// ------------------------------------------------------- image catalog

/**
 * Where the builtin (ConfigMap-less) catalog's image refs point. The quay.io
 * defaults match the laptop/minikube dev convention (locally-built :dev
 * tags); real clusters set these to a registry they can actually pull from —
 * e.g. on OpenShift: AGENT_IMAGE_PREFIX=image-registry.openshift-image-registry.svc:5000/konveyor-agents
 * AGENT_IMAGE_TAG=demo. A cluster-authored agent-image-catalog ConfigMap
 * overrides all of this per image.
 */
const IMAGE_PREFIX = (process.env.AGENT_IMAGE_PREFIX ?? "quay.io/konveyor").replace(/\/+$/, "");
const IMAGE_TAG = process.env.AGENT_IMAGE_TAG ?? "dev";

const imageRef = (name: string) => `${IMAGE_PREFIX}/${name}:${IMAGE_TAG}`;

const BUILTIN_IMAGES: AgentImage[] = [
  { name: "agent-base", image: imageRef("agent-base"), displayName: "Agent base", description: "Harness entrypoint, git, goose runtime. No language toolchain.", languages: [], parent: null },
  { name: "agent-java", image: imageRef("agent-java"), displayName: "Java agent", description: "JDK 21, Maven 3.9, Gradle 8. For Java EE / Jakarta / Quarkus migrations.", languages: ["java"], parent: "agent-base" },
  { name: "agent-go", image: imageRef("agent-go"), displayName: "Go agent", description: "Go 1.22 toolchain. For Go module migrations and refactoring.", languages: ["go"], parent: "agent-base" },
  { name: "agent-csharp", image: imageRef("agent-csharp"), displayName: "C# agent", description: ".NET 8 SDK. For .NET Framework to .NET migrations.", languages: ["csharp"], parent: "agent-base" },
  { name: "agent-nodejs", image: imageRef("agent-nodejs"), displayName: "Node.js agent", description: "Node.js 20 LTS and npm. For frontend framework migrations (PatternFly, React).", languages: ["javascript", "typescript"], parent: "agent-base" },
];

const IMAGE_CATALOG_CM = "agent-image-catalog";

async function getImageCatalog(): Promise<{ source: "configmap" | "builtin"; images: AgentImage[] }> {
  try {
    const core = kc.makeApiClient(k8s.CoreV1Api);
    const cm = await core.readNamespacedConfigMap({ name: IMAGE_CATALOG_CM, namespace: NAMESPACE });
    const data = cm.data ?? {};
    const images: AgentImage[] = Object.entries(data).map(([key, json]) => {
      const parsed = JSON.parse(json) as Omit<AgentImage, "name">;
      return { name: key, ...parsed };
    });
    return { source: "configmap", images };
  } catch {
    return { source: "builtin", images: BUILTIN_IMAGES };
  }
}

// ------------------------------------------------------- seed gateway

/**
 * Which Gateway seeded agents bind to. Gateways need real credentials,
 * so POST /api/defaults never creates one — it binds to what the install
 * actually created. Unset = discover (prefer a Ready gateway).
 * SEED_PROVIDER is honored as a legacy alias for SEED_GATEWAY.
 */
const SEED_GATEWAY = process.env.SEED_GATEWAY ?? process.env.SEED_PROVIDER;

interface GatewayCR {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string };
  status?: { conditions?: { type?: string; status?: string }[] };
}

const gatewayReady = (g: GatewayCR): boolean =>
  (g.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True");

export interface SeedGatewayInfo {
  name: string;
  source: "env" | "discovered";
  ready: boolean;
}

/** Resolved gateway, or the reason there is none (drives per-entry skips). */
interface SeedGatewayResolution {
  info?: SeedGatewayInfo;
  reason?: string;
}

async function resolveSeedGateway(): Promise<SeedGatewayResolution> {
  if (SEED_GATEWAY) {
    try {
      const g = (await getCustom(PLURALS.Gateway, "Gateway", SEED_GATEWAY)) as GatewayCR;
      return { info: { name: SEED_GATEWAY, source: "env", ready: gatewayReady(g) } };
    } catch (err) {
      if (k8sStatusCode(err) !== 404) throw err;
      return {
        reason: `Gateway "${SEED_GATEWAY}" (SEED_GATEWAY) not found in namespace ${NAMESPACE} — create it and re-seed`,
      };
    }
  }
  const gateways = await listCustom<GatewayCR>(PLURALS.Gateway, "Gateway");
  const pick = gateways.find(gatewayReady) ?? gateways[0];
  if (!pick?.metadata?.name) {
    return {
      reason: `no Gateway in namespace ${NAMESPACE} — create one (with real credentials) and re-seed`,
    };
  }
  return { info: { name: pick.metadata.name, source: "discovered", ready: gatewayReady(pick) } };
}

interface HubApp {
  id: number;
  name: string;
  repository?: { url?: string; branch?: string };
  identities?: { id: number; name?: string }[];
}
interface HubIdentity {
  id: number;
  name: string;
  kind: string;
}

async function hubGet<T>(path: string): Promise<T> {
  const res = await fetch(`${HUB_URL}/${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Hub GET /${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * The platform's application inventory. Reads real Hub Applications and maps
 * them to the client Application shape: repository straight from Hub; the
 * source-control Identity carried as a reference (identity.name) plus its
 * bridged Secret when one exists. Falls back to STUB_APPLICATIONS offline.
 */
/** Where the inventory came from — surfaced to the UI so "real vs stub" is visible. */
interface Inventory {
  source: "hub" | "stub";
  endpoint: string;
  applications: Application[];
}

async function getApplications(): Promise<Inventory> {
  if (!HUB_URL) {
    return { source: "stub", endpoint: "offline stub (HUB_URL unset)", applications: STUB_APPLICATIONS };
  }
  try {
    const [apps, identities] = await Promise.all([
      hubGet<HubApp[]>("applications"),
      hubGet<HubIdentity[]>("identities"),
    ]);
    const sourceKind = new Map(identities.map((i) => [i.id, i.kind]));
    const applications = apps.map((a): Application => {
      const srcRef = (a.identities ?? []).find((r) => sourceKind.get(r.id) === "source");
      const idName = srcRef?.name;
      return {
        id: String(a.id),
        name: a.name,
        repository: a.repository?.url
          ? { url: a.repository.url, branch: a.repository.branch }
          : undefined,
        identity: idName ? { name: idName } : undefined,
        identitySecret: idName ? IDENTITY_SECRET_BRIDGE[idName] : undefined,
      };
    });
    return { source: "hub", endpoint: HUB_URL, applications };
  } catch (err) {
    warn(`Hub inventory unavailable (${errorMessage(err)}); using offline stub`);
    return { source: "stub", endpoint: "offline stub (Hub unreachable)", applications: STUB_APPLICATIONS };
  }
}

// ---------------------------------------------------------------- HTTP api

/**
 * A fault attributable to the caller (-> 400). Everything else — including
 * apiserver transport failures, which carry a STRING `code` like
 * "ECONNREFUSED" and so are invisible to k8sStatusCode — must bubble to the
 * top-level handler and become a 5xx. Never infer "client fault" from the
 * absence of a numeric status code.
 */
class BadRequestError extends Error {}

// Explicitly typed so TS control-flow analysis treats a call as unreachable
// past this point (narrowing after `if (!x) badRequest(...)`).
const badRequest: (message: string) => never = (message) => {
  throw new BadRequestError(message);
};

function k8sStatusCode(err: unknown): number | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "number" && code >= 400 && code <= 599) return code;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 1_048_576) badRequest("request body too large (max 1 MiB)");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) badRequest("request body is empty; expected JSON");
  try {
    return JSON.parse(text);
  } catch {
    badRequest("request body is not valid JSON");
  }
}

const RESOURCE_NAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

function k8sMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const body = (err as Record<string, unknown>).body;
    if (body && typeof body === "object" && "message" in (body as Record<string, unknown>)) {
      return String((body as Record<string, unknown>).message);
    }
    if ("message" in err) return String((err as Record<string, unknown>).message);
  }
  return errorMessage(err);
}

interface SaveBody {
  name: string;
  spec: Record<string, unknown>;
}

function parseSaveBody(raw: unknown, requireName: boolean): SaveBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    badRequest("body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;
  if (requireName) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      badRequest("name is required and must be a non-empty string");
    }
    if (body.name.length > 253) badRequest("name exceeds 253 characters");
    if (!RESOURCE_NAME_RE.test(body.name)) {
      badRequest(`name "${body.name}" is not a valid DNS-1123 subdomain`);
    }
  }
  if (!body.spec || typeof body.spec !== "object" || Array.isArray(body.spec)) {
    badRequest("spec is required and must be a JSON object");
  }
  return { name: body.name as string, spec: body.spec as Record<string, unknown> };
}

function managedMetadata(name: string) {
  return {
    name,
    namespace: NAMESPACE,
    labels: { [MANAGED_LABEL]: "true" },
  };
}

interface CreateRunBody {
  agentRef: string;
  params?: Record<string, string>;
  instructions?: string;
  applicationRef?: string;
  /** Only meaningful with applicationRef. Defaults to defaultTargetBranch(). */
  targetBranch?: string;
  /** Explicit Gateway selection; absent = controller default (single-gateway Agent). */
  gateway?: string;
}

/** Body of POST /api/agentworkflowruns (contract: CreateWorkflowRunInput). */
interface CreateWorkflowRunBody {
  workflowRef: string;
  params?: Record<string, string>;
  applicationRef?: string;
  targetBranch?: string;
  gateway?: string;
}

/**
 * What the platform contributes to a run beyond the caller's input:
 * param values resolved from the selected application, and credential
 * Secrets mounted via envFrom.
 */
interface ResolvedSources {
  params: Record<string, string>;
  envFrom: EnvFromSource[];
}

/**
 * Resolves an Agent's declared param/credential sources from the selected
 * application — the Hub-side half of the param-sources contract (ADR 0005).
 *
 * Fail-open takes precedence over every other rule: an unrecognized source
 * identifier, or an annotation entry naming a param the Agent does not
 * declare, is skipped and the param reverts to caller-supplied semantics.
 * Throws (-> 400) only for an unknown applicationRef, or for a REQUIRED
 * param with a RECOGNIZED source that the application cannot supply.
 */
async function resolveSources(input: CreateRunBody): Promise<ResolvedSources> {
  const resolved: ResolvedSources = { params: {}, envFrom: [] };
  if (!input.applicationRef) return resolved;

  const app = (await getApplications()).applications.find((a) => a.id === input.applicationRef);
  if (!app) {
    badRequest(
      `unknown applicationRef "${input.applicationRef}" — GET /api/applications lists the inventory`,
    );
  }
  let agent: Agent;
  try {
    agent = (await getCustom(PLURALS.Agent, "Agent", input.agentRef)) as Agent;
  } catch (err) {
    if (k8sStatusCode(err) === 404) badRequest(`unknown agentRef "${input.agentRef}"`);
    throw err;
  }

  const sourceValues: Record<string, string | undefined> = {
    [SOURCE_APPLICATION_REPOSITORY_URL]: app.repository?.url,
    [SOURCE_APPLICATION_REPOSITORY_BRANCH]: app.repository?.branch,
  };
  const paramSources = parseSourcesAnnotation(agent, PARAM_SOURCES_ANNOTATION);
  for (const [name, source] of Object.entries(paramSources)) {
    if (input.params?.[name] !== undefined) continue; // caller wins
    if (!agent.spec.params?.some((p) => p.name === name)) {
      // Stale annotation (e.g. the param was renamed). Injecting it would
      // hand the sandbox a KONVEYOR_PARAM_* the agent never declared.
      log(`param-sources: "${name}" is not declared in spec.params — ignoring`);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(sourceValues, source)) {
      log(`param-sources: unrecognized source "${source}" for param "${name}" — fail open`);
      continue;
    }
    const value = sourceValues[source];
    if (value !== undefined) {
      resolved.params[name] = value;
    } else if (agent.spec.params?.some((p) => p.name === name && p.required && !p.default)) {
      badRequest(
        `required param "${name}" resolves from ${source}, but application ` +
          `"${app.id}" has no value for it — supply the param explicitly`,
      );
    }
  }

  const credentialSources = parseSourcesAnnotation(agent, CREDENTIAL_SOURCES_ANNOTATION);
  for (const [name, source] of Object.entries(credentialSources)) {
    if (source !== SOURCE_APPLICATION_IDENTITY) {
      log(`credential-sources: unrecognized source "${source}" for "${name}" — fail open`);
      continue;
    }
    if (app.identitySecret) {
      resolved.envFrom.push({ secretRef: { name: app.identitySecret } });
    } else {
      // Credentials are best-effort: apps without an identity (public
      // repos) still run. The agent sees no creds and acts accordingly.
      log(`credential "${name}": application "${app.id}" has no identity secret — skipping`);
    }
  }
  return resolved;
}

/**
 * The platform's contribution to a run that works on an application: the
 * Hub coordinates + application id + target branch, injected as spec.env
 * (RUN_ENV). The Konveyor-aware harness pulls everything else — repo URL,
 * decrypted git identity, analysis — from the Hub itself, in-pod. The
 * harness hard-requires all three env vars and fails at startup without
 * them, so an application-scoped run that cannot resolve them is a 400.
 */
async function hubEnvForRun(
  applicationRef: string,
  targetBranch: string | undefined,
): Promise<EnvVar[]> {
  // Creating an application-scoped run against stub data would inject a
  // fabricated APP_ID the real Hub can't resolve. Not the caller's fault,
  // so a plain Error (-> 5xx), unlike the 400s below.
  const inv = await getApplications();
  if (inv.source !== "hub") {
    throw new Error(
      `application inventory unavailable (${inv.endpoint}) — cannot create an ` +
        `application-scoped run against stub data; retry when the Hub is reachable`,
    );
  }
  const app = inv.applications.find((a) => a.id === applicationRef);
  if (!app) {
    badRequest(
      `unknown applicationRef "${applicationRef}" — GET /api/applications lists the inventory`,
    );
  }
  if (!/^\d+$/.test(app.id)) {
    badRequest(
      `application id "${app.id}" is not numeric — the harness's APP_ID parser requires a ` +
        `uint Hub id`,
    );
  }
  if (!app.repository?.url) {
    badRequest(
      `application "${app.id}" has no repository URL — the harness clones from the Hub ` +
        `record; set the application's source repository first`,
    );
  }
  if (!RUN_HUB_BASE_URL) {
    badRequest(
      "applicationRef needs a Hub the SANDBOX POD can reach: set HUB_URL (in-cluster) or " +
        "RUN_HUB_BASE_URL (laptop dev, pointing at the Hub's in-cluster service DNS)",
    );
  }
  // The pod dials this URL, not the shim: a laptop port-forward loopback
  // address is unreachable from inside the cluster.
  let hubHost: string;
  try {
    hubHost = new URL(RUN_HUB_BASE_URL).hostname;
  } catch {
    badRequest(`RUN_HUB_BASE_URL/HUB_URL "${RUN_HUB_BASE_URL}" is not a valid URL`);
  }
  if (ACP_DIAL === "tunnel" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hubHost)) {
    badRequest(
      `Hub base URL "${RUN_HUB_BASE_URL}" is loopback but the shim is not in-cluster — the ` +
        `sandbox pod cannot reach the laptop's port-forward; set RUN_HUB_BASE_URL to the ` +
        `Hub's in-cluster service DNS (e.g. http://tackle-hub.konveyor-tackle.svc:8080)`,
    );
  }
  const branch = (targetBranch ?? defaultTargetBranch()).trim();
  const branchProblem = invalidTargetBranchReason(branch);
  if (branchProblem) {
    badRequest(`targetBranch "${branch}": ${branchProblem}`);
  }
  if (app.repository?.branch && branch === app.repository.branch) {
    badRequest(
      `targetBranch "${branch}" equals application "${app.id}"'s source branch — the harness ` +
        `refuses to push onto the source branch; pick any other name`,
    );
  }
  return [
    { name: RUN_ENV.HUB_BASE_URL, value: RUN_HUB_BASE_URL },
    { name: RUN_ENV.APP_ID, value: app.id },
    { name: RUN_ENV.TARGET_BRANCH, value: branch },
  ];
}

/**
 * Fetches an Agent, tolerating 404 (undefined) — run creation leaves an
 * unknown agentRef for the controller to report, matching the CR-level
 * behavior a kubectl user would see.
 */
async function fetchAgent(agentRef: string): Promise<Agent | undefined> {
  try {
    return (await getCustom(PLURALS.Agent, "Agent", agentRef)) as Agent;
  } catch (err) {
    if (k8sStatusCode(err) === 404) return undefined;
    throw err;
  }
}

/**
 * Gateway selection policy. The controller now owns the mechanics
 * (post-#100): validateGateway defaults a run with no spec.gateway to the
 * Agent's only declared gateway and fails validation when several are
 * declared; buildEnvVars injects KONVEYOR_LLM_* and mounts the credential
 * Secret itself. The shim's remaining job is fail-fast UX:
 * - an EXPLICIT caller selection is validated loudly (400 naming the
 *   declared set) instead of surfacing later as a Failed run;
 * - the ambiguous case — no selection, an Agent declaring several
 *   gateways — is pre-empted with a 400 naming the choices;
 * - no selection + a single-gateway (or unknown) Agent returns undefined:
 *   spec.gateway stays unset and the controller defaults or reports.
 */
async function resolveGateway(
  explicit: string | undefined,
  agents: Agent[],
): Promise<string | undefined> {
  if (explicit) {
    for (const agent of agents) {
      const declared = (agent.spec.gateways ?? []).map((g) => g.ref);
      if (!declared.includes(explicit)) {
        badRequest(
          `gateway "${explicit}" is not among Agent "${agent.metadata.name}"'s ` +
            `declared gateways (${declared.join(", ") || "none"})`,
        );
      }
    }
    let gateway: Gateway;
    try {
      gateway = (await getCustom(PLURALS.Gateway, "Gateway", explicit)) as Gateway;
    } catch (err) {
      if (k8sStatusCode(err) === 404) {
        badRequest(`unknown Gateway "${explicit}" — GET /api/gateways lists them`);
      }
      throw err;
    }
    warnUnknownGooseProvider(gateway);
    log(`gateway: ${explicit} (explicit caller selection)`);
    return explicit;
  }
  for (const agent of agents) {
    const declared = (agent.spec.gateways ?? []).map((g) => g.ref);
    if (declared.length > 1) {
      badRequest(
        `Agent "${agent.metadata.name}" declares ${declared.length} gateways ` +
          `(${declared.join(", ")}) — pass gateway to select one`,
      );
    }
  }
  return undefined;
}

/**
 * goose provider ids the harness's provider mapping can hit
 * (spec.provider lowercased, "-" -> "_"). Advisory only — goose grows
 * providers, so an unknown id is a warning, never a 400.
 */
const KNOWN_GOOSE_PROVIDER_IDS = new Set([
  "anthropic",
  "aws_bedrock",
  "azure_openai",
  "databricks",
  "gcp_vertex_ai",
  "google",
  "groq",
  "litellm",
  "ollama",
  "openai",
  "openrouter",
  "xai",
]);

/**
 * The harness maps Gateway spec.provider to a goose provider id
 * (lowercased, "-" -> "_") — a provider "bedrock" does not mean
 * aws_bedrock. Warn at create time so the misname surfaces here instead of
 * as a goose startup failure inside the pod.
 */
function warnUnknownGooseProvider(gateway: Gateway): void {
  const gooseId = gateway.spec.provider.toLowerCase().replace(/-/g, "_");
  if (!KNOWN_GOOSE_PROVIDER_IDS.has(gooseId)) {
    warn(
      `Gateway "${gateway.metadata.name}" declares provider "${gateway.spec.provider}" -> goose ` +
        `provider id "${gooseId}", which is not a known goose provider — if goose rejects it, ` +
        `fix spec.provider (e.g. "aws-bedrock" for aws_bedrock)`,
    );
  }
}

/** Validates the POST /api/agentruns body; throws with a client-facing message. */
function parseCreateRunBody(raw: unknown): CreateRunBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    badRequest("body must be a JSON object: {agentRef, params?, instructions?}");
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.agentRef !== "string" || body.agentRef.trim() === "") {
    badRequest("agentRef is required and must be a non-empty string");
  }
  let params: Record<string, string> | undefined;
  if (body.params !== undefined) {
    if (!body.params || typeof body.params !== "object" || Array.isArray(body.params)) {
      badRequest("params must be an object of string values");
    }
    params = {};
    for (const [key, value] of Object.entries(body.params as Record<string, unknown>)) {
      if (typeof value !== "string") {
        badRequest(`params.${key} must be a string`);
      }
      params[key] = value;
    }
  }
  if (body.instructions !== undefined && typeof body.instructions !== "string") {
    badRequest("instructions must be a string");
  }
  if (body.applicationRef !== undefined && typeof body.applicationRef !== "string") {
    badRequest("applicationRef must be a string");
  }
  if (body.targetBranch !== undefined && (typeof body.targetBranch !== "string" || body.targetBranch.trim() === "")) {
    badRequest("targetBranch must be a non-empty string");
  }
  if (body.gateway !== undefined && (typeof body.gateway !== "string" || body.gateway.trim() === "")) {
    badRequest("gateway must be a non-empty string (a Gateway name)");
  }
  return {
    agentRef: body.agentRef,
    params,
    instructions: body.instructions as string | undefined,
    applicationRef: body.applicationRef as string | undefined,
    targetBranch: (body.targetBranch as string | undefined)?.trim(),
    gateway: (body.gateway as string | undefined)?.trim(),
  };
}

function parseCreateWorkflowRunBody(raw: unknown): CreateWorkflowRunBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    badRequest("body must be a JSON object: {workflowRef, gateway?, params?, applicationRef?, targetBranch?}");
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.workflowRef !== "string" || body.workflowRef.trim() === "") {
    badRequest("workflowRef is required and must be a non-empty string");
  }
  // Optional: absent means "let the controller default per stage agent"
  // (same policy as single-run create). Present means shape-checked here
  // and validated loudly by resolveGateway.
  if (body.gateway !== undefined && (typeof body.gateway !== "string" || body.gateway.trim() === "")) {
    badRequest("gateway must be a non-empty string (a Gateway name)");
  }
  let params: Record<string, string> | undefined;
  if (body.params !== undefined) {
    if (!body.params || typeof body.params !== "object" || Array.isArray(body.params)) {
      badRequest("params must be an object of string values");
    }
    params = {};
    for (const [key, value] of Object.entries(body.params as Record<string, unknown>)) {
      if (typeof value !== "string") {
        badRequest(`params.${key} must be a string`);
      }
      params[key] = value;
    }
  }
  if (body.applicationRef !== undefined && typeof body.applicationRef !== "string") {
    badRequest("applicationRef must be a string");
  }
  if (body.targetBranch !== undefined && (typeof body.targetBranch !== "string" || body.targetBranch.trim() === "")) {
    badRequest("targetBranch must be a non-empty string");
  }
  if (body.instructions !== undefined) {
    // Contract carries it; the AgentWorkflowRun CRD has no such field.
    log("createWorkflowRun: dropping unsupported field \"instructions\" (not in the CRD)");
  }
  return {
    workflowRef: body.workflowRef,
    params,
    applicationRef: body.applicationRef as string | undefined,
    targetBranch: body.targetBranch as string | undefined,
    gateway: (body.gateway as string | undefined)?.trim(),
  };
}

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<void> {
  const method = req.method ?? "GET";

  if (pathname === "/api/images") {
    if (method !== "GET") return sendError(res, 405, "method not allowed");
    const catalog = await getImageCatalog();
    return sendJson(res, 200, catalog.images, {
      "X-Catalog-Source": catalog.source,
    });
  }

  if (pathname === "/api/defaults") {
    if (method !== "POST") return sendError(res, 405, "method not allowed");
    const query = new URL(req.url ?? "/", "http://localhost").searchParams;
    const dryRun = /^(1|true)$/i.test(query.get("dryRun") ?? "");

    // Resolve what THIS cluster can supply, then plan against it.
    const gateway = await resolveSeedGateway();
    const catalog = await getImageCatalog();
    const catalogImage = (name: string) => catalog.images.find((i) => i.name === name)?.image;
    const plan: SeedPlan = planSeed({
      gateway: gateway.info?.name,
      noGatewayReason: gateway.reason,
      images: {
        java: catalogImage("agent-java"),
        nodejs: catalogImage("agent-nodejs"),
        skillJavaEe: imageRef("skill-javaee-to-quarkus"),
        skillPatternFly: imageRef("skill-patternfly-migration"),
      },
    });

    // In a dry run "created" means "would be created" — statuses are computed
    // from the same existence checks, but nothing is written.
    const results: { kind: string; name: string; status: "created" | "exists" | "skipped"; reason?: string }[] = [];
    for (const resource of plan.resources) {
      const plural = KIND_TO_PLURAL[resource.kind];
      if (!plural) {
        warn(`defaults: unknown kind "${resource.kind}" — skipping ${resource.metadata.name}`);
        continue;
      }
      try {
        await custom.getNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace: NAMESPACE,
          plural,
          name: resource.metadata.name,
        });
        results.push({ kind: resource.kind, name: resource.metadata.name, status: "exists" });
      } catch (err) {
        if (k8sStatusCode(err) !== 404) throw err;
        if (!dryRun) {
          await custom.createNamespacedCustomObject({
            group: GROUP,
            version: VERSION,
            namespace: NAMESPACE,
            plural,
            body: resource,
          });
        }
        results.push({ kind: resource.kind, name: resource.metadata.name, status: "created" });
      }
    }
    // Also apply the image catalog ConfigMap
    try {
      const core = kc.makeApiClient(k8s.CoreV1Api);
      try {
        await core.readNamespacedConfigMap({ name: IMAGE_CATALOG_CM, namespace: NAMESPACE });
        results.push({ kind: "ConfigMap", name: IMAGE_CATALOG_CM, status: "exists" });
      } catch (cmErr) {
        if (k8sStatusCode(cmErr) !== 404) throw cmErr;
        if (!dryRun) {
          await core.createNamespacedConfigMap({
            namespace: NAMESPACE,
            body: {
              metadata: {
                name: IMAGE_CATALOG_CM,
                namespace: NAMESPACE,
                labels: { "konveyor.io/managed": "true", "konveyor.io/catalog": "images" },
              },
              data: Object.fromEntries(
                BUILTIN_IMAGES.map((img) => [
                  img.name,
                  JSON.stringify({ image: img.image, displayName: img.displayName, description: img.description, languages: img.languages, parent: img.parent }),
                ]),
              ),
            },
          });
        }
        results.push({ kind: "ConfigMap", name: IMAGE_CATALOG_CM, status: "created" });
      }
    } catch (err) {
      warn(`defaults: failed to seed image catalog ConfigMap: ${errorMessage(err)}`);
    }
    for (const s of plan.skipped) {
      results.push({ kind: s.kind, name: s.name, status: "skipped", reason: s.reason });
    }
    const seeded = results.filter((r) => r.status === "created").length;
    const existed = results.filter((r) => r.status === "exists").length;
    const skippedCount = results.filter((r) => r.status === "skipped").length;
    log(
      `defaults${dryRun ? " (dry run)" : ""}: ${seeded} created, ${existed} existed, ` +
        `${skippedCount} skipped (gateway=${gateway.info?.name ?? "none"})`,
    );
    return sendJson(res, 200, {
      seeded,
      existed,
      skipped: skippedCount,
      dryRun,
      gateway: gateway.info ?? null,
      results,
    });
  }

  if (pathname === "/api/applications") {
    if (method !== "GET") return sendError(res, 405, "method not allowed");
    const inv = await getApplications();
    // Body stays a bare Application[] (unchanged contract). Provenance rides
    // in headers so the UI can show real-vs-stub without a shape change.
    return sendJson(res, 200, inv.applications, {
      "X-Inventory-Source": inv.source,
      "X-Inventory-Endpoint": inv.endpoint,
    });
  }

  const apiMatch = /^\/api\/([a-z]+)(?:\/([^/]+))?$/.exec(pathname);

  // ---- catalog write routes (POST/PUT/DELETE) for writable resources
  if (apiMatch && WRITABLE[apiMatch[1]] && method !== "GET") {
    const plural = apiMatch[1];
    const kind = WRITABLE[plural]!;

    if (method === "POST" && !apiMatch[2]) {
      let body: SaveBody;
      try {
        body = parseSaveBody(await readJsonBody(req), true);
      } catch (err) {
        if (!(err instanceof BadRequestError)) throw err;
        return sendError(res, 400, errorMessage(err));
      }
      try {
        const created = await custom.createNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace: NAMESPACE,
          plural,
          body: {
            apiVersion: API_VERSION,
            kind,
            metadata: managedMetadata(body.name),
            spec: body.spec,
          },
        });
        log(`created ${kind} ${body.name}`);
        return sendJson(res, 201, { apiVersion: API_VERSION, kind, ...created as object });
      } catch (err) {
        const code = k8sStatusCode(err);
        if (code === 409) return sendError(res, 409, `${kind} "${body.name}" already exists`);
        if (code === 422) return sendError(res, 422, k8sMessage(err));
        throw err;
      }
    }

    if (method === "PUT" && apiMatch[2]) {
      const name = decodeURIComponent(apiMatch[2]);
      let body: SaveBody;
      try {
        body = parseSaveBody(await readJsonBody(req), false);
      } catch (err) {
        if (!(err instanceof BadRequestError)) throw err;
        return sendError(res, 400, errorMessage(err));
      }
      try {
        const existing = (await custom.getNamespacedCustomObject({
          group: GROUP, version: VERSION, namespace: NAMESPACE, plural, name,
        })) as { metadata?: { resourceVersion?: string; labels?: Record<string, string> } };
        const labels = { ...existing.metadata?.labels, [MANAGED_LABEL]: "true" };
        const replaced = await custom.replaceNamespacedCustomObject({
          group: GROUP, version: VERSION, namespace: NAMESPACE, plural, name,
          body: {
            apiVersion: API_VERSION,
            kind,
            metadata: { name, namespace: NAMESPACE, resourceVersion: existing.metadata?.resourceVersion, labels },
            spec: body.spec,
          },
        });
        log(`updated ${kind} ${name}`);
        return sendJson(res, 200, { apiVersion: API_VERSION, kind, ...replaced as object });
      } catch (err) {
        const code = k8sStatusCode(err);
        if (code === 404) return sendError(res, 404, `${kind} "${name}" not found`);
        if (code === 409) return sendError(res, 409, `${kind} "${name}" was modified — retry`);
        if (code === 422) return sendError(res, 422, k8sMessage(err));
        throw err;
      }
    }

    if (method === "DELETE" && apiMatch[2]) {
      const name = decodeURIComponent(apiMatch[2]);
      try {
        await custom.deleteNamespacedCustomObject({
          group: GROUP, version: VERSION, namespace: NAMESPACE, plural, name,
        });
        log(`deleted ${kind} ${name}`);
        res.writeHead(204).end();
        return;
      } catch (err) {
        if (k8sStatusCode(err) === 404) return sendError(res, 404, `${kind} "${name}" not found`);
        throw err;
      }
    }

    return sendError(res, 405, "method not allowed");
  }

  // ---- workflow runs: create + delete (list/get fall through to READ_ONLY).
  // Runs are not catalog resources — the WRITABLE path's {name, spec} shape
  // and replace semantics don't apply, so they get a dedicated handler that
  // mirrors POST /api/agentruns.
  if (apiMatch && apiMatch[1] === PLURALS.AgentWorkflowRun && method !== "GET") {
    if (method === "POST" && !apiMatch[2]) {
      let input: CreateWorkflowRunBody;
      try {
        input = parseCreateWorkflowRunBody(await readJsonBody(req));
      } catch (err) {
        if (!(err instanceof BadRequestError)) throw err;
        return sendError(res, 400, errorMessage(err));
      }
      let workflow: AgentWorkflow;
      try {
        workflow = (await getCustom(PLURALS.AgentWorkflow, "AgentWorkflow", input.workflowRef)) as AgentWorkflow;
      } catch (err) {
        if (k8sStatusCode(err) === 404) {
          return sendError(res, 400, `unknown workflowRef "${input.workflowRef}" — GET /api/agentworkflows lists them`);
        }
        throw err;
      }

      // Gateway policy mirrors single-run create: an explicit choice is
      // validated loudly against every stage agent's declared gateways; no
      // choice leaves spec.gateway unset and each stage AgentRun defaults
      // per its own agent (multi-gateway stage agents are pre-empted with
      // a 400 instead of a run that reaches Failed).
      const stageRefs = [...new Set((workflow.spec.stages ?? []).map((s) => s.agentRef))];
      const stageAgents: Agent[] = [];
      for (const ref of stageRefs) {
        try {
          stageAgents.push((await getCustom(PLURALS.Agent, "Agent", ref)) as Agent);
        } catch (err) {
          if (k8sStatusCode(err) !== 404) throw err;
          log(`workflow "${input.workflowRef}" stage agent "${ref}" not found — skipping for gateway resolution`);
        }
      }
      let gateway: string | undefined;
      try {
        gateway = await resolveGateway(input.gateway, stageAgents);
      } catch (err) {
        if (!(err instanceof BadRequestError)) throw err;
        return sendError(res, 400, errorMessage(err));
      }

      // Every stage shares one target branch; the harness requires it and
      // requires it to differ from the source branch. Fresh per attempt.
      const targetBranch = input.targetBranch ?? `konveyor/${input.workflowRef}-${Date.now()}`;
      const env: Array<{ name: string; value: string }> = [
        { name: "TARGET_BRANCH", value: targetBranch },
      ];
      if (input.applicationRef) {
        const inv = await getApplications();
        const app = inv.applications.find((a) => a.id === input.applicationRef);
        if (!app) {
          return sendError(res, 400, `unknown applicationRef "${input.applicationRef}" — GET /api/applications lists the inventory`);
        }
        if (app.repository?.branch && app.repository.branch === targetBranch) {
          return sendError(res, 400, `targetBranch "${targetBranch}" must differ from the application source branch`);
        }
        if (inv.source === "stub" || !inv.endpoint) {
          return sendError(res, 400, "applicationRef needs a real Hub inventory (current source is the built-in stub) — the run's stages resolve the repo from the Hub");
        }
        env.push(
          { name: "HUB_BASE_URL", value: inv.endpoint },
          { name: "APP_ID", value: app.id },
        );
      }

      const spec: Record<string, unknown> = {
        workflowRef: input.workflowRef,
        env,
      };
      if (gateway) spec.gateway = gateway;
      if (input.params && Object.keys(input.params).length > 0) {
        spec.params = Object.entries(input.params).map(([name, value]) => ({ name, value }));
      }

      const created = await custom.createNamespacedCustomObject({
        group: GROUP,
        version: VERSION,
        namespace: NAMESPACE,
        plural: PLURALS.AgentWorkflowRun,
        body: {
          apiVersion: API_VERSION,
          kind: "AgentWorkflowRun",
          metadata: {
            generateName: "ui-",
            namespace: NAMESPACE,
            labels: { [MANAGED_LABEL]: "true" },
          },
          spec,
        },
      }) as { metadata?: { name?: string } };
      log(`created AgentWorkflowRun ${created.metadata?.name} (workflowRef=${input.workflowRef}, branch=${targetBranch})`);
      return sendJson(res, 201, { apiVersion: API_VERSION, kind: "AgentWorkflowRun", ...created as object });
    }

    if (method === "DELETE" && apiMatch[2]) {
      const name = decodeURIComponent(apiMatch[2]);
      try {
        await custom.deleteNamespacedCustomObject({
          group: GROUP, version: VERSION, namespace: NAMESPACE,
          plural: PLURALS.AgentWorkflowRun, name,
        });
      } catch (err) {
        if (k8sStatusCode(err) === 404) return sendError(res, 404, `AgentWorkflowRun ${name} not found`);
        throw err;
      }
      log(`deleted AgentWorkflowRun ${name}`);
      res.writeHead(204).end();
      return;
    }

    return sendError(res, 405, "method not allowed");
  }

  // ---- read-only list + get-by-name for all catalog resources
  if (apiMatch && READ_ONLY[apiMatch[1]]) {
    if (method !== "GET") return sendError(res, 405, "method not allowed");
    const plural = apiMatch[1];
    const kind = READ_ONLY[plural]!;
    if (!apiMatch[2]) {
      return sendJson(res, 200, await listCustom(plural, kind, LIST_LABEL_SELECTORS[plural]));
    }
    const name = decodeURIComponent(apiMatch[2]);
    try {
      return sendJson(res, 200, await getCustom(plural, kind, name));
    } catch (err) {
      if (k8sStatusCode(err) === 404) return sendError(res, 404, `${kind} ${name} not found`);
      throw err;
    }
  }

  if (pathname === "/api/agentruns") {
    if (method === "GET") {
      return sendJson(res, 200, await listCustom<AgentRun>(PLURALS.AgentRun, "AgentRun"));
    }
    if (method === "POST") {
      let input: CreateRunBody;
      let sources: ResolvedSources;
      let agent: Agent | undefined;
      let hubEnv: EnvVar[];
      let gateway: string | undefined;
      try {
        input = parseCreateRunBody(await readJsonBody(req));
        sources = await resolveSources(input);
        agent = await fetchAgent(input.agentRef);
        // A konveyor-managed agent's harness hard-requires Hub context
        // (HUB_BASE_URL / APP_ID / TARGET_BRANCH) and exits at startup
        // without it: the run would crash-loop before its ACP endpoint
        // exists and a viewer sees only a DNS error. Refuse to create the
        // doomed run. (An unknown agentRef stays the controller's to
        // report — agent is undefined then and the guard does not apply.)
        if (!input.applicationRef && agent?.metadata?.labels?.[MANAGED_LABEL] === "true") {
          badRequest(
            `agent "${input.agentRef}" is konveyor-managed and requires an application — ` +
              `pass applicationRef (GET /api/applications lists the inventory)`,
          );
        }
        hubEnv = input.applicationRef
          ? await hubEnvForRun(input.applicationRef, input.targetBranch)
          : [];
        // Explicit selection validates against the agent when it resolves
        // (an unknown agentRef stays the controller's to report); absent,
        // the controller defaults a single-gateway Agent by itself.
        gateway = await resolveGateway(input.gateway, agent ? [agent] : []);
      } catch (err) {
        // Only caller faults are 400. resolveSources talks to the apiserver
        // inside this try, and a transport failure there is a 5xx.
        if (!(err instanceof BadRequestError)) throw err;
        return sendError(res, 400, errorMessage(err));
      }
      const spec: AgentRunSpec = { agentRef: input.agentRef };
      const params = { ...sources.params, ...(input.params ?? {}) };
      if (Object.keys(params).length > 0) {
        spec.params = Object.entries(params).map(([name, value]) => ({ name, value }));
      }
      if (input.instructions !== undefined) spec.instructions = input.instructions;
      if (gateway) spec.gateway = gateway;
      // Hub coordinates + TARGET_BRANCH ride spec.env; the application
      // identity Secret rides envFrom (the controller mounts the gateway's
      // LLM credential itself since #100).
      if (hubEnv.length > 0) spec.env = hubEnv;
      if (sources.envFrom.length > 0) spec.envFrom = sources.envFrom;
      const run = await runClient.createAgentRun(spec, { generateName: "ui-" });
      const via = input.applicationRef ? ` via application=${input.applicationRef}` : "";
      log(`created AgentRun ${run.metadata.name} (agentRef=${input.agentRef}${via})`);
      return sendJson(res, 201, run);
    }
    return sendError(res, 405, "method not allowed");
  }

  const runMatch = /^\/api\/agentruns\/([^/]+)$/.exec(pathname);
  if (runMatch) {
    const name = decodeURIComponent(runMatch[1]);
    if (method === "GET") {
      try {
        return sendJson(res, 200, await runClient.getAgentRun(name));
      } catch (err) {
        if (k8sStatusCode(err) === 404) return sendError(res, 404, `AgentRun ${name} not found`);
        throw err;
      }
    }
    if (method === "DELETE") {
      try {
        await runClient.deleteAgentRun(name);
      } catch (err) {
        if (k8sStatusCode(err) === 404) return sendError(res, 404, `AgentRun ${name} not found`);
        throw err;
      }
      log(`deleted AgentRun ${name}`);
      res.writeHead(204).end();
      return;
    }
    return sendError(res, 405, "method not allowed");
  }

  sendError(res, 404, `no route for ${pathname}`);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("ok");
    return;
  }

  if (!pathname.startsWith("/api/")) {
    sendError(res, 404, `no route for ${pathname}`);
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "X-Inventory-Source, X-Inventory-Endpoint, X-Catalog-Source");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  handleApi(req, res, pathname).catch((err: unknown) => {
    const status = k8sStatusCode(err) ?? 500;
    warn(`${req.method} ${pathname} failed: ${errorMessage(err)}`);
    if (!res.headersSent) sendError(res, status, errorMessage(err));
    else res.end();
  });
});

// ------------------------------------------------------------- WS acp pipe

/** Close codes a ws socket is allowed to SEND (mirrors ws's validation). */
function sendableCloseCode(code: number, fallback: number): number {
  if (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) return code;
  if (code >= 3000 && code <= 4999) return code;
  return fallback;
}

/** Close reasons are capped at 123 UTF-8 bytes by the WebSocket protocol. */
function closeReason(text: string): string {
  let reason = text.replace(/\s+/g, " ").trim().slice(0, 123);
  while (Buffer.byteLength(reason, "utf8") > 123) reason = reason.slice(0, -1);
  return reason;
}

async function bridgeAcp(client: WsWebSocket, runName: string): Promise<void> {
  const tag = `acp ${runName}:`;
  log(`${tag} browser client connected`);

  let upstream: WsWebSocket | undefined;
  let tunnel: Tunnel | undefined;
  let clientClosed = false;
  /** Frames the browser sent before the upstream socket finished opening. */
  const pendingToUpstream: { data: RawData; isBinary: boolean }[] = [];

  client.on("message", (data: RawData, isBinary: boolean) => {
    if (upstream && upstream.readyState === WsWebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    } else {
      pendingToUpstream.push({ data, isBinary });
    }
  });

  client.on("close", (code: number, reason: Buffer) => {
    clientClosed = true;
    log(`${tag} client closed (code=${code}${reason.length ? ` reason=${reason.toString()}` : ""})`);
    if (upstream) {
      if (upstream.readyState === WsWebSocket.OPEN) {
        upstream.close(sendableCloseCode(code, 1000), closeReason(reason.toString()));
      } else {
        upstream.terminate();
      }
    }
    tunnel?.close();
  });

  client.on("error", (err: Error) => {
    warn(`${tag} client socket error: ${err.message}`);
  });

  try {
    const endpoint = await runClient.waitForAcpEndpoint(runName, {
      timeoutMs: ACP_RESOLVE_TIMEOUT_MS,
    });
    if (clientClosed) return;

    let target: string;
    if (ACP_DIAL === "direct") {
      // In-cluster: the headless Service's DNS name resolves straight to
      // the pod IP; no port-forward machinery needed.
      target = `ws://${endpoint.serviceHost}:${endpoint.port}/acp`;
      log(`${tag} resolved pod ${endpoint.podName}, dialing ${endpoint.serviceHost}:${endpoint.port}`);
    } else {
      tunnel = await openTunnel(runClient.kc, NAMESPACE, endpoint.podName, endpoint.port);
      if (clientClosed) {
        tunnel.close();
        return;
      }
      log(`${tag} resolved pod ${endpoint.podName}, tunnel 127.0.0.1:${tunnel.localPort}`);
      target = `ws://127.0.0.1:${tunnel.localPort}/acp`;
    }
    // The shim injects the X-Secret-Key header the browser cannot set.
    upstream = new WsWebSocket(target, { headers: { "X-Secret-Key": endpoint.secretKey } });

    upstream.on("open", () => {
      log(`${tag} upstream open, piping frames`);
      for (const frame of pendingToUpstream.splice(0)) {
        upstream?.send(frame.data, { binary: frame.isBinary });
      }
    });

    upstream.on("message", (data: RawData, isBinary: boolean) => {
      if (client.readyState === WsWebSocket.OPEN) client.send(data, { binary: isBinary });
    });

    upstream.on("close", (code: number, reason: Buffer) => {
      log(`${tag} upstream closed (code=${code})`);
      tunnel?.close();
      if (!clientClosed) {
        client.close(
          sendableCloseCode(code, 1011),
          closeReason(reason.toString() || "upstream closed"),
        );
      }
    });

    upstream.on("error", (err: Error) => {
      warn(`${tag} upstream error: ${err.message}`);
      tunnel?.close();
      if (!clientClosed) client.close(1011, closeReason(`upstream error: ${err.message}`));
    });
  } catch (err) {
    const message =
      k8sStatusCode(err) === 404 ? `AgentRun ${runName} not found` : errorMessage(err);
    warn(`${tag} failed to reach ACP endpoint: ${message}`);
    tunnel?.close();
    if (!clientClosed) client.close(1011, closeReason(message));
  }
}

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = /^\/api\/agentruns\/([^/]+)\/acp$/.exec(url.pathname);
  if (!match) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const runName = decodeURIComponent(match[1]);
  // Always accept the upgrade first so failures surface to the browser as a
  // close frame (1011 + reason) instead of an opaque handshake error.
  wss.handleUpgrade(req, socket, head, (client) => {
    void bridgeAcp(client, runName);
  });
});

server.listen(PORT, HOST, () => {
  log(`SHIM API v1 listening on http://${HOST}:${PORT} (namespace=${NAMESPACE}, acp-dial=${ACP_DIAL})`);
  log(
    `routes: GET /healthz | GET /api/{applications,images} | POST /api/defaults | CRUD /api/{agents,skillcards,skillcollections,agentworkflows}[/:name] | GET /api/gateways[/:name] | GET|POST /api/agentworkflowruns | GET|DELETE /api/agentworkflowruns/:name | GET|POST /api/agentruns | GET|DELETE /api/agentruns/:name | WS /api/agentruns/:name/acp`,
  );
});

process.on("SIGINT", () => {
  log("shutting down");
  wss.clients.forEach((c) => c.close(1001, "hub-shim shutting down"));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_500).unref();
});
