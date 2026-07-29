import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  AlertActionLink,
  Button,
  ExpandableSection,
  Label,
  Spinner,
  TextArea,
} from "@patternfly/react-core";
import CheckCircleIcon from "@patternfly/react-icons/dist/esm/icons/check-circle-icon";
import ExclamationCircleIcon from "@patternfly/react-icons/dist/esm/icons/exclamation-circle-icon";
import {
  AcpSession,
  parseToolCallDiffs,
  parseToolCallLocations,
} from "@konveyor/agentic-client/acp";
import type {
  PermissionOutcome,
  PermissionRequest,
  SessionInfo,
  SessionUpdate,
  ToolCallDiff,
  ToolCallLocation,
} from "@konveyor/agentic-client/acp";
import { isTerminalPhase, waitForRunning } from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage } from "../format";

// ------------------------------------------------------------- chat model

interface UserItem {
  kind: "user";
  id: number;
  text: string;
}
interface AgentItem {
  kind: "agent";
  id: number;
  text: string;
}
interface ThoughtItem {
  kind: "thought";
  id: number;
  text: string;
}
interface ToolItem {
  kind: "tool";
  id: number;
  toolCallId: string;
  title: string;
  /** ACP ToolKind (read/edit/delete/…): drives the files-ticker filter. */
  toolKind?: string;
  status: string;
  detail: string;
  /** Files the tool is touching (ACP ToolCallLocation "follow-along"). */
  locations?: ToolCallLocation[];
  /** File modifications carried as {type:"diff"} content blocks. */
  diffs?: ToolCallDiff[];
}
interface PermissionItem {
  kind: "permission";
  id: number;
  title?: string;
  /** File modifications to preview before answering (ACP diff blocks). */
  diffs?: ToolCallDiff[];
  options: PermissionRequest["options"];
  /** optionId chosen by the user, or "cancelled". Unset while pending. */
  chosen?: string;
}
interface StopItem {
  kind: "stop";
  id: number;
  stopReason: string;
}
interface ErrorItem {
  kind: "error";
  id: number;
  message: string;
}

type ChatItem = UserItem | AgentItem | ThoughtItem | ToolItem | PermissionItem | StopItem | ErrorItem;

type ConnState =
  | { kind: "waiting"; message: string }
  | { kind: "connecting" }
  | { kind: "connected"; sessionId: string }
  | { kind: "disconnected" }
  | { kind: "failed"; message: string }
  | { kind: "finished"; phase: string };

// -------------------------------------------------- session/update mapping

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Text of an ACP content block ({type:"text", text}). */
function contentText(content: unknown): string {
  if (isRecord(content) && content.type === "text" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

/** Text carried by tool_call_update.content: [{type:"content", content:{...}}]. */
function toolUpdateText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (isRecord(c) && c.type === "content" ? contentText(c.content) : ""))
    .filter(Boolean)
    .join("\n");
}

