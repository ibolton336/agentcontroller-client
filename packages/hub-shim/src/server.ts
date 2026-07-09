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
 *   GET    /api/llmproviders[/:name]    -> 200 LLMProvider[] | LLMProvider | 404
 *   GET    /api/skillcards[/:name]      -> 200 SkillCard[] | SkillCard | 404
 *   GET    /api/skillcollections[/:name]-> 200 SkillCollection[] | SkillCollection | 404
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
} from "../../agentrun-client/src/types.js";
import {
  CREDENTIAL_SOURCES_ANNOTATION,
  MANAGED_LABEL,
  PARAM_SOURCES_ANNOTATION,
  SOURCE_APPLICATION_IDENTITY,
  SOURCE_APPLICATION_REPOSITORY_BRANCH,
  SOURCE_APPLICATION_REPOSITORY_URL,
  parseSourcesAnnotation,
  type Application,
} from "../../agentic-client/src/contract/index.js";

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

/** Resources served read-only as full CRs: list + get by name. */
const READ_ONLY: Record<string, string> = {
  [PLURALS.Agent]: "Agent",
  [PLURALS.LLMProvider]: "LLMProvider",
  [PLURALS.SkillCard]: "SkillCard",
  [PLURALS.SkillCollection]: "SkillCollection",
};

/**
 * Konveyor UIs only see Agents that opt into platform management. Other
 * resource lists are unfiltered; get-by-name is never filtered.
 */
const LIST_LABEL_SELECTORS: Record<string, string> = {
  [PLURALS.Agent]: `${MANAGED_LABEL}=true`,
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
async function getApplications(): Promise<Application[]> {
  if (!HUB_URL) return STUB_APPLICATIONS;
  try {
    const [apps, identities] = await Promise.all([
      hubGet<HubApp[]>("applications"),
      hubGet<HubIdentity[]>("identities"),
    ]);
    const sourceKind = new Map(identities.map((i) => [i.id, i.kind]));
    return apps.map((a): Application => {
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
  } catch (err) {
    warn(`Hub inventory unavailable (${errorMessage(err)}); using offline stub`);
    return STUB_APPLICATIONS;
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

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
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

interface CreateRunBody {
  agentRef: string;
  params?: Record<string, string>;
  instructions?: string;
  applicationRef?: string;
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

  const app = (await getApplications()).find((a) => a.id === input.applicationRef);
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
  return {
    agentRef: body.agentRef,
    params,
    instructions: body.instructions as string | undefined,
    applicationRef: body.applicationRef as string | undefined,
  };
}

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<void> {
  const method = req.method ?? "GET";

  if (pathname === "/api/applications") {
    if (method !== "GET") return sendError(res, 405, "method not allowed");
    return sendJson(res, 200, await getApplications());
  }

  const roMatch = /^\/api\/([a-z]+)(?:\/([^/]+))?$/.exec(pathname);
  if (roMatch && READ_ONLY[roMatch[1]]) {
    if (method !== "GET") return sendError(res, 405, "method not allowed");
    const plural = roMatch[1];
    const kind = READ_ONLY[plural];
    if (!roMatch[2]) {
      return sendJson(res, 200, await listCustom(plural, kind, LIST_LABEL_SELECTORS[plural]));
    }
    const name = decodeURIComponent(roMatch[2]);
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
      try {
        input = parseCreateRunBody(await readJsonBody(req));
        sources = await resolveSources(input);
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
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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
    `routes: GET /healthz | GET /api/applications | GET /api/{agents,llmproviders,skillcards,skillcollections}[/:name] | GET|POST /api/agentruns | GET|DELETE /api/agentruns/:name | WS /api/agentruns/:name/acp`,
  );
});

process.on("SIGINT", () => {
  log("shutting down");
  wss.clients.forEach((c) => c.close(1001, "hub-shim shutting down"));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_500).unref();
});
