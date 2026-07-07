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
 *   GET    /api/agents[/:name]          -> 200 Agent[] | Agent | 404
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
  type AgentRun,
  type AgentRunSpec,
} from "../../agentrun-client/src/types.js";

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
): Promise<T[]> {
  const res = (await custom.listNamespacedCustomObject({
    group: GROUP,
    version: VERSION,
    namespace: NAMESPACE,
    plural,
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

// ---------------------------------------------------------------- HTTP api

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
    if (size > 1_048_576) throw new Error("request body too large (max 1 MiB)");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) throw new Error("request body is empty; expected JSON");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("request body is not valid JSON");
  }
}

interface CreateRunBody {
  agentRef: string;
  params?: Record<string, string>;
  instructions?: string;
}

/** Validates the POST /api/agentruns body; throws with a client-facing message. */
function parseCreateRunBody(raw: unknown): CreateRunBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("body must be a JSON object: {agentRef, params?, instructions?}");
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.agentRef !== "string" || body.agentRef.trim() === "") {
    throw new Error("agentRef is required and must be a non-empty string");
  }
  let params: Record<string, string> | undefined;
  if (body.params !== undefined) {
    if (!body.params || typeof body.params !== "object" || Array.isArray(body.params)) {
      throw new Error("params must be an object of string values");
    }
    params = {};
    for (const [key, value] of Object.entries(body.params as Record<string, unknown>)) {
      if (typeof value !== "string") {
        throw new Error(`params.${key} must be a string`);
      }
      params[key] = value;
    }
  }
  if (body.instructions !== undefined && typeof body.instructions !== "string") {
    throw new Error("instructions must be a string");
  }
  return { agentRef: body.agentRef, params, instructions: body.instructions as string | undefined };
}

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<void> {
  const method = req.method ?? "GET";

  const roMatch = /^\/api\/([a-z]+)(?:\/([^/]+))?$/.exec(pathname);
  if (roMatch && READ_ONLY[roMatch[1]]) {
    if (method !== "GET") return sendError(res, 405, "method not allowed");
    const plural = roMatch[1];
    const kind = READ_ONLY[plural];
    if (!roMatch[2]) return sendJson(res, 200, await listCustom(plural, kind));
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
      try {
        input = parseCreateRunBody(await readJsonBody(req));
      } catch (err) {
        return sendError(res, 400, errorMessage(err));
      }
      const spec: AgentRunSpec = { agentRef: input.agentRef };
      if (input.params) {
        spec.params = Object.entries(input.params).map(([name, value]) => ({ name, value }));
      }
      if (input.instructions !== undefined) spec.instructions = input.instructions;
      const run = await runClient.createAgentRun(spec, { generateName: "ui-" });
      log(`created AgentRun ${run.metadata.name} (agentRef=${input.agentRef})`);
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
    `routes: GET /healthz | GET /api/{agents,llmproviders,skillcards,skillcollections}[/:name] | GET|POST /api/agentruns | GET|DELETE /api/agentruns/:name | WS /api/agentruns/:name/acp`,
  );
});

process.on("SIGINT", () => {
  log("shutting down");
  wss.clients.forEach((c) => c.close(1001, "hub-shim shutting down"));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_500).unref();
});
