# Session takeaways — agentcontroller-client

Snapshot of where the client-side POC stands, the decisions behind it, and
what's real vs. stubbed. Written 2026-07-09. Repo `main` at `536380f`.

## TL;DR

- Browser UI → **hub-shim** (stand-in for the future Hub proxy) → **real
  agentic-controller (PR #4)** → sandbox pod running a **harness** (mock or
  goose). All verified end-to-end on minikube.
- Two hard questions now have running answers: **where run inputs (git
  URL/branch/creds) come from** (platform-resolved param sources), and **what
  a permission diff-preview payload looks like** (ACP's standard diff block).
- The shim reads a **real Konveyor Hub** for its application inventory — not a
  mock.

## What shipped this session

| Commit | What |
|--------|------|
| `162b1ae` | portforward: survive tunnel failures instead of crashing the shim |
| `27b868e` | hub-shim serves the full read-only resource surface (agents, llmproviders, skillcards, skillcollections) |
| `77002f1` | SkillCard/SkillCollection sample resources (both Ready states) |
| `9d095c3` | permission diff preview via standard ACP diff content blocks |
| `5c05393` | platform-resolved params: sources, credentials, application inventory |
| `ef9950a` | review fixes (infra-fault 400s, source-vocabulary asymmetry, a11y) + doc reconcile |
| `2207019` | read the **real** Konveyor Hub application inventory, not a mock |
| `a244461` | self-healing Hub port-forward |
| `536380f` | UI inventory provenance indicator (real Hub vs stub) |

## The core design decision: platform-resolved params (ADR 0005)

The problem: an Agent declares typed params, but nothing says `repository`
*is* the selected application's repo URL. Hub needs to know what to fill; the
UI needs to know what not to ask.

Decisions:

- **Agent annotations** map a param/credential to a **source id**:
  ```yaml
  metadata:
    labels: { konveyor.io/managed: "true" }        # Konveyor UIs list only these
    annotations:
      konveyor.io/param-sources: |
        {"repository": "konveyor.io/application-repository-url",
         "branch": "konveyor.io/application-repository-branch"}
      konveyor.io/credential-sources: |
        {"git": "konveyor.io/application-identity"}
  ```
- **Source ids are free-form namespaced strings, NOT a CRD enum.** An enum
  bakes Hub's vocabulary into a generic platform CRD, is ignored by that CRD's
  own controller, and makes every new value a schema upgrade that fails
  *closed* at admission (an old CRD rejects a newer Agent manifest). Follows
  the `storageClassName`/`ingressClassName` precedent: generic mechanism,
  operator-defined vocabulary, documented not validated.
- **Fail-open is the load-bearing rule.** A consumer that does not recognize a
  source id MUST treat the param as caller-supplied and render the field. Skew
  degrades to "user types it", never to "field vanishes" or "manifest
  rejected". A UI that hides unrecognized-source params is non-conformant.
- **Credentials use the same mechanism** rather than an `envFrom` punt (which
  couples every caller to per-agent Secret knowledge).
- **Immutability ⇒ delete + recreate.** Every edit/retry affordance is
  delete-and-recreate; the AgentRun spec is immutable (whole-spec CEL).

## Real vs. stubbed (the honesty ledger)

**Real:**
- `agentic-controller` PR #4 running live on minikube (not a simulator).
- **Konveyor Hub** (`tackle2-hub`, image `tackle2-hub:oidc-zitadel`, deployed
  ~7 weeks ago, real DB persistence). The shim reads its real Application
  table over `HUB_URL`.
- goose harness runs a real LLM (Bedrock) against a real cloned repo.

**Stubbed / synthetic (all labeled, not hidden):**
- The Hub **application data** is seeded test data I POSTed (`Coolstore` +
  `coolstore-git` identity, `Legacy Monolith` with no repo). Genuinely stored
  in and served by the real Hub, but not from a real assessment workflow.
- Hub runs in **dev/no-auth mode** (`createUser: admin.noauth`) — which is why
  the shim reaches it unauthenticated. Production Hub adds auth.
- **Credential materialization** (Hub vault identity → sandbox Secret) is
  bridged via `IDENTITY_SECRET_BRIDGE`. Hub owns the vault, so production
  closes this gap itself; the shim only sees the identity name.
- The **port-forward** is a laptop transport crutch, not the Hub being fake.

## Mental models worth keeping

- **Three layers, don't conflate them.** *Agent (CR)* = a config record (image
  + prompt + params + provider). *Harness (image)* = what runs in the pod and
  speaks ACP. *LLMProvider* = the model. The two UI "agents" are the same task
  with two harness backends.
