#!/usr/bin/env node
/**
 * Mock of the sandbox harness ACP surface (`goose serve --port 4000`).
 *
 * Speaks real ACP — it is built on @agentclientprotocol/sdk's server side,
 * the same protocol implementation the client uses — but fakes the agent:
 * no LLM calls, deterministic streamed responses. Honors the ADR 0002
 * contract:
 *   - WebSocket + streamable HTTP at :4000/acp
 *   - X-Secret-Key auth from GOOSE_SERVER__SECRET_KEY
 *   - session/new, session/load (full history replay), session/list
 *     (cross-connection, with updatedAt — the attach-to-run discovery path),
 *     session/prompt, session/cancel
 *   - GOOSE_MODE=auto suppresses request_permission
 *   - MOCK_SELF_RUN=1 simulates a harness-owned run session that appends
 *     history without live notifies (matches goose: turns are only streamed
 *     to the connection that owns them; viewers catch up via re-load)
 *
 * Replace with the real harness image when the controller lands; nothing
 * in the client changes.
 *
 * Failure modes for integration tests, triggered by tokens in the prompt:
 *   TEST_PERMISSION — force a session/request_permission round-trip
 *                     (even in GOOSE_MODE=auto) and echo the outcome
 *   TEST_CANCEL     — stream slowly until session/cancel arrives
 *   TEST_DROP       — destroy all TCP connections mid-turn (the pending
 *                     prompt request never gets a response)
 */
import http from "node:http";
import { WebSocketServer } from "ws";
import * as acp from "@agentclientprotocol/sdk";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import {
  createNodeHttpHandler,
  createNodeWebSocketUpgradeHandler,
} from "@agentclientprotocol/sdk/experimental/node";

const PORT = Number(process.env.PORT ?? 4000);
const SECRET_KEY = process.env.GOOSE_SERVER__SECRET_KEY ?? "";
const GOOSE_MODE = process.env.GOOSE_MODE ?? "auto";
// The real agentic-controller injects KONVEYOR_PROMPT / KONVEYOR_INSTRUCTIONS
// (from Agent.spec.prompt and AgentRun.spec.instructions). Fall back to the
// AGENT_* names for older/standalone invocations.
const AGENT_PROMPT =
  process.env.KONVEYOR_PROMPT ?? process.env.AGENT_PROMPT ?? "(no standing prompt)";
const AGENT_INSTRUCTIONS =
  process.env.KONVEYOR_INSTRUCTIONS ?? process.env.AGENT_INSTRUCTIONS ?? "";

const params = Object.entries(process.env)
  .filter(([k]) => k.startsWith("KONVEYOR_PARAM_"))
  .map(([k, v]) => `${k.slice("KONVEYOR_PARAM_".length).toLowerCase()}=${v}`);

/**
 * sessionId -> { history: SessionNotification[], title, updatedAt }
 * (stand-in for goose's SQLite). Module-scoped on purpose: like goose's
 * on-disk store, sessions survive across connections, so a second client
 * can session/list + session/load a session it did not create.
 */
const sessions = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

function record(session, sessionId, update) {
  session.history.push({ sessionId, update });
  session.updatedAt = new Date().toISOString();
}

async function notifyAndRecord(cx, session, sessionId, update) {
  record(session, sessionId, update);
  await cx.client.notify(acp.methods.client.session.update, { sessionId, update });
}