/** Pure reducer from an ACP session/update onto the chat item list. */
function reduceUpdate(items: ChatItem[], u: SessionUpdate, nextId: () => number): ChatItem[] {
  switch (u.sessionUpdate) {
    case "agent_message_chunk": {
      const text = contentText(u.content);
      if (!text) return items;
      const last = items[items.length - 1];
      if (last && last.kind === "agent") {
        return [...items.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...items, { kind: "agent", id: nextId(), text }];
    }
    case "user_message_chunk": {
      // Replayed history includes the user's side of each turn; without this
      // case a session/load reload would silently drop the user's messages.
      const text = contentText(u.content);
      if (!text) return items;
      const last = items[items.length - 1];
      if (last && last.kind === "user") {
        return [...items.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...items, { kind: "user", id: nextId(), text }];
    }
    case "agent_thought_chunk": {
      const text = contentText(u.content);
      if (!text) return items;
      const last = items[items.length - 1];
      if (last && last.kind === "thought") {
        return [...items.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...items, { kind: "thought", id: nextId(), text }];
    }
    case "tool_call": {
      return [
        ...items,
        {
          kind: "tool",
          id: nextId(),
          toolCallId: str(u.toolCallId),
          title: str(u.title) || "Tool call",
          toolKind: str(u.kind) || undefined,
          status: str(u.status) || "pending",
          detail: toolUpdateText(u.content),
          locations: parseToolCallLocations(u.locations),
          diffs: parseToolCallDiffs(u.content),
        },
      ];
    }
    case "tool_call_update": {
      const toolCallId = str(u.toolCallId);
      let idx = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it && it.kind === "tool" && it.toolCallId === toolCallId) {
          idx = i;
          break;
        }
      }
      if (idx < 0) return items;
      const tool = items[idx] as ToolItem;
      const extra = toolUpdateText(u.content);
      // locations follow ACP replace semantics: absent = keep, [] = cleared.
      // Diffs stay sticky — updates whose content is just text must not wipe
      // a previously shown file modification.
      const locations = parseToolCallLocations(u.locations);
      const diffs = parseToolCallDiffs(u.content);
      const next: ToolItem = {
        ...tool,
        status: str(u.status) || tool.status,
        title: str(u.title) || tool.title,
        toolKind: str(u.kind) || tool.toolKind,
        detail: extra ? (tool.detail ? `${tool.detail}\n${extra}` : extra) : tool.detail,
        locations: locations !== undefined ? locations : tool.locations,
        diffs: diffs && diffs.length > 0 ? diffs : tool.diffs,
      };
      return [...items.slice(0, idx), next, ...items.slice(idx + 1)];
    }
    default:
      // plan / available_commands_update / etc. — out of prototype scope
      return items;
  }
}

/**
 * Most recently active session wins (ISO 8601 compares lexicographically).
 * During a run this is the harness's session — the one worth following.
 * Only sessions that report updatedAt qualify: without a timestamp the
 * follow-poll has no change signal, so auto-attach would freeze while
 * claiming to refresh.
 */
function pickLatestSession(sessions: SessionInfo[]): SessionInfo | null {
  let best: SessionInfo | null = null;
  for (const s of sessions) {
    if (s.updatedAt == null) continue;
    if (!best || s.updatedAt > (best.updatedAt ?? "")) best = s;
  }
  return best;
}

/** How often a following viewer re-checks session/list for new activity. */
const FOLLOW_POLL_MS = 5_000;

// ----------------------------------------------------------------- panel

interface ChatPanelProps {
  api: ShimClient;
  runName: string;
}

export function ChatPanel({ api, runName }: ChatPanelProps) {
  const [conn, setConn] = useState<ConnState>({ kind: "waiting", message: "checking run status…" });
  const [items, setItems] = useState<ChatItem[]>([]);
  const [session, setSession] = useState<AcpSession | null>(null);
  const [input, setInput] = useState("");
  const [turnActive, setTurnActive] = useState(false);
  const [attempt, setAttempt] = useState(0); // bumped by Retry / Reconnect
  // True when attached to an agent-owned session found via session/list
  // (the run's own transcript) rather than one this panel created.
  const [following, setFollowing] = useState(false);
  // Mirrors reloadingRef for rendering (composer gating).
  const [reloading, setReloading] = useState(false);

  const idRef = useRef(0);
  const sessionRef = useRef<AcpSession | null>(null);
  const lastSessionIdRef = useRef<string | null>(null);
  const followedUpdatedAtRef = useRef<string | null>(null);
  const reloadingRef = useRef(false);
  const followingRef = useRef(false);
  const turnActiveRef = useRef(false);
  // Non-null while a follow reload's session/load replay is streaming:
  // updates buffer here and swap in atomically when the load settles, so a
  // reload never renders a half-empty transcript or interleaves two replays.
  const replayRef = useRef<SessionUpdate[] | null>(null);
  const permissionResolvers = useRef(new Map<number, (o: PermissionOutcome) => void>());
  const logRef = useRef<HTMLDivElement | null>(null);

  const nextId = () => ++idRef.current;

  const pushItem = (item: ChatItem) => setItems((prev) => [...prev, item]);

  const handleUpdate = useCallback((u: SessionUpdate) => {
    if (replayRef.current) {
      replayRef.current.push(u);
      return;
    }
    setItems((prev) => reduceUpdate(prev, u, () => ++idRef.current));
  }, []);

  // Render permission asks inline; the returned promise resolves when the
  // user clicks an option (see choosePermission).
  const handlePermission = useCallback((r: PermissionRequest): Promise<PermissionOutcome> => {
    return new Promise((resolve) => {
      const id = ++idRef.current;
      permissionResolvers.current.set(id, resolve);
      setItems((prev) => [
        ...prev,
        {
          kind: "permission",
          id,
          title: r.toolCall?.title,
          diffs: r.toolCall?.diffs,
          options: r.options,
        },
      ]);
    });
  }, []);

  const choosePermission = (id: number, optionId: string | null) => {
    const resolve = permissionResolvers.current.get(id);
    if (!resolve) return;
    permissionResolvers.current.delete(id);
    resolve(
      optionId
        ? { outcome: { outcome: "selected", optionId } }
        : { outcome: { outcome: "cancelled" } },
    );
    setItems((prev) =>
      prev.map((it) =>
        it.id === id && it.kind === "permission" ? { ...it, chosen: optionId ?? "cancelled" } : it,
      ),
    );
  };

  // Connect flow: wait for Running (status line), open the shim's ACP tunnel,
  // then new-session (or load-session to replay history after a reconnect).
  useEffect(() => {
    let disposed = false;
    const abort = new AbortController();
    let localSession: AcpSession | null = null;

    const connect = async () => {
      setFollowing(false);
      setConn({ kind: "waiting", message: "checking run status…" });
      const current = await api.getRun(runName);
      const phase = current.status?.phase ?? "Pending";
      if (isTerminalPhase(phase)) {
        setConn({ kind: "finished", phase });
        return;
      }
      await waitForRunning(api, runName, {
        signal: abort.signal,
        onPhase: (p, elapsedMs) => {
          if (!disposed) {
            setConn({
              kind: "waiting",
              message: `waiting for sandbox (${p}, ${Math.round(elapsedMs / 1000)}s)…`,
            });
          }
        },
      });
      if (disposed) return;
      setConn({ kind: "connecting" });
      localSession = await AcpSession.connect({
        url: api.acpUrl(runName),
        callbacks: { onUpdate: handleUpdate, onPermissionRequest: handlePermission },
      });
      if (disposed) {
        void localSession.close();
        return;
      }
      sessionRef.current = localSession;
      localSession.onClosed(() => {
        if (!disposed) {
          setConn({ kind: "disconnected" });
          setSession(null);
        }
      });
      // Session selection policy:
      // 1. A panel that was CHATTING (not following) resumes its own session
      //    after a drop — reconnect must never silently switch the user's
      //    conversation to whichever session is newest.
      // 2. Otherwise attach to the most recently active listed session —
      //    during a run that is the session the harness is driving, so the
      //    panel shows the run's live transcript instead of an empty
      //    parallel one. (The agent lazily activates on-disk sessions for
      //    this connection on session/load.) "Following" only applies when
      //    that session isn't the panel's own previous one.
      // 3. Fall back to resume-prior, then session/new.
      let sessionId: string | null = null;
      let attached = false;
      const prior = lastSessionIdRef.current;
      const wasFollowing = followingRef.current;
      if (prior && !wasFollowing && localSession.loadSessionSupported) {
        setItems([]); // the replay repopulates the transcript
        try {
          await localSession.loadSession(prior);
          sessionId = prior;
        } catch {
          sessionId = null;
        }
      }
      if (!sessionId && localSession.listSessionsSupported && localSession.loadSessionSupported) {
        try {
          const latest = pickLatestSession(await localSession.listSessions());
          if (latest && !disposed) {
            setItems([]); // the replay repopulates the transcript
            await localSession.loadSession(latest.sessionId, latest.cwd);
            followedUpdatedAtRef.current = latest.updatedAt ?? null;
            sessionId = latest.sessionId;
            attached = latest.sessionId !== prior || wasFollowing;
          }
        } catch {
          sessionId = null; // fall through to the pre-existing flow
        }
      }
      // Otherwise resume the previous session after a drop — the agent
      // replays its history as session/update notifications.
      if (!sessionId) {
        setItems([]); // discard any partial replay from a failed attach
        if (prior && localSession.loadSessionSupported) {
          try {
            await localSession.loadSession(prior);
            sessionId = prior;
          } catch {
            sessionId = await localSession.newSession();
          }
        } else {
          sessionId = await localSession.newSession();
        }
      }
      lastSessionIdRef.current = sessionId;
      if (!disposed) {
        followingRef.current = attached;
        setFollowing(attached);
        setSession(localSession);
        setConn({ kind: "connected", sessionId });
      }
    };

    connect().catch((err) => {
      if (!disposed) setConn({ kind: "failed", message: errorMessage(err) });
    });

    return () => {
      disposed = true;
      abort.abort();
      const s = sessionRef.current ?? localSession;
      sessionRef.current = null;
      if (s) void s.close();
      setSession(null);
      setTurnActive(false);
    };
  }, [api, runName, attempt, handleUpdate, handlePermission]);

  // Follow the run: goose only pushes live updates to the connection that
  // owns the turn, so a viewer catches up by re-loading the session whenever
  // session/list reports new activity (updatedAt advanced or a newer session
  // appeared). A self-scheduling timeout chain — ticks can never overlap,
  // unlike setInterval, whose ticks would race when a round-trip spans the
  // interval. Suppressed while the user's own turn is streaming (refs, not
  // state deps, so a prompt mid-reload doesn't cancel the reload).
  useEffect(() => {
    if (conn.kind !== "connected" || !following || !session) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        if (cancelled || turnActiveRef.current || reloadingRef.current) return;
        const latest = pickLatestSession(await session.listSessions());
        if (cancelled || turnActiveRef.current || reloadingRef.current) return;
        const advanced =
          latest != null &&
          latest.updatedAt != null &&
          (latest.sessionId !== session.sessionId ||
            (followedUpdatedAtRef.current ?? "") < latest.updatedAt);
        if (!latest || !advanced) return;
        reloadingRef.current = true;
        setReloading(true);
        replayRef.current = []; // buffer the replay; swap in atomically below
        try {
          await session.loadSession(latest.sessionId, latest.cwd);
          if (!cancelled) {
            const replay = replayRef.current ?? [];
            setItems(replay.reduce((acc, u) => reduceUpdate(acc, u, () => ++idRef.current), [] as ChatItem[]));
            followedUpdatedAtRef.current = latest.updatedAt ?? null;
            lastSessionIdRef.current = latest.sessionId;
            setConn({ kind: "connected", sessionId: latest.sessionId });
          }
        } finally {
          replayRef.current = null;
          reloadingRef.current = false;
          setReloading(false);
        }
      } catch {
        // transient (e.g. agent busy mid-turn) — try again next tick
      } finally {
        if (!cancelled) timer = setTimeout(() => void tick(), FOLLOW_POLL_MS);
      }
    };
    timer = setTimeout(() => void tick(), FOLLOW_POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [conn.kind, following, session]);

  // Keep the transcript pinned to the bottom as updates stream in.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, conn]);

  const send = async () => {
    const text = input.trim();
    const s = session;
    // reloading gate: mid-reload the transcript is being swapped and the
    // session id may be changing — a prompt would race both.
    if (!text || !s || turnActive || reloadingRef.current) return;
    setInput("");
    pushItem({ kind: "user", id: nextId(), text });
    turnActiveRef.current = true;
    setTurnActive(true);
    try {
      const stopReason = await s.prompt(text);
      pushItem({ kind: "stop", id: nextId(), stopReason });
    } catch (err) {
      pushItem({ kind: "error", id: nextId(), message: errorMessage(err) });
    } finally {
      turnActiveRef.current = false;
      setTurnActive(false);
    }
  };

  // Opt out of following: start a fresh interactive session so the user's
  // prompts stop landing in the harness-owned run session.
  const startFreshChat = async () => {
    const s = sessionRef.current;
    if (!s || turnActive || reloadingRef.current) return;
    try {
      const id = await s.newSession();
      lastSessionIdRef.current = id;
      followedUpdatedAtRef.current = null;
      followingRef.current = false;
      setFollowing(false);
      setItems([]);
      setConn({ kind: "connected", sessionId: id });
    } catch (err) {
      pushItem({ kind: "error", id: nextId(), message: errorMessage(err) });
    }
  };

  const reconnectLabel = lastSessionIdRef.current ? "Reconnect" : "Retry";

  return (
    <div className="chat-panel">
      <div className="chat-status">
        {conn.kind === "waiting" && (
          <>
            <Spinner size="sm" aria-label="Waiting" /> <span>{conn.message}</span>
          </>
        )}
        {conn.kind === "connecting" && (
          <>
            <Spinner size="sm" aria-label="Connecting" /> <span>connecting to ACP…</span>
          </>
        )}
        {conn.kind === "connected" && (
          <>
            <Label color="green">connected</Label>
            {following && <Label color="blue">following run session</Label>}
            <span className="chat-status-detail">
              session {conn.sessionId}
              {following ? " — transcript refreshes as the run progresses" : ""}
            </span>
            {following && (
              <Button variant="link" isInline onClick={() => void startFreshChat()}>
                new chat session
              </Button>
            )}
          </>
        )}
        {conn.kind === "finished" && (
          <Alert variant="info" isInline isPlain title={`Run already finished (${conn.phase}) — chat unavailable.`} />
        )}
        {conn.kind === "disconnected" && (
          <Alert
            variant="warning"
            isInline
            isPlain
            title="Disconnected from the agent"
            actionLinks={
              <AlertActionLink onClick={() => setAttempt((a) => a + 1)}>
                {reconnectLabel}
              </AlertActionLink>
            }
          />
        )}
        {conn.kind === "failed" && (
          <Alert
            variant="danger"
            isInline
            isPlain
            title={`Connection failed: ${conn.message}`}
            actionLinks={
              <AlertActionLink onClick={() => setAttempt((a) => a + 1)}>
                {reconnectLabel}
              </AlertActionLink>
            }
          />
        )}
      </div>

      <FilesTouchedTicker items={items} />

      <div className="chat-log" ref={logRef}>
        {items.length === 0 && conn.kind === "connected" && (
          <div className="chat-meta">
            {following
              ? "Attached to the run session — waiting for agent activity…"
              : "Connected — send a message to start the turn."}
          </div>
        )}
        {items.map((item, i) => (
          // Tool items key by toolCallId (+ position for repeated ids) so
          // their expansion state survives a follow reload's replay swap.
          <ChatItemView
            key={item.kind === "tool" ? `tool:${item.toolCallId}:${i}` : `${item.kind}:${item.id}`}
            item={item}
            onPermission={choosePermission}
          />
        ))}
      </div>

      <div className="chat-input-row">
        <div className="chat-input-text">
          <TextArea
            aria-label="Message to the agent"
            value={input}
            onChange={(_e, v) => setInput(v)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            resizeOrientation="vertical"
            isDisabled={!session || turnActive || reloading}
            placeholder={
              following
                ? "Message the run's session… (or start a new chat session above)"
                : "Message the agent… (tip: include TEST_PERMISSION to exercise the approval flow)"
            }
          />
        </div>
        <div className="chat-input-actions">
          <Button
            variant="primary"
            onClick={() => void send()}
            isDisabled={!session || turnActive || reloading || !input.trim()}
            isLoading={turnActive}
          >
            Send
          </Button>
          {turnActive && (
            <Button variant="secondary" onClick={() => void sessionRef.current?.cancel()}>
              Cancel turn
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- item views

/** Trailing path segment, for compact display. */
function baseName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/**
 * Live "files being touched" strip: every path seen in tool locations or
 * diff blocks, most recent activity last. This is the ACP follow-along
 * data goose already streams — visible before any commit exists.
 */
function FilesTouchedTicker({ items }: { items: ChatItem[] }) {
  const seen = new Map<string, ToolCallLocation>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    // Read-tool locations are often directories or mere lookups — the
    // ticker tracks files being CHANGED. (goose leaves kind defaulted, so
    // unknown kinds pass.)
    if (item.toolKind !== "read") {
      for (const loc of item.locations ?? []) {
        seen.delete(loc.path); // re-insert so latest activity sorts last
        seen.set(loc.path, loc);
      }
    }
    for (const d of item.diffs ?? []) {
      if (!seen.has(d.path)) seen.set(d.path, { path: d.path });
    }
  }
  if (seen.size === 0) return null;
  const paths = [...seen.values()];
  const shown = paths.slice(-6);
  return (
    <div className="chat-files-ticker">
      <span className="chat-files-ticker-label">Files</span>
      {paths.length > shown.length && (
        <span className="chat-files-ticker-more">+{paths.length - shown.length} more</span>
      )}
      {shown.map((loc) => (
        <Label key={loc.path} isCompact variant="outline" title={loc.path}>
          <code>
            {baseName(loc.path)}
            {loc.line != null ? `:${loc.line}` : ""}
          </code>
        </Label>
      ))}
    </div>
  );
}

type DiffLine = { op: "add" | "del" | "ctx"; text: string };

/** Classic LCS line diff — fine at permission-preview sizes. */
function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const m = a.length;
  const n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ op: "ctx", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ op: "del", text: a[i++] });
    } else {
      out.push({ op: "add", text: b[j++] });
    }
  }
  while (i < m) out.push({ op: "del", text: a[i++] });
  while (j < n) out.push({ op: "add", text: b[j++] });
  return out;
}

