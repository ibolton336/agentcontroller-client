// Cluster-free mock HUB for tackle2-ui feature/agent-runs — hub-contract era.
// One listener, :18090, fronted by the express server's /hub proxy
// ("^/hub" -> ""). Serves BOTH the core inventory the app shell needs and
// the agentic/* surface per jortel:tackle2-hub@agentic (envelopes verified
// at 392a9493; the /agent -> /agentic prefix rename landed upstream at
// 7751e27d and this mock matches it):
//   - lists return JSON arrays of full CRs
//   - create = POST full CR -> 201 CR (generateName honored,
//     konveyor.io/managed=true injected, like the hub)
//   - update = PUT full CR -> 204 NO BODY
//   - run kinds: list/get/create only (no update/delete/cancel)
//   - /agentic/runs/:name/acp answers a real WebSocket upgrade (101) and
//     holds the socket open — connection smoke only, no ACP frames.
// Every request is logged; POST/PUT bodies in full — the wire-shape proof.

import http from "node:http";
import crypto from "node:crypto";

const now = () => new Date().toISOString();
const ago = (mins) => new Date(Date.now() - mins * 60_000).toISOString();

const MANAGED = "konveyor.io/managed";
const APPLICATION = "konveyor.io/application";

// ---------------------------------------------------------------- fixtures

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
      },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    },
    {
      metadata: { name: "freeform-agent", creationTimestamp: ago(300) },
      spec: { image: "ghcr.io/ibolton336/agent-base:demo", gateways: [{ ref: "default-gateway" }] },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    },
  ],
  skills: [
    {
      metadata: { name: "analyze-issues", creationTimestamp: ago(390), labels: { [MANAGED]: "true" } },
      spec: { description: "Fetch and rank analysis insights." },
    },
  ],
  skillcollections: [
    {
      metadata: { name: "java-migration", creationTimestamp: ago(390), labels: { [MANAGED]: "true" } },
      spec: { skills: ["analyze-issues"] },
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
  ],
  workflows: [
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
  ],
  runs: [
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
  ],
};

// Run kinds are create-only (no PUT/DELETE) — hub parity.
const CONFIG_KINDS = ["agents", "skills", "skillcollections", "gateways", "workflows"];
const RUN_KINDS = ["runs", "workflowruns"];

let createCounter = 0;

const applications = [
  {
    id: 1,
    name: "coolstore",
    description: "Java EE monolith storefront",
    repository: { kind: "git", url: "https://github.com/ibolton336/coolstore.git", branch: "main" },
    tags: [],
  },
  { id: 2, name: "binary-only-app", description: "No repository — the bulk-run exclusion case", tags: [] },
  {
    id: 3,
    name: "tackle-testapp",
    description: "Test app on a develop branch",
    repository: { kind: "git", url: "https://github.com/konveyor/tackle-testapp.git", branch: "develop" },
    tags: [],
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

// -------------------------------------------------------------- mock hub

const hub = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  console.log(`[hub] ${req.method} ${req.url}`);

  // ---- core inventory ----
  if (req.method === "GET" && p === "/applications") return send(res, 200, applications);

  // ---- agentic surface ----
  const m = /^\/agentic\/([a-z]+)(?:\/([^/]+))?(\/acp)?$/.exec(p);
  if (m) {
    const [, kind, name, acp] = m;
    const known = CONFIG_KINDS.includes(kind) || RUN_KINDS.includes(kind);
    if (!known) return send(res, 404, { error: `unknown agent resource "${kind}"` });
    const list = store[kind];

    if (acp) return send(res, 400, { error: "acp is websocket-only (see upgrade handler)" });

    if (req.method === "GET" && !name) return send(res, 200, list);
    if (req.method === "GET") {
      const item = list.find((r) => r.metadata.name === name);
      return item ? send(res, 200, item) : send(res, 404, { error: `${kind}/${name} not found` });
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

// WS upgrade for /agentic/runs/:name/acp — RFC6455 handshake, then hold the
// socket open. Connection smoke only: the ChatPanel's dial must land here
// (logged as "WS upgraded"); with no ACP frames answered the panel stays
// Connecting and periodically re-dials.
hub.on("upgrade", (req, socket) => {
  const ok = /^\/agentic\/runs\/[^/]+\/acp$/.test(new URL(req.url, "http://localhost").pathname);
  const key = req.headers["sec-websocket-key"];
  if (!ok || !key) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
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
  console.log(`[hub] WS upgraded: ${req.url}`);
  socket.on("data", () => {}); // ignore frames; smoke only
  socket.on("error", () => {});
});

hub.listen(18090, () => console.log("mock hub on :18090 (core inventory + /agentic/*)"));
