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
//   - run kinds: list/get/create only (no update/delete/cancel)
//   - POST /agentic/agentruns/:name/acp/nonce -> 201 nonce (single-use,
//     30s TTL), required by the WS upgrade in BOTH auth modes like the hub
//   - /agentic/agentruns/:name/acp?nonce=... answers a real WebSocket
//     upgrade (101) and speaks just enough ACP for the chat panel to reach
//     Connected (initialize, session/new, canned session/prompt); a
//     missing/stale/reused nonce is refused with 401 like the real hub
//     (mint 201, fresh dial 101, reused/bare dial 401).
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
// exactly once on it. Older controllers have no such condition — the
// `legacy-*`/unscripted fixtures keep that shape so the fallback loop is
// still exercised.
const acpCond = (listening, msg) => ({
  type: "ACPReady",
  status: listening ? "True" : "False",
  reason: listening ? "Listening" : "NotListening",
  message: msg ?? (listening ? "ACP endpoint accepts connections" : "Pod is Running but not Ready"),
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
      // ACPReady): the panel's fallback loop must ride out refused dials
      // without ever showing a failure, then connect.
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
      status: { phase: "Failed", startTime: ago(300), completionTime: ago(295) },
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
    // ACPReady at all — the UI's fallback dial loop has to ride this out.
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
// The run as the hub would serve it right now (scripted status applied).
const runView = (run, start = false) => {
  const ms = scriptClock(run.metadata.name, start);
  const status = ms === undefined ? undefined : SCRIPTED[run.metadata.name].status?.(ms);
  return status ? { ...run, status } : run;
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
let sessionCounter = 0;
const speakAcp = (socket, name, behavior) => {
  let buf = Buffer.alloc(0);
  let dropTimer;
  const reply = (id, result) => socket.write(wsText({ jsonrpc: "2.0", id, result }));
  const fail = (id, code, message) =>
    socket.write(wsText({ jsonrpc: "2.0", id, error: { code, message } }));
  const notify = (method, params) => socket.write(wsText({ jsonrpc: "2.0", method, params }));
  const handle = (msg) => {
    const { id, method, params } = msg;
    console.log(`[hub] ACP ${name} <- ${method}${id === undefined ? " (notification)" : ""}`);
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
  socket.on("close", () => clearTimeout(dropTimer));
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