function DiffPreview({ diff }: { diff: ToolCallDiff }) {
  const isNewFile = diff.oldText == null;
  const lines: DiffLine[] = isNewFile
    ? diff.newText.split("\n").map((text) => ({ op: "add" as const, text }))
    : diffLines(diff.oldText ?? "", diff.newText);
  return (
    <div className="chat-diff">
      <div className="chat-diff-path">
        <code>{diff.path}</code>
        {isNewFile ? <Label color="green">new file</Label> : null}
      </div>
      <pre className="chat-diff-body">
        {lines.map((l, idx) => (
          <div key={idx} className={`chat-diff-line chat-diff-${l.op}`}>
            <span className="chat-diff-sign">
              {l.op === "add" ? "+" : l.op === "del" ? "-" : " "}
            </span>
            {l.text}
          </div>
        ))}
      </pre>
    </div>
  );
}

function ToolStatusIcon({ status }: { status: string }) {
  if (status === "completed") {
    return <CheckCircleIcon style={{ color: "#3e8635" }} aria-label="completed" />;
  }
  if (status === "failed" || status === "error") {
    return <ExclamationCircleIcon style={{ color: "#c9190b" }} aria-label="failed" />;
  }
  return <Spinner size="sm" aria-label={status} />;
}

function toolStatusColor(status: string): "green" | "red" | "blue" {
  if (status === "completed") return "green";
  if (status === "failed" || status === "error") return "red";
  return "blue";
}