function buildAgent() {
  return acp
    .agent({ name: "mock-goose-harness" })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
    }))
    .onRequest(acp.methods.agent.authenticate, () => ({}))
    .onRequest(acp.methods.agent.session.new, () => {
      const sessionId = newId();
      sessions.set(sessionId, {
        history: [],
        title: null,
        updatedAt: new Date().toISOString(),
      });
      console.log(`[mock-harness] session/new -> ${sessionId}`);
      return { sessionId };
    })
    .onRequest(acp.methods.agent.session.list, () => ({
      sessions: [...sessions.entries()].map(([sessionId, s]) => ({
        sessionId,
        cwd: "/workspace",
        title: s.title ?? null,
        updatedAt: s.updatedAt ?? null,
      })),
    }))
    .onRequest(acp.methods.agent.session.load, async (cx) => {
      const session = sessions.get(cx.params.sessionId);
      if (!session) throw new Error(`unknown session ${cx.params.sessionId}`);
      console.log(
        `[mock-harness] session/load ${cx.params.sessionId}: replaying ${session.history.length} updates`,
      );
      for (const notification of session.history) {
        await cx.client.notify(acp.methods.client.session.update, notification);
      }
      return {};
    })
    .onNotification(acp.methods.agent.session.cancel, (cx) => {
      const session = sessions.get(cx.params.sessionId);
      if (session) session.cancelled = true;
      console.log(`[mock-harness] session/cancel ${cx.params.sessionId}`);
    })
    .onRequest(acp.methods.agent.session.prompt, async (cx) => {
      const { sessionId, prompt } = cx.params;
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`unknown session ${sessionId}`);
      session.cancelled = false;

      const userText = prompt
        .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
        .join(" ");
      console.log(`[mock-harness] session/prompt ${sessionId}: ${userText}`);

      // History-only (no live notify): the prompting client already renders
      // its own user bubble; replay restores it for late-joining viewers —
      // matching goose, whose session/load replays user messages too.
      record(session, sessionId, {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: userText },
      });

      const say = (text) =>
        notifyAndRecord(cx, session, sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        });

      await say(`Mock harness online. Standing prompt: ${AGENT_PROMPT.trim().slice(0, 80)}\n`);
      await sleep(150);
      if (AGENT_INSTRUCTIONS.trim()) {
        await say(`Run instructions: ${AGENT_INSTRUCTIONS.trim().slice(0, 120)}\n`);
        await sleep(150);
      }
      await say(`Run params: ${params.length ? params.join(", ") : "(none)"}\n`);
      await sleep(150);

      await notifyAndRecord(cx, session, sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "Scanning workspace",
        kind: "read",
        status: "in_progress",
        locations: [{ path: "/workspace" }],
      });
      await sleep(300);
      await notifyAndRecord(cx, session, sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: "Found 42 source files (mock)." },
          },
        ],
      });

      // A text_editor-style edit with follow-along locations (path+line, the
      // shape goose 1.39 emits for str_replace/write) and a {type:"diff"}
      // content block on completion — exercises the live files-touched path
      // without the permission flow.
      const editId = `edit_${newId().slice(0, 6)}`;
      await notifyAndRecord(cx, session, sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: editId,
        title: "Editing InventoryService.java",
        kind: "edit",
        status: "in_progress",
        locations: [
          { path: "src/main/java/com/example/InventoryService.java", line: 3 },
        ],
      });
      await sleep(300);
      await notifyAndRecord(cx, session, sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: editId,
        status: "completed",
        content: [
          {
            type: "diff",
            path: "src/main/java/com/example/InventoryService.java",
            oldText: "import javax.ejb.Stateless;\nimport javax.persistence.EntityManager;",
            newText: "import jakarta.ejb.Stateless;\nimport jakarta.persistence.EntityManager;",
          },
        ],
      });

      if (GOOSE_MODE !== "auto" || userText.includes("TEST_PERMISSION")) {
        const response = await cx.client.request(acp.methods.client.session.requestPermission, {
          sessionId,
          toolCall: {
            toolCallId: "call_2",
            title: "Write findings to .konveyor/",
            kind: "edit",
            // Standard ACP ToolCallContent diff blocks — the diff-preview
            // payload UIs render before approving.
            content: [
              {
                type: "diff",
                path: "src/main/java/com/example/InventoryService.java",
                oldText: [
                  "import javax.ejb.Stateless;",
                  "import javax.persistence.EntityManager;",
                  "",
                  "@Stateless",
                  "public class InventoryService {",
                ].join("\n"),
                newText: [
                  "import jakarta.ejb.Stateless;",
                  "import jakarta.persistence.EntityManager;",
                  "",
                  "@Stateless",
                  "public class InventoryService {",
                ].join("\n"),
              },
              {
                type: "diff",
                path: ".konveyor/java-ee-findings.md",
                oldText: null, // new file
                newText: "# Findings\n\n- javax.* imports: 2 (map to jakarta.*)\n",
              },
            ],
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        });
        await say(`Permission outcome: ${JSON.stringify(response.outcome)}\n`);
      }

      if (userText.includes("TEST_CANCEL")) {
        for (let i = 0; i < 50 && !session.cancelled; i++) {
          await say(`still working (${i})...\n`);
          await sleep(200);
        }
      }

      if (userText.includes("TEST_DROP")) {
        await say("about to lose connectivity\n");
        setTimeout(() => {
          console.log(`[mock-harness] TEST_DROP: destroying ${rawSockets.size} connection(s)`);
          for (const s of rawSockets) s.destroy();
        }, 100);
        await sleep(10_000); // response never reaches the client
      }

      if (session.cancelled) return { stopReason: "cancelled" };

      await say(`Echo of your instructions: "${userText}"\n`);
      await say("Turn complete.\n");
      return { stopReason: "end_turn" };
    });
}

