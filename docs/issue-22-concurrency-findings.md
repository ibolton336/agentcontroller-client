# Why browsers can't talk to the ACP pod directly — and what goose actually does with multiple connections

Research notes, 2026-07-27. Prompted by the Slack question "was the hang-up
just the secret, or something deeper?" Source-verified against the ACP
server we actually ship: goose **v1.39.0** (the `aaif-goose/goose` fork
pinned in `harness-goose/Dockerfile`), files
`crates/goose/src/acp/transport/{auth,websocket,connection}.rs` and
`crates/goose/src/acp/server.rs`.

Companion to `issue-22-contract.md` (the canonical contract comment on
[konveyor/agentic-controller#22](https://github.com/konveyor/agentic-controller/issues/22#issuecomment-4905804098)).
This doc explains **why R2 (the WS proxy obligation) exists** and records a
new finding about goose's connection-concurrency model that isn't written
down anywhere else.

---

## 1. Recap: the moving parts

When an AgentRun is created:

- the controller mints a random key, stores it in Secret
  `<run>-acp-key` (data key `secret-key`), records the Secret name in
  `status.secretKeyRef`, and injects it into the pod as
  `GOOSE_SERVER__SECRET_KEY` / `KONVEYOR_ACP_SECRET_KEY`
- the pod runs `goose serve` on `:4000`, speaking ACP over
  WebSocket/HTTP at `/acp`, auth required
- the auto-created Service is **headless with no ports** — clients must
  dial the pod itself

A UI that wants the live chat surface must therefore: (a) find the pod,
(b) get the key, (c) open a WebSocket to `pod:4000/acp`, authenticated.

## 2. The auth blocker is *not* what we sometimes said it was

The folk version — "browsers can't set custom headers on a WebSocket
upgrade, so they can't send `X-Secret-Key`, so we need a proxy" — is
**true about browsers but false as a conclusion**, because goose planned
for it. The auth middleware (`transport/auth.rs`, ~36 lines) accepts the
key **two ways**:

```text
X-Secret-Key: <key>        # header — node/IDE clients
GET /acp?token=<key>       # query param — exists FOR browser WebSocket clients
```

Both are constant-time compared against `GOOSE_SERVER__SECRET_KEY`. The
server also serves permissive CORS (`allow_origin(Any)`) with
`x-secret-key` in the allowed headers. `/health` is unauthenticated.

So: **if** a browser could reach the pod and **if** it had the key, it
could authenticate today with `?token=`. Auth alone never required a
proxy. (Caveat: key-in-URL leaks into access logs and browser history,
so the header path is still preferable when a server-side hop exists.)

## 3. What actually forces a server-side hop

Two blockers, both harder than auth:

### 3a. No network route (the unavoidable one)

Browsers have no path to `pod:4000`:

- pod IPs are cluster-internal
- the auto-created Service is headless (`clusterIP: None`) **and has no
  ports** — there is nothing to point an Ingress/Route at without
  building per-run route management (dynamic ingress creation + TLS +
  edge auth for every ephemeral sandbox pod — a worse "separate
  service" than one WS proxy route)

Something running **in the cluster** must terminate the browser's
WebSocket and tunnel to the pod. ADR 0002 (djzager) acknowledged this
from day one in its consequences: *"requires Hub to proxy WebSocket
connections to the pod's Service DNS, or an ingress route."*

### 3b. Secret distribution (the one the Slack thread was about)

The key lives in a Kubernetes Secret. For a browser to read it, the
browser would need k8s API credentials with Secret-read access in the
run's namespace — i.e. kube creds shipped to a browser tab. Non-starter.

So even the `?token=` path needs a server-side component to *dispense*
the key — and a component that already resolves the pod and reads the
Secret might as well pipe the frames too. That collapse of
(resolve + key + tunnel) into one route is exactly **R2** in the
issue-22 contract:

```text
WS /api/agentruns/:name/acp
  → resolve pod (status.sandboxName)
  → read key (status.secretKeyRef → secret-key)
  → dial pod:4000/acp with X-Secret-Key
  → pipe frames both ways
```

### "An entire separate service"?

That framing drifted. The consolidated issue-22 comment is deliberately
**host-neutral**: R2 is *one WebSocket route*, and where it lives —
native Hub endpoint, sidekick next to the controller, whatever — is the
open placement question (Q2 on the thread). The claim was never "we
must build a new deployable"; it was "no existing Hub mechanism covers
this shape" (tasks are one-way addon→Hub and run-to-completion; nothing
today dials *into* a running pod and holds a bidirectional stream).

## 4. New finding: goose's connection-concurrency model

This is the part not previously written down. Verified in v1.39.0
source; it changes the "browsers could connect directly if only the
network allowed it" counterfactual.

### Every WebSocket connection gets its own agent instance

`handle_ws_upgrade` → `registry.create_connection()` →
`server.create_agent()` (`transport/websocket.rs:14-49`,
`transport/connection.rs:101-139`, `server_factory.rs:56`). Each
connection:

- gets a fresh `GooseAcpAgent` + its own tokio task and UUID
  connection id
- is an independent ACP peer: it must `initialize`, then `session/new`
  or `session/load`
- has its own outbound broadcast stream

Connections are unlimited — the registry is just a HashMap. Sessions
are shared **only through the SQLite store underneath** (shared
`SessionManager` / data dir).

### Consequence 1: no live fan-out across connections

The outbound stream is per-connection. If browser tab A is driving a
prompt, tab B attached to the same session sees **nothing live** — it
only gets history when it explicitly calls `session/load` (which
replays from SQLite). "Multiple UI clients can connect to the same
agent" (ADR 0002) is true in the connect-and-replay sense, **not** live
co-viewing.

### Consequence 2: the single-active-run guard is per-connection only

`server.rs` keeps `active_prompt_runs` and rejects a second concurrent
prompt on a session with *"session already has active run … use
\_goose/unstable/session/steer"* (`server.rs:2232-2238`). But that map
is a **field on the per-connection agent instance** (`server.rs:209`)
— it is not shared across connections and not backed by any lock in
SQLite. Two connections can therefore start prompts on the *same*
session simultaneously: two agent loops, interleaved writes into one
session history.

### Why this matters for issue 22

Even in a fantasy world with routable pods and public keys, direct
browser→goosed access gives you split-brain sessions: no shared live
stream, no cross-client run mutex. Multi-client UX (two tabs, a
teammate watching, IDE + web open at once) needs a mediating component
that either enforces single-writer or fans one upstream connection out
to N viewers. goosed will not do it for you. That's an *additional*,
independent justification for R2 — and a design input for whoever hosts
it: today's hub-shim proxy is a 1:1 pipe, so single-writer discipline
currently rests on the client side.

## 5. "But tackle2-ui already talks to Hub with a hub token?"

Yes — and that's the front door working exactly as it should. The hub
token authenticates **browser → Hub**; it cannot authenticate
**anything → pod**, because goosed only accepts its own per-run secret
key, and the browser has no route to the pod regardless. Hub has to
bridge the two credential domains.

Hub is already close. `ServiceHandler.Forward`
(tackle2-hub `internal/api/service.go`) is an authenticated reverse
proxy: `Authenticate()` validates the hub token, RBAC applies, then
`httputil.ReverseProxy` forwards — already streaming-tuned
(`FlushInterval: -1` for the kai / llm-proxy SSE routes). Three gaps
separate it from R2:

1. **Static vs dynamic targets.** `serviceRoutes` is a fixed name→URL
   map from env vars. R2 resolves a *different, ephemeral* upstream per
   run (`status.sandboxName` → pod).
2. **Credential swap.** Nothing today reads a per-run Secret and
   injects `X-Secret-Key` upstream. This is the genuinely new piece:
   hub token in, secret key out, at the proxy boundary.
3. **WS auth carrier.** A browser can't set `Authorization` on a
   WebSocket upgrade (same class of limitation as the original
   X-Secret-Key story), so the ACP WS route needs Hub to accept the
   token via cookie, query param, or `Sec-WebSocket-Protocol`. An
   `Authenticate()` tweak, not an architecture change.

Frame piping itself is nearly free — Go's `httputil.ReverseProxy` has
tunneled WebSocket upgrades natively since Go 1.12. So R2 is best
described as **a modest extension of Hub's existing service-forward
pattern** (dynamic target + credential swap + WS-friendly auth), with
the hub token remaining the only credential the browser ever holds.

## 6. TL;DR

| Claimed blocker | Verdict |
|---|---|
| "Browsers can't send `X-Secret-Key` on WS upgrade" | True but moot — goose accepts `?token=` precisely for browsers |
| "The secret isn't available to the browser" | Real, but it's a *distribution* problem: reading the Secret needs k8s API creds you'd never ship to a browser |
| "Browsers have no route to the pod" | The unavoidable one: cluster-internal IPs, headless portless Service, no ingress story for ephemeral pods |
| "We need an entire separate service" | Overstated — one server-side WS route (R2), placement open; Hub-native is fine |
| (new) "goosed handles multiple clients" | Only connect-and-replay. Per-connection agent instances; no live fan-out; run-concurrency guard doesn't cross connections — the platform must own multi-client semantics |
| "tackle2-ui already has a hub token" | Right — that's the front door, and it stays the browser's only credential. Hub bridges it to the pod's secret key at the proxy boundary; R2 ≈ `ServiceHandler.Forward` + dynamic per-run target + credential swap + WS auth carrier |