function ChatItemView({
  item,
  onPermission,
}: {
  item: ChatItem;
  onPermission: (id: number, optionId: string | null) => void;
}) {
  switch (item.kind) {
    case "user":
      return <div className="chat-bubble chat-user">{item.text}</div>;
    case "agent":
      return <div className="chat-bubble chat-agent">{item.text}</div>;
    case "thought":
      return <div className="chat-bubble chat-thought">{item.text}</div>;
    case "stop":
      return <div className="chat-meta">turn ended — {item.stopReason}</div>;
    case "error":
      return (
        <Alert variant="danger" isInline title="Chat error">
          {item.message}
        </Alert>
      );
    case "tool": {
      const firstLoc = item.locations?.[0];
      return (
        <div className="chat-tool">
          <ExpandableSection
            toggleContent={
              <span className="chat-tool-toggle">
                <ToolStatusIcon status={item.status} /> {item.title}{" "}
                {firstLoc && (
                  <code className="chat-tool-loc" title={firstLoc.path}>
                    {baseName(firstLoc.path)}
                    {firstLoc.line != null ? `:${firstLoc.line}` : ""}
                  </code>
                )}{" "}
                <Label color={toolStatusColor(item.status)} variant="outline">
                  {item.status}
                </Label>
              </span>
            }
          >
            {item.locations && item.locations.length > 0 && (
              <div className="chat-tool-locations">
                {item.locations.map((loc) => (
                  <code key={`${loc.path}:${loc.line ?? ""}`}>
                    {loc.path}
                    {loc.line != null ? `:${loc.line}` : ""}
                  </code>
                ))}
              </div>
            )}
            {item.diffs?.map((d) => <DiffPreview key={d.path} diff={d} />)}
            <pre className="chat-tool-detail">{item.detail || "(no output yet)"}</pre>
          </ExpandableSection>
        </div>
      );
    }
    case "permission": {
      const chosenName = item.chosen
        ? (item.options.find((o) => o.optionId === item.chosen)?.name ?? item.chosen)
        : null;
      return (
        <div className="chat-permission">
          <div className="chat-permission-title">
            Permission requested{item.title ? `: ${item.title}` : ""}
          </div>
          {item.diffs?.map((d) => <DiffPreview key={d.path} diff={d} />)}
          {chosenName ? (
            <Label color="blue">answered: {chosenName}</Label>
          ) : (
            <div className="chat-permission-actions">
              {item.options.map((o) => (
                <Button
                  key={o.optionId}
                  size="sm"
                  variant={o.kind.startsWith("allow") ? "primary" : "secondary"}
                  onClick={() => onPermission(item.id, o.optionId)}
                >
                  {o.name}
                </Button>
              ))}
            </div>
          )}
        </div>
      );
    }
  }
}
