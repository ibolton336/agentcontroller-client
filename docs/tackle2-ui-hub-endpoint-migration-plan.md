# tackle2-ui Hub Endpoint Migration — Implementation Plan

> **2026-08-11 update:** the route namespace was renamed `/agent/*` →
> `/agentic/*` (mock, UI, and the direction agreed for hub PR #1119).
> Route strings and embedded transcripts below are the `/agent`-era
> execution record; only the prefix differs.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate tackle2-ui `feature/agent-runs` off the hub-shim contract onto the real hub `agent/*` API (per `docs/tackle2-ui-hub-endpoint-migration-design.md`), verified cluster-free against a rewritten mock hub, then ship the image and the coworker-env handoff.

**Architecture:** All agentic REST moves to the existing `/hub` proxy (`/hub/agent/...`); reads keep their CR shapes (no mappers), creates/updates switch to CR envelopes; shim-only features are removed. The mock hub is rewritten FIRST — it is the E2E test rig the rest of the plan verifies against.

**Tech Stack:** tackle2-ui (React 18 + PatternFly 6 + react-query + Express server, npm workspaces), node stdlib mock server (no deps), gh CLI for CI dispatch.

## Global Constraints

- **Two repos.** UI work: `/Users/ibolton/Development/tackle2-ui`, branch `feature/agent-runs` (starts at `8a70bf644`, pushed). Rig/docs work: `/Users/ibolton/agentcontroller-client`, branch `main`. Commit to each repo separately; `git add` explicit paths only, never `-A`.
- **No unit tests** (repo policy). The test cycle is: curl against the mock hub, tsc/lint gates, and browser verification through the launch entries. Test-first here means the mock hub (the contract fixture) lands before the UI changes.
- **Gates** (run from `/Users/ibolton/Development/tackle2-ui`): typecheck `npm run tsc -w client -- --noEmit`; lint `npm run lint -w client` (gate is `--max-warnings=20` and upstream sits at exactly 20 — **the branch must add zero new warnings**; record the baseline count in Task 3 and compare in Task 9); format `npm run format:check -w client`.
- **Webpack serve-index trap:** requesting `/` on :9000/:9003 while the FIRST webpack dev build is still compiling crashes webpack-dev-server. Never open a browser tab on a cold dev build — wait for "compiled successfully" in logs. For browser phases prefer the prod server (`npm run build -w client`, then the `tackle2-ui-prod-agentic-on` launch entry) which has no such bug. The prod Express server view-caches `index.html.ejs` — restart it after every rebuild.
- **Hub contract reference:** `jortel:tackle2-hub@agentic` @ `392a9493` — routes `/agent/{agents,skills,skillcollections,gateways,runs,workflows,workflowruns}[/:name]` + `/agent/runs/:name/acp` (WS); lists return JSON arrays of full CRs; create = POST full CR → 201 CR; update = PUT full CR → **204 no body**; run kinds have **no update/delete/cancel**; creates inject label `konveyor.io/managed=true` server-side.
- **Do not touch** `packages/hub-shim` (out of scope), any cluster (`kubectl` is not part of this plan — the rig is cluster-free), or the `@patternfly/chatbot` 6.4.x pin.
- New user-visible strings go through react-i18next `agentic.*` keys in `client/src/app/i18n/translation.json` (branch convention).
- The retired names `AGENTIC_SHIM_URL` and `/agentic` must not survive anywhere in the tackle2-ui tree (final grep gate in Task 9).

---

### Task 1: Rewrite the mock stack as a mock hub (the E2E rig)

**Files:**
- Rewrite: `/Users/ibolton/agentcontroller-client/hack/mock-inventory-stack.mjs`
- Modify: `/Users/ibolton/agentcontroller-client/.claude/launch.json` (entries `mockstack`, `tackle2-ui-dev-mockhub`, `tackle2-ui-prod-agentic-on`)

**Interfaces:**
- Produces: one HTTP server on **:18090** serving BOTH the core hub inventory the app shell needs (`/applications`, GET catch-all `[]`) AND the agent surface (`/agent/*`, CR shapes, in-memory store, logged POST/PUT bodies, WS upgrade on `/agent/runs/:name/acp`). Express proxies `/hub` → here with `^/hub` → `""`, so routes are bare.
- Consumed by: every later task's verification.

- [ ] **Step 1: Replace the file content entirely**

```js
// Cluster-free mock HUB for tackle2-ui feature/agent-runs — hub-contract era.
// One listener, :18090, fronted by the express server's /hub proxy
// ("^/hub" -> ""). Serves BOTH the core inventory the app shell needs and
// the agent/* surface per jortel:tackle2-hub@agentic (392a9493):
//   - lists return JSON arrays of full CRs
//   - create = POST full CR -> 201 CR (generateName honored,
//     konveyor.io/managed=true injected, like the hub)
//   - update = PUT full CR -> 204 NO BODY
//   - run kinds: list/get/create only (no update/delete/cancel)
//   - /agent/runs/:name/acp answers a real WebSocket upgrade (101) and
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
        gateways: ["default-gateway"],
        params: [
          { name: "repository", required: true },
          { name: "branch", required: false, default: "main" },
        ],
      },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    },
    {
      metadata: { name: "freeform-agent", creationTimestamp: ago(300) },
      spec: { image: "ghcr.io/ibolton336/agent-base:demo", gateways: ["default-gateway"] },
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
      spec: { provider: "bedrock", model: "us.anthropic.claude-sonnet-4-5" },
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
          { name: "assess", agentRef: { name: "migration-analyzer" } },
          { name: "execute", agentRef: { name: "freeform-agent" } },
        ],
      },
      status: {
        conditions: [{ type: "Ready", status: "True", reason: "AgentsReady", message: "all stage agents ready" }],
      },
    },
    {
      // No status at all — the modal treats this as selectable (fails open).
      metadata: { name: "patternfly-migration", creationTimestamp: ago(180), labels: { [MANAGED]: "true" } },
      spec: { stages: [{ name: "migrate", agentRef: { name: "freeform-agent" } }] },
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
      spec: { workflowRef: "java-ee-to-quarkus", targetBranch: "konveyor/upgrade" },
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

  // ---- agent surface ----
  const m = /^\/agent\/([a-z]+)(?:\/([^/]+))?(\/acp)?$/.exec(p);
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
    return send(res, 405, { error: `no ${req.method} route for /agent/${kind}` });
  }

  // Everything else the inventory screens enumerate (tags, archetypes,
  // assessments, waves, trackers, tasks, ...) tolerates an empty list.
  if (req.method === "GET") {
    console.log(`[hub] catch-all [] for ${p}`);
    return send(res, 200, []);
  }
  return send(res, 200, {});
});

// WS upgrade for /agent/runs/:name/acp — RFC6455 handshake, then hold the
// socket open. Connection smoke only: the UI's badge should read connected.
hub.on("upgrade", (req, socket) => {
  const ok = /^\/agent\/runs\/[^/]+\/acp$/.test(new URL(req.url, "http://localhost").pathname);
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

hub.listen(18090, () => console.log("mock hub on :18090 (core inventory + /agent/*)"));
```

- [ ] **Step 2: Run the curl matrix against it**

```bash
node /Users/ibolton/agentcontroller-client/hack/mock-inventory-stack.mjs &
sleep 1
curl -s localhost:18090/agent/agents | head -c 200                       # array with migration-analyzer
curl -s localhost:18090/agent/agents/migration-analyzer | head -c 120    # single CR
curl -s -X POST localhost:18090/agent/runs -d '{"metadata":{"generateName":"ui-","labels":{"konveyor.io/application":"1"}},"spec":{"agentRef":"freeform-agent"}}' # 201, name expanded, managed label added
curl -s -i -X PUT localhost:18090/agent/agents/freeform-agent -d '{"metadata":{"name":"freeform-agent"},"spec":{"image":"x"}}' | head -3   # HTTP/1.1 204
curl -s -i -X DELETE localhost:18090/agent/runs/single-run-coolstore | head -3   # HTTP/1.1 405 (runs not deletable)
curl -s localhost:18090/agent/nonsense | head -c 120                     # 404 unknown resource
curl -s -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" localhost:18090/agent/runs/single-run-coolstore/acp | head -4   # HTTP/1.1 101
curl -s localhost:18090/applications | head -c 120                       # 3 apps, numeric ids
kill %1
```

Expected: every annotated result as commented. Fix until so.

- [ ] **Step 3: Update launch entries** in `/Users/ibolton/agentcontroller-client/.claude/launch.json` (file already has uncommitted edits — change ONLY these three entries, leave the rest byte-identical):
  - `mockstack`: change `"port": 17080` → `"port": 18090`.
  - `tackle2-ui-dev-mockhub`: in `env`, delete `"AGENTIC_SHIM_URL"`, keep `"TACKLE_HUB_URL": "http://localhost:18090"`, add `"AGENTIC_ENABLED": "true"`.
  - `tackle2-ui-prod-agentic-on`: in `env`, delete `"AGENTIC_SHIM_URL"`, add `"TACKLE_HUB_URL": "http://localhost:18090"` and `"AGENTIC_ENABLED": "true"`.

- [ ] **Step 4: Commit (outer repo)**

```bash
cd /Users/ibolton/agentcontroller-client
git add hack/mock-inventory-stack.mjs .claude/launch.json
git commit -m "hack: mock stack speaks the hub agent/* contract

One listener on :18090 now serves core inventory plus /agent/* with CR
shapes, generateName + managed-label parity, PUT->204, run kinds
create-only, and a real WS handshake on /agent/runs/:name/acp."
```

---

### Task 2: tackle2-ui server transport — `/hub` carries agentic, `/agentic` dies

**Files:**
- Modify: `/Users/ibolton/Development/tackle2-ui/server/src/proxies.js` (delete `agentic` entry ~lines 173-186; add `ws: true` to `hub`)
- Modify: `/Users/ibolton/Development/tackle2-ui/server/src/index.js` (proxy registration ~line 29-30; upgrade handler ~line 62-65)
- Modify: `/Users/ibolton/Development/tackle2-ui/server/src/serverConfig.js`

**Interfaces:**
- Consumes: Task 1's mock on :18090.
- Produces: `/hub/agent/*` REST + WS reachable through the Express server; `AGENTIC_ENABLED` env flag (plain, default `"false"`); `AGENTIC_SHIM_URL` gone. Later tasks' client code assumes exactly this.

- [ ] **Step 1: Edit `proxies.js`** — delete the whole `agentic:` entry; change the `hub:` entry to:

```js
  hub: {
    pathFilter: "/hub",
    target: serverConfig.TACKLE_HUB_URL || "http://localhost:9002",
    logger,

    ws: true,
    changeOrigin: true,
    pathRewrite: {
      "^/hub": "",
    },

    on: {
      proxyReq: setForwardedHeader,
      proxyRes: redirectIfUnauthorized,
    },
  },
```

- [ ] **Step 2: Edit `index.js`** — replace

```js
const agenticProxy = createProxyMiddleware(proxies.agentic);
app.use(agenticProxy);
app.use(createProxyMiddleware(proxies.hub));
```

with

```js
const hubProxy = createProxyMiddleware(proxies.hub);
app.use(hubProxy);
```

and replace the upgrade block

```js
// ws:true only upgrades sockets after the middleware has seen a plain HTTP
// request; subscribe explicitly so a direct ACP WebSocket connect works even
// as the first request through the proxy.
server.on("upgrade", agenticProxy.upgrade);
```

with

```js
// ws:true only upgrades sockets after the middleware has seen a plain HTTP
// request; subscribe explicitly so a direct ACP WebSocket connect works even
// as the first request through the proxy. Scoped to the hub's ACP path —
// other upgrade traffic (e.g. webpack HMR in dev) is not ours to answer.
server.on("upgrade", (req, socket, head) => {
  if (req.url?.startsWith("/hub/agent/")) {
    hubProxy.upgrade(req, socket, head);
  }
});
```

- [ ] **Step 3: Edit `serverConfig.js`** — delete the `AGENTIC_SHIM_URL` line from `serverConfig`; replace the derived `AGENTIC_ENABLED` block (comment included) with:

```js
  // The agentic console talks to the hub's agent/* endpoints through the
  // /hub proxy; enabling it is an explicit deployment decision.
  AGENTIC_ENABLED: process.env.AGENTIC_ENABLED ?? "false",
```

- [ ] **Step 4: Transport proof against the mock** (mock from Task 1 running):

```bash
cd /Users/ibolton/Development/tackle2-ui
TACKLE_HUB_URL=http://localhost:18090 AGENTIC_ENABLED=true NODE_ENV=development PORT=9100 node server/src/index.js &
sleep 1
curl -s localhost:9100/hub/agent/agents | head -c 120    # mock's agent array
curl -s -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" localhost:9100/hub/agent/runs/single-run-coolstore/acp | head -4   # 101 through the proxy
kill %1
```

- [ ] **Step 5: Grep gate** — `grep -rn "AGENTIC_SHIM_URL\|agenticProxy\|proxies.agentic" server/` → zero hits.

- [ ] **Step 6: Commit**

```bash
cd /Users/ibolton/Development/tackle2-ui
git add server/src/proxies.js server/src/index.js server/src/serverConfig.js
git commit -m "feat(agentic): agentic traffic rides the /hub proxy

The /agentic proxy and AGENTIC_SHIM_URL are gone; the hub proxy gains
ws:true and a path-scoped upgrade handler for /hub/agent ACP sockets.
AGENTIC_ENABLED is now a plain env flag, default false."
```

---

### Task 3: REST layer cutover — hub paths + CR envelopes (no removals yet)

**Files:**
- Modify: `/Users/ibolton/Development/tackle2-ui/client/src/app/api/rest/agent-runs.ts`
- Modify: `/Users/ibolton/Development/tackle2-ui/client/src/app/api/agentic/contract.ts` (add `APPLICATION_LABEL` if absent; verify run-spec fields)

**Interfaces:**
- Consumes: `/hub/agent/*` from Task 2.
- Produces: same exported function names/signatures as today EXCEPT `updateAgent`/`updateSkillCard`/`updateSkillCollection`/`updateWorkflow` now return `Promise<void>` (hub PUT → 204). `createAgentRun(input: CreateRunInput)` / `createWorkflowRun(input: CreateWorkflowRunInput)` keep their signatures — the CR is built inside. `getAgenticAcpUrl(runName)` returns `/hub/agent/runs/:name/acp`. Constant `APPLICATION_LABEL = "konveyor.io/application"` exported from `contract.ts`.

- [ ] **Step 1: Record the lint baseline** — `cd /Users/ibolton/Development/tackle2-ui && npm run lint -w client 2>&1 | tail -3`; write the warning count down (expected: 20).

- [ ] **Step 2: Field-check the run specs.** Read `AgentRunSpec` and `AgentWorkflowRunSpec` in `contract.ts`. Rule: a `CreateRunInput`/`CreateWorkflowRunInput` field goes into `spec` only if the spec interface has it; otherwise it is dropped (env injection is the hub's job, per design D3). Known from contract.ts: `AgentRunSpec` has NO `targetBranch` (agent-run targetBranch was env-only → dropped); check whether `AgentWorkflowRunSpec` has `targetBranch` — the mock's fixtures assume it does; if contract.ts disagrees, trust contract.ts and fix the mock fixture in the same commit.

- [ ] **Step 3: Rewrite the URL constants and changed functions in `agent-runs.ts`.** Replace the header block:

```ts
const hubAgent = prefixedUrlTag("/hub/agent");

const AGENT_RUNS = hubAgent`/runs`;
const AGENTS = hubAgent`/agents`;
const SKILL_CARDS = hubAgent`/skills`;
const SKILL_COLLECTIONS = hubAgent`/skillcollections`;
const GATEWAYS = hubAgent`/gateways`;
const WORKFLOWS = hubAgent`/workflows`;
const WORKFLOW_RUNS = hubAgent`/workflowruns`;
```

(`APPLICATIONS`, `IMAGES`, `DEFAULTS` constants stay for now — Tasks 5-7 remove them with their consumers; point them at `/hub/agent` equivalents is WRONG — leave them on a dead `prefixedUrlTag("/agentic")` line until removed? No: delete the `/agentic` tag now and give the three leftovers literal dead-path strings `"/retired-with-task-5"` is ugly. Correct move: keep `const agentic = prefixedUrlTag("/agentic")` and the three constants UNTOUCHED in this task — they compile, their features visibly break against the mock (expected, they're removed in Tasks 5-7), and the Task 9 grep gate proves nothing survives.)

- [ ] **Step 4: Switch create/update/delete envelopes for config kinds.** Pattern for all four CRUD kinds (agents shown; repeat for skill cards, skill collections, workflows):

```ts
export const createAgent = (
  name: string,
  spec: AgentResourceSpec
): Promise<AgentResource> =>
  axios
    .post<AgentResource>(AGENTS, { metadata: { name }, spec })
    .then(({ data }) => data);

export const updateAgent = (name: string, spec: AgentResourceSpec): Promise<void> =>
  axios
    .put(`${AGENTS}/${encodeURIComponent(name)}`, { metadata: { name }, spec })
    .then(() => undefined);
```

Deletes are unchanged (path constants already repointed). Then check every caller of the four `update*` functions (they live in `client/src/app/queries/{agents,skills,playbooks}...` — grep `updateAgent\|updateSkillCard\|updateSkillCollection\|updateWorkflow`) and confirm no `onSuccess` handler consumes the returned resource; if one does, switch it to read from query invalidation instead (the mutation already invalidates its list query).

- [ ] **Step 5: Build run-create CRs.** Add `APPLICATION_LABEL` to `contract.ts` if `grep -n "APPLICATION_LABEL" contract.ts` is empty:

```ts
/** Stamped on runs at create so per-application views are a label selector. */
export const APPLICATION_LABEL = "konveyor.io/application";
```

Then in `agent-runs.ts`:

```ts
const paramList = (params?: Record<string, string>) =>
  params && Object.keys(params).length > 0
    ? Object.entries(params).map(([name, value]) => ({ name, value }))
    : undefined;

const runMetadata = (applicationRef?: string) => ({
  generateName: "ui-",
  ...(applicationRef ? { labels: { [APPLICATION_LABEL]: applicationRef } } : {}),
});

export const createAgentRun = (input: CreateRunInput): Promise<AgentRun> =>
  axios
    .post<AgentRun>(AGENT_RUNS, {
      metadata: runMetadata(input.applicationRef),
      spec: {
        agentRef: input.agentRef,
        ...(paramList(input.params) ? { params: paramList(input.params) } : {}),
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        ...(input.gateway ? { gateway: input.gateway } : {}),
      },
    })
    .then(({ data }) => data);

export const createWorkflowRun = (input: CreateWorkflowRunInput): Promise<AgentWorkflowRun> =>
  axios
    .post<AgentWorkflowRun>(WORKFLOW_RUNS, {
      metadata: runMetadata(input.applicationRef),
      spec: {
        workflowRef: input.workflowRef,
        ...(paramList(input.params) ? { params: paramList(input.params) } : {}),
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        ...(input.gateway ? { gateway: input.gateway } : {}),
        // targetBranch: only if Step 2 confirmed the spec field exists:
        ...(input.targetBranch ? { targetBranch: input.targetBranch } : {}),
      },
    })
    .then(({ data }) => data);
```

- [ ] **Step 6: WS URL.**

```ts
export const getAgenticAcpUrl = (runName: string): string => {
  const { protocol, host } = window.location;
  const wsProto = protocol === "https:" ? "wss:" : "ws:";
  return `${wsProto}//${host}/hub/agent/runs/${encodeURIComponent(runName)}/acp`;
};
```

- [ ] **Step 7: Typecheck** — `npm run tsc -w client -- --noEmit` → clean (update-return-type fallout from Step 4 fixed as found).

- [ ] **Step 8: Browser spot-check against the rig.** Start `mockstack`, then `npm run build -w client`, then the `tackle2-ui-prod-agentic-on` launch entry (:9102 now pointing at the mock per Task 1). Verify: Agents/Skills/Workflows/Agent runs/Workflow runs pages list the mock fixtures; Agent designer create round-trips (mock log shows `{metadata:{name},spec}`); run create from the Agent runs page shows `{metadata:{generateName:"ui-",labels:{...}},spec:{...}}` in the mock log and the new run appears in the list. Images dropdown, Load-defaults, and run Delete are EXPECTED to fail/noop — they die in Tasks 5-7.

- [ ] **Step 9: Commit**

```bash
cd /Users/ibolton/Development/tackle2-ui
git add client/src/app/api/rest/agent-runs.ts client/src/app/api/agentic/contract.ts
git commit -m "feat(agentic): REST layer speaks the hub agent/* contract

Paths move under /hub/agent with the hub's segment names; config-kind
creates/updates send CR envelopes (PUT expects 204); run creates build
the CR client-side with generateName ui- and the konveyor.io/application
label; the ACP URL rides the hub proxy."
```

---

### Task 4: Remove run Delete (hub has no run delete; cancel is future)

**Files:**
- Modify: `client/src/app/api/rest/agent-runs.ts` (delete `deleteAgentRun`, `deleteWorkflowRun`)
- Modify: `client/src/app/api/agentic/contract.ts` (`RunApi`: drop `deleteRun`, `deleteWorkflowRun`)
- Modify: `client/src/app/queries/agent-runs.ts`, `client/src/app/queries/workflow-runs.ts` (drop the delete mutations)
- Modify: every consumer `grep -rln "useDeleteAgentRunMutation\|useDeleteWorkflowRunMutation\|deleteAgentRun\|deleteWorkflowRun" client/src/app` surfaces — expect the runs list pages / detail pages row-action + confirm-dialog wiring (`agent-runs-page.tsx`, `agent-run-detail-page.tsx`, `workflow-runs-page.tsx`, `workflow-run-detail-page.tsx`).

**Interfaces:**
- Consumes: Task 3's file state.
- Produces: no run-delete symbols anywhere; runs have no destructive row/detail actions. A `TODO(cancel)` comment is NOT added — cancel wiring is tracked in the handoff doc, not the code.

- [ ] **Step 1:** Delete the two REST functions, the two `RunApi` methods, the two mutations, then chase `tsc` errors through the pages: remove the Delete kebab/row actions, their `ConfirmDialog` state, and now-unused imports/i18n lookups. Where a page's kebab becomes empty, remove the kebab.
- [ ] **Step 2: Gates** — `npm run tsc -w client -- --noEmit` clean; `grep -rn "deleteAgentRun\|deleteWorkflowRun\|deleteRun" client/src` → zero hits.
- [ ] **Step 3: Browser check** (rebuild client, restart :9102 — remember the ejs view cache): run rows and run detail pages show no Delete action; nothing else changed.
- [ ] **Step 4: Commit** — `git add -u client/src && git commit -m "feat(agentic): drop run deletion — the hub exposes no run delete"`.

---

### Task 5: Remove Load-defaults (seeding is a cluster concern now)

**Files:**
- Delete: `client/src/app/pages/agent-runs/components/LoadDefaultsButton.tsx`
- Modify: `client/src/app/api/rest/agent-runs.ts` (drop `loadDefaults`, `DEFAULTS` constant), `contract.ts` (drop `SeedResult`, `RunApi.loadDefaults`), `client/src/app/queries/agentic-catalog.ts` (drop the seed mutation), consumers per `grep -rln "LoadDefaultsButton\|loadDefaults\|SeedResult" client/src/app` (expect `agents-page.tsx`, `skills-page.tsx`, `workflows-page.tsx` toolbars + empty states).

**Interfaces:**
- Produces: empty states on Agents/Skills/Workflows pages show plain guidance text instead of a seed button. New i18n key `agentic.emptyStateSeedHint` = "Default agents, skills, and workflows are seeded on the cluster by an administrator."

- [ ] **Step 1:** Remove button component + REST fn + mutation + types; replace each empty-state `<LoadDefaultsButton/>` usage with the hint text via `t("agentic.emptyStateSeedHint")`; add the key to `client/src/app/i18n/translation.json` (alphabetical position within the `agentic` block, matching the file's existing style).
- [ ] **Step 2: Gates** — tsc clean; `grep -rn "loadDefaults\|SeedResult\|LoadDefaultsButton" client/src` → zero hits.
- [ ] **Step 3: Browser check:** empty-state pages (mock returns fixtures, so temporarily filter to a nonexistent name or check the toolbar) — no seed button anywhere; hint renders on empty states.
- [ ] **Step 4: Commit** — `git add -u client/src && git rm` the component; message `"feat(agentic): remove Load defaults — seeding is cluster-side now"`.

---

### Task 6: Image catalog → free text with built-in suggestions

**Files:**
- Modify: `client/src/app/api/rest/agent-runs.ts` (drop `getImagesWithSource`, `ImagesWithSource`, `IMAGES` constant — and now delete the leftover `const agentic = prefixedUrlTag("/agentic")` if `APPLICATIONS` is its last user, else Task 7 does), `contract.ts` (drop `AgentImage` if now unused; add `BUILTIN_AGENT_IMAGES`), `client/src/app/queries/agentic-catalog.ts` (drop image query), agent designer image field per `grep -rln "getImagesWithSource\|useFetchAgentImages\|AgentImage" client/src/app`.

**Interfaces:**
- Produces: `export const BUILTIN_AGENT_IMAGES: string[]` in `contract.ts` — values copied from the shim's builtin catalog: run `grep -n "ghcr.io\|image" /Users/ibolton/agentcontroller-client/packages/hub-shim/src/defaults.ts | head -20` and copy the image refs verbatim (expected to include `ghcr.io/ibolton336/agent-base:demo` and `ghcr.io/ibolton336/agent-java:demo`). The designer's image field: PatternFly `TextInput` + a datalist-style suggestion menu fed by `BUILTIN_AGENT_IMAGES` — reuse whatever free-text "custom image" affordance the designer already has (it exists: the catalog dropdown had a custom-escape path; invert it so free text is primary and suggestions assist).

- [ ] **Step 1:** Make the edits; keep the field label and validation as-is (image required stays required).
- [ ] **Step 2: Gates** — tsc clean; `grep -rn "getImagesWithSource\|x-catalog-source\|useFetchAgentImages" client/src` → zero.
- [ ] **Step 3: Browser check:** designer create modal — type a custom ref, pick a suggestion, both submit; mock log shows the chosen image in `spec`.
- [ ] **Step 4: Commit** — `"feat(agentic): agent image is free text with built-in suggestions"`.

---

### Task 7: Applications from core hub + label-based run filtering

**Files:**
- Modify: `client/src/app/api/rest/agent-runs.ts` (drop `getApplicationsWithSource`, `ApplicationsWithSource`, `APPLICATIONS`, and the `prefixedUrlTag("/agentic")` line — nothing may reference `/agentic` after this task), `contract.ts` (drop `AgenticApplication`), `client/src/app/queries/agentic-catalog.ts` (drop the applications query; if the file is now empty, delete it and its imports)
- Modify consumers per `grep -rln "AgenticApplication\|getApplicationsWithSource\|useFetchAgenticApplications" client/src/app`: `CreateRunModal.tsx`, `CreateWorkflowRunModal.tsx`, `applications-table.tsx`, `tab-agent-runs-content.tsx`, `BranchPanel.tsx`, `utils/agentic.ts`, both run list/detail pages.

**Interfaces:**
- Consumes: core `useFetchApplications` from `client/src/app/queries/applications.ts` (returns hub `Application` with `id: number`, `name`, `repository?: {url?, branch?}`).
- Produces: a single helper in `utils/agentic.ts`:

```ts
import type { Application } from "@app/api/models";

/** The label value runs carry: hub application id as a string. */
export const applicationLabelValue = (app: Application): string => String(app.id);

/** True when `run` belongs to `app` via the konveyor.io/application label. */
export const runBelongsToApplication = (
  run: { metadata: { labels?: Record<string, string> } },
  appId: number
): boolean => run.metadata.labels?.[APPLICATION_LABEL] === String(appId);
```

All per-application filtering (drawer tab, anywhere `spec.env` `APP_ID` was scanned) goes through `runBelongsToApplication`. `CreateRunInput.applicationRef` keeps carrying `String(app.id)`.

- [ ] **Step 1:** Swap the modal/table/drawer/BranchPanel consumers to core `Application` (`String(app.id)` where the old string id flowed; repository URL/branch reads move to `app.repository?.url` / `app.repository?.branch ?? ""` — note the hub reports an unset branch as `""`, use `||` not `??` for fallbacks). Replace the drawer tab's `spec.env APP_ID` matching (see the comment at `tab-agent-runs-content.tsx:37`) with `runBelongsToApplication`.
- [ ] **Step 2: Gates** — tsc clean; `grep -rn "AgenticApplication\|x-inventory-source\|getApplicationsWithSource\|agentic\`" client/src` → zero hits; `grep -rn "/agentic" client/src server/` → zero hits.
- [ ] **Step 3: Browser check** (rebuild + restart :9102): create modals list coolstore/tackle-testapp (binary-only-app excluded where repo required); drawer for coolstore (`/applications?activeItem=1`) shows `single-run-coolstore` and `upgrade-run-1` but NOT `run-testapp-done`; create a run from the drawer flow → it appears in the tab (label round-trip).
- [ ] **Step 4: Commit** — `"feat(agentic): applications come from the hub; run filtering rides the application label"`.

---

### Task 8: i18n + dead-key sweep and full cleanup gate

**Files:**
- Modify: `client/src/app/i18n/translation.json` (remove keys orphaned by Tasks 4-7)

- [ ] **Step 1:** For each key removed-feature candidate: `grep -rn "<key name>" client/src --include="*.tsx" --include="*.ts"` — delete from `translation.json` only keys with zero code references (candidates: the load-defaults button/toast keys, run-delete confirm keys, image-catalog provenance keys — find them by `grep -n "defaults\|delete\|catalog" client/src/app/i18n/translation.json` within the `agentic` block).
- [ ] **Step 2: Full gates** — tsc clean; `npm run lint -w client` warning count ≤ Task 3 baseline; `npm run format:check -w client` clean (run `npm run format -w client` if not).
- [ ] **Step 3: Commit** — `"chore(agentic): drop i18n keys orphaned by the hub migration"`.

---

### Task 9: Full browser matrix (design D5) and push

**Files:** none (verification + push)

- [ ] **Step 1:** Fresh `npm run build -w client`; start `mockstack` + `tackle2-ui-prod-agentic-on`; run the D5 matrix end to end: (1) five list pages + both details; (2) both create modals' logged wire payloads — CR envelope, `generateName`, application label, resolved params, gateway; (3) designer/skill/workflow CRUD round-trips incl. PUT 204 refetch; (4) drawer tab + bulk workflow launch incl. just-created run; (5) `tackle2-ui-prod-no-agentic` (:9101) — no agentic nav/routes; (6) chat panel on `single-run-coolstore` shows a connected badge (mock WS holds the socket; no frames expected).
- [ ] **Step 2:** Dev-mode HMR re-verify (design D1 guard): start `tackle2-ui-dev-mockhub`, WAIT for "compiled successfully", load :9000, touch a component file, confirm hot reload and no WS errors in the browser console.
- [ ] **Step 3:** Final grep gate across the tree: `grep -rn "AGENTIC_SHIM_URL\|/agentic" client/ server/ --include="*.ts" --include="*.tsx" --include="*.js"` → zero hits (docs/comments included).
- [ ] **Step 4:** `git push fork feature/agent-runs` (confirm remote name with `git remote -v`; the fork is `ibolton336/tackle2-ui`).

---

### Task 10: CI image rebuild

- [ ] **Step 1:** From `/Users/ibolton/agentcontroller-client` (workflow lives on main): `gh workflow run build-images.yml -f tackle2_ui_ref=feature/agent-runs`, then `gh run watch` the run to success. Fallback if dispatch 404s: edit-push `.github/workflows/build-images.yml` (its push trigger is path-scoped to itself).
- [ ] **Step 2:** Verify the manifest is fresh + multi-arch: `docker buildx imagetools inspect ghcr.io/ibolton336/tackle2-ui:demo` (or `skopeo inspect --raw docker://ghcr.io/ibolton336/tackle2-ui:demo | jq '.manifests[].platform'`) → amd64 + arm64, pushed within the hour. Record the digest for the handoff doc.

---

### Task 11: Coworker-env handoff doc

**Files:**
- Create: `/Users/ibolton/agentcontroller-client/docs/tackle2-ui-real-hub-handoff.md`

- [ ] **Step 1:** Write the doc with these sections (real values, not placeholders):
  - **Env prerequisites:** hub built from `jortel:tackle2-hub@agentic`; agentic-controller CRDs + controller + a Gateway with credentials; seed resources via `kubectl apply -f manifests/samples.yaml` from this repo (state which cluster-admin runs it — the env owner, on THEIR cluster).
  - **UI deployment:** image `ghcr.io/ibolton336/tackle2-ui:demo@<digest from Task 10>`; env `AGENTIC_ENABLED=true` plus `TACKLE_HUB_URL` per their topology (in-cluster hub service URL); note the operator-image-override or raw-Deployment patch, whichever their env uses.
  - **What works now:** all list/detail pages, config-kind CRUD, run + workflow-run creation (with application label + client-resolved params), ACP chat via the hub relay (hub must run in-cluster — the relay dials sandbox service DNS), branch panel.
  - **Pending on the hub** (each with the symptom a tester will see): run cancel (no destructive run actions in UI), token + `HUB_BASE_URL`/`APP_ID` env injection (assess-style grounding and PAT pushes fail until landed; naming drift `APP_ID` vs `HUB_APP_ID` unresolved), server-side application-label stamping (UI stamps client-side meanwhile), stage runs hidden by the `managed=true` run-list filter (workflow drill-down looks empty), WS auth once Keycloak is enabled (browser cannot send the header).
  - **Drift check before testing:** `gh api repos/konveyor/tackle2-hub/compare/main...jortel:agentic --jq '.commits[-1].sha'` — if it moved past `392a9493`, re-diff `internal/api/agent.go` route/shape changes before blaming the UI.
- [ ] **Step 2:** Commit (outer repo): `git add docs/tackle2-ui-real-hub-handoff.md && git commit -m "docs: real-hub handoff for the migrated tackle2-ui"`.

---

### Task 12: Jeff conformance comment — user approval gate

- [ ] **Step 1:** Present the draft from the bottom of `docs/tackle2-ui-hub-endpoint-migration-design.md` to Ian verbatim, updated with anything Tasks 1-11 changed (e.g. confirmed `AgentWorkflowRunSpec.targetBranch` placement from Task 3 Step 2).
- [ ] **Step 2:** ONLY after Ian approves in chat: `gh issue comment 1112 --repo konveyor/tackle2-hub --body-file <approved draft file>`. If he edits, post the edited version. If he says hold, stop — the draft stays in the design doc.

---

## Self-Review

- **Spec coverage:** D1→Task 2; D2→Task 3; D3→Task 3 (steps 2/5); D4→Tasks 4-7; D5→Tasks 1, 3, 9; D6→Tasks 10-11; Jeff draft→Task 12; HMR guard→Task 9 step 2; retired-name grep→Tasks 2/7/9. Gaps: none found.
- **Placeholder scan:** Task 3 Step 3 contains an inline decision note (leftover constants stay until their removal tasks) — that is a decision, not a placeholder. Task 6 copies image values from the shim's `defaults.ts` at execution time with the exact grep given — acceptable: the values must be read, not invented.
- **Type consistency:** `APPLICATION_LABEL` defined Task 3, consumed Task 7; `runBelongsToApplication(run, appId: number)` matches drawer usage (`app.id` is a number; label value is `String(app.id)`); update fns return `Promise<void>` consistently in Tasks 3-4.