- **Mock vs goose isolate two risks.** Mock = deterministic, free, with test
  triggers (`TEST_PERMISSION`/`TEST_CANCEL`/`TEST_DROP`) → the rig for the
  transport/protocol. Goose = the "survives contact with reality" test (real
  env contract, creds, repo, tool calls).
- **The contract is a real seam.** Mock and goose are two *independent* ACP
  implementations (JS SDK vs a Rust binary) that both drive the same client
  unchanged. That proves the client depends on ACP-the-protocol, not on any
  implementation's accidents — so a conformant third (the official harness)
  drops in.
- **Transport is orthogonal to harness.** Whether you need the shim depends on
  the *client* (browser needs it; node/IDE talks direct-k8s), not on which
  harness is in the pod.

## End-state: what happens to the shim

The standalone shim is throwaway. Its work becomes Hub's own endpoints:

- **Native endpoints** — `GET /api/applications` is Hub reading its own DB
  (not a proxy).
- **A gateway to the k8s API** — agents/runs CRUD, with Hub's auth + filtering.
  `POST /api/agentruns` also does real work (resolves sources, materializes
  the credential) before writing the CR.
- **One WebSocket passthrough proxy** — the `/acp` route: resolve pod, inject
  `X-Secret-Key`, pipe frames. The one genuinely new piece of machinery.

**Browser-safe** because Hub adds the **auth** the shim deliberately omits
(the shim is wide open, CORS `*`, localhost only). The only genuinely new
operational concern is that Hub becomes a *stateful* proxy holding long-lived
ACP WebSocket connections; the REST side stays stateless.

`SHIM API v1` (the shim's HTTP surface, in ADR 0004) is the reference contract
David's Hub fork is being built against. `packages/hub-shim/dev/browser-smoke.ts`
is the acceptance test.

## Collaboration state

- **David (djzager)** — building a Hub fork that implements SHIM API v1.
- **Harness team (savitha, hiteshwari)** — building the official harness. **Not
  a blocker** for UI/Hub work; the mock and goose harnesses stand in on the pod
  side.
- Contract proposal + follow-up posted on
  [konveyor/agentic-controller#22](https://github.com/konveyor/agentic-controller/issues/22).

## Demo readiness

- Cold `hack/demo-up.sh` verified end-to-end, wired to real Hub via a
  self-healing port-forward.
- **Provenance indicator + Refresh** proves "not hardcoded" live: register an
  app in Hub, click Refresh, watch it appear (2 → 3).
- Suggested 3-beat arc: (1) create-run form collapses to *application +
  instructions* (param sources); (2) HITL + rendered diff on the **mock**
  (deterministic — `TEST_PERMISSION`); (3) swap to **goose** — same UI, real
  LLM, real repo — nothing upstream of the pod changed.
- Do the diff/HITL beat on the mock, not goose (a live LLM won't ask
  permission on cue).

## Open actions

1. Soften ADR 0005's normative voice (`MUST`, `non-conformant`) to proposal
   voice — some of it rode into the posted #22 comment; it's an unratified
   annotation, not a ratified spec.
2. Exercise one fresh goose+Bedrock run before demoing — the only live link not
   re-verified this session.
3. Ask Hiteshwari **what the official harness is built on**. If goose-based, the
   `harness-goose` env-contract mapping (`KONVEYOR_PARAM_*` → goose
   provider/model, `.goosehints`) is directly reusable.

## Reference

- `docs/adr/0004-client-contract-and-transports.md` — verified client contract
  + SHIM API v1 table.
- `docs/adr/0005-platform-resolved-params.md` — param sources.
- `docs/issue-22-contract-proposal.md`, `docs/issue-22-followup.md` — upstream
  comments (posting is a human decision).
- `docs/DEMO.md` — demo script.