/**
 * MOCK_SELF_RUN=1: simulate the harness driving its own run session — a
 * session nobody's client created, appended to on a timer (history only, no
 * live notify: exactly goose's behavior for a turn owned by another
 * connection). Lets a UI exercise the attach-and-follow flow (session/list →
 * session/load → poll) without a real harness in the pod.
 */
function startSelfRun() {
  const sessionId = `run-${newId().slice(0, 8)}`;
  const session = {
    history: [],
    title: "migration run (mock self-run)",
    updatedAt: new Date().toISOString(),
  };
  sessions.set(sessionId, session);
  console.log(`[mock-harness] MOCK_SELF_RUN: run session ${sessionId}`);

  const files = [
    "src/main/java/com/example/InventoryService.java",
    "src/main/java/com/example/CartService.java",
    "src/main/java/com/example/rest/ProductEndpoint.java",
    "src/main/webapp/WEB-INF/beans.xml",
  ];
  let step = 0;
  record(session, sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Starting migration item #1: javax → jakarta imports.\n" },
  });
  const timer = setInterval(() => {
    step += 1;
    if (step > files.length) {
      record(session, sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Item #1 complete — all imports migrated.\n" },
      });
      clearInterval(timer);
      return;
    }
    const path = files[step - 1];
    const toolCallId = `run_edit_${step}`;
    record(session, sessionId, {
      sessionUpdate: "tool_call",
      toolCallId,
      title: `Editing ${path.split("/").pop()}`,
      kind: "edit",
      status: "in_progress",
      locations: [{ path, line: 1 + step * 3 }],
    });
    record(session, sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      content: [
        {
          type: "diff",
          path,
          oldText: "import javax.enterprise.context.ApplicationScoped;",
          newText: "import jakarta.enterprise.context.ApplicationScoped;",
        },
      ],
    });
  }, 8_000);
}

const acpServer = new AcpServer({ createAgent: buildAgent });
const httpHandler = createNodeHttpHandler(acpServer);
const wss = new WebSocketServer({ noServer: true });
const upgradeHandler = createNodeWebSocketUpgradeHandler(acpServer, wss);

function authorized(req) {
  if (!SECRET_KEY) return true; // no key configured = open (dev only)
  return req.headers["x-secret-key"] === SECRET_KEY;
}

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200).end("ok");
    return;
  }
  if (!authorized(req)) {
    res.writeHead(401, { "content-type": "text/plain" }).end("invalid X-Secret-Key");
    return;
  }
  httpHandler(req, res);
});

const rawSockets = new Set();
server.on("connection", (socket) => {
  rawSockets.add(socket);
  socket.on("close", () => rawSockets.delete(socket));
});

server.on("upgrade", (req, socket, head) => {
  if (!authorized(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  upgradeHandler(req, socket, head);
});

server.listen(PORT, () => {
  console.log(
    `[mock-harness] ACP listening on :${PORT}/acp (auth=${SECRET_KEY ? "X-Secret-Key" : "OPEN"}, GOOSE_MODE=${GOOSE_MODE})`,
  );
  // MOCK_SELF_RUN for standalone runs; the param spelling reaches the pod
  // via the controller's KONVEYOR_PARAM_{NAME} injection contract.
  if (process.env.MOCK_SELF_RUN === "1" || process.env.KONVEYOR_PARAM_SELF_RUN === "1") {
    startSelfRun();
  }
});
