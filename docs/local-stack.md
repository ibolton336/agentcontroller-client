# The real hub and console on your laptop — no shim

The agentic surface now lives in the hub itself (Jeff's `/agentic/*`
endpoints, [tackle2-hub#1119](https://github.com/konveyor/tackle2-hub/pull/1119))
and the console lives in tackle2-ui (`feature/agent-runs`,
[tackle2-ui#3504](https://github.com/konveyor/tackle2-ui/issues/3504)). This
is how you run **that** pair locally: a disposable minikube profile with a
hand-deployed hub and the console image in front of it. No hub-shim, no
mock stack, no operator, no keycloak — the same two images the ROKS demo
cluster runs.

```bash
git clone https://github.com/ibolton336/agentcontroller-client && cd agentcontroller-client
hack/hub-auth-up.sh     # hub with the agentic endpoints, auth on   → http://localhost:18080
hack/ui-up.sh           # tackle2-ui agent-runs console against it → http://localhost:18081
kubectl --context hub-auth apply -f manifests/samples.yaml   # a Gateway, an Agent, skills to look at
hack/runs-up.sh         # OPTIONAL: controller + sandbox + Bedrock gateway, so runs actually run
```

Then open <http://localhost:18081>, log in as **admin / admin**, and the
**Agentic** section in the left nav (Agent runs, Agents, Skills, Workflows,
Workflow runs) reads and writes real CRs through the real hub. Fresh
profile → both up is about a minute plus image pulls. Needs Docker,
`minikube`, `kubectl`; the login/probe scripts also want `curl`, `python3`,
`openssl`.

Tear-down: `hack/hub-auth-down.sh` (port-forwards) · `minikube stop -p hub-auth`
(park) · `minikube delete -p hub-auth` (reclaim). The scripts never touch
any other cluster or your current `kubectl` context.

## What is in the box, and what is not

| Layer | Script | What it gives you |
| --- | --- | --- |
| Hub | `hack/hub-auth-up.sh` | `ghcr.io/ibolton336/tackle2-hub:agentic` (multi-arch build of jortel `a3af8307c` — nonce-era `/agentic/agentruns`, ACP nonce two-step), `AUTH_REQUIRED=true`, builtin OIDC with the operator's `web-ui` client, agentic + tackle CRDs, 8 h access tokens |
| Console | `hack/ui-up.sh` | `ghcr.io/ibolton336/tackle2-ui@sha256:19a151a0…` (`feature/agent-runs` @ `7787852`, the ROKS build), `AGENTIC_ENABLED=true`, all agentic traffic through its own `/hub` proxy, ACP chat through the same proxy's WebSocket upgrade |
| Auth probe | `hack/hub-auth-probe.sh` | 21-leg 401 / 403 / past-auth matrix per role — see [hub-auth-rig.md](hub-auth-rig.md) |
| Real runs | `hack/runs-up.sh` | **optional layer**: agentic-controller (current-main render, ghcr `:demo`) + Agent Sandbox v0.5.0 + `aws-bedrock-creds` from your local AWS identity + the `goose-bedrock` Gateways/Agent. Without it, runs sit in `Pending` and `Ready` shows `Unknown`. Needs a run-create-capable hub — see "Adding real runs" below |

So this answers "what does the console/API do against the real hub" — CRUD,
list/detail pages, create modals, per-application views, auth, scopes,
nonce — not "what does an agent do".

## Knobs

| Env | Default | Effect |
| --- | --- | --- |
| `AUTH_REQUIRED` | `true` | `false` = no login, no scopes; the console pair follows automatically |
| `HUB_IMAGE` / `HUB_LOCAL_BUILD=1` | ghcr `:agentic` | any hub image; `HUB_LOCAL_BUILD=1` for one built into the profile daemon (Jeff's branch loop, in [hub-auth-rig.md](hub-auth-rig.md)) |
| `UI_IMAGE` | digest-pinned `:demo` | e.g. `ghcr.io/ibolton336/tackle2-ui:demo` for the moving tag, or your own build |
| `HUB_LOCAL_PORT` / `UI_LOCAL_PORT` | `18080` / `18081` | laptop ports. `UI_LOCAL_PORT` must be given to **both** scripts (the hub registers the console's origin as an OIDC redirect) |
| `UI_DEV_PORT` | `9000` | the tackle2-ui dev-server origin the hub also accepts |
| `CRD_DIR` | `manifests/crd/` | agentic CRDs from an agentic-controller checkout instead |
| `AWS_REGION` | `us-east-1` | (`runs-up.sh`) Bedrock region — the harness derives the endpoint from this, not from the Gateway |
| `AGENT_IMAGE` | ghcr `agent-base:demo` | (`runs-up.sh`) image for the seeded `migration-analyzer-goose` agent |
| `GATEWAY_PROBE_URL` | console svc URL | (`runs-up.sh`) any in-cluster 2xx URL for the gateway verify workaround |
| `AC_INSTALL` / `SANDBOX_INSTALL` | `deploy/roks/…` | (`runs-up.sh`) alternate controller / sandbox install manifests |

## UI developers: your own dev server against this hub

Skip the repo's `npm run start:dev` — its `port-forward` half runs
`kubectl port-forward svc/tackle-hub -n konveyor-tackle` against *whatever
context is current* (wrong cluster, wrong namespace). Point the pieces at
the rig by hand:

```bash
cd tackle2-ui        # branch feature/agent-runs
export TACKLE_HUB_URL=http://localhost:18080 AGENTIC_ENABLED=true \
       AUTH_REQUIRED=true OIDC_CLIENT_ID=web-ui OIDC_ISSUER=http://localhost:9000/oidc
npx concurrently 'npm:start:dev:common' 'npm:start:dev:server' 'npm:start:dev:client'
open http://localhost:9000
```

`http://localhost:9000` is pre-registered on the hub's OIDC client, so
login works from the dev server too (`AUTH_REQUIRED=false` on both sides
if you would rather not). Wait for webpack's "compiled successfully" before
the first request — a request during the first build kills
webpack-dev-server (serve-index double-response on node 24). *This path is
documented from the wiring, not re-verified in a browser today; the console
image path above is.*

## Adding real runs — `hack/runs-up.sh`

`hack/runs-up.sh` layers everything a console-created run needs onto the
same profile:

- **agentic-controller** from `deploy/roks/agentic-controller-install.yaml`
  — a current-main render (`0f2d883`), image
  `ghcr.io/ibolton336/agentic-controller:demo`. Deliberately **not**
  `quay.io/konveyor/agentic-controller:latest`: that tag is stale — it
  predates the #149 gateway verify among much else.
- **Agent Sandbox v0.5.0** — `deploy/roks/agent-sandbox-v0.5.0.json`.
- **`aws-bedrock-creds`** in `konveyor-agents`, built from
  `aws configure export-credentials --format env-no-export` plus
  `AWS_REGION`. Session credentials expire — re-running the script
  refreshes the secret (already-running pods keep the env they started
  with).
- **`manifests/goose-bedrock.yaml`** — the `bedrock-sonnet`/`bedrock-haiku`
  Gateways and the `migration-analyzer-goose` Agent, with two rig
  substitutions: `spec.endpoint` → the gateway-probe workaround below, and
  the manifest's local-build `goose-harness:dev` image → a public
  multi-arch one, default `ghcr.io/ibolton336/agent-base:demo`
  (`AGENT_IMAGE`). Agents you create in the console take any image ref —
  use the same one.

Two hub-side facts decide whether a run actually runs:

- **Run-create needs the #1119 head, not the pinned image.** The default
  ghcr `:agentic` image (jortel `a3af8307c`) predates AgentRunCreate —
  `POST /agentic/agentruns` 404s, so the console can create agents but
  never start a run. Build Jeff's branch into the profile with
  `HUB_LOCAL_BUILD=1` (the loop in `hub-auth-up.sh`'s header);
  `runs-up.sh` warns when it sees the pinned image.
- **The hub must know its own address.** The hub stamps its `HUB_BASE_URL`
  env into every AgentRun it creates; unset, that defaults to
  `http://localhost:8080` — which inside the sandbox pod is the pod
  itself — and every harness loops forever on "Hub Resolution". The rig
  sets `HUB_BASE_URL=http://tackle-hub.konveyor-agents.svc:8080` on the
  hub deployment (`hub-auth-rig.yaml`) so runs get the in-cluster service
  URL; `runs-up.sh` warns if the hub it finds lacks it (re-run
  `hub-auth-up.sh` to pick it up).

And one controller-side trap the script works around:

- **A real Bedrock endpoint can never verify.** The controller verifies a
  Gateway by curling `spec.endpoint` + `/v1/models` from a Job, and since
  #149 only 2xx passes; Bedrock answers 403/404 there, so a gateway
  pointing at the real `bedrock-runtime` URL sits NotReady forever. The
  harness ignores `spec.endpoint` for `aws-bedrock` (it derives the
  endpoint from `AWS_REGION`), so the script points `spec.endpoint` at an
  in-cluster URL that answers 2xx — by default the console service,
  `http://tackle2-ui.konveyor-agents.svc:8080` (`GATEWAY_PROBE_URL`).
  That is why `runs-up.sh` wants `ui-up.sh` run first. The first verify
  can take a few minutes: the Job pulls
  `quay.io/konveyor/agentic-controller-agent:latest`.

Launching from the console: the run modal requires an **application**, and
that application must carry a **Git source repository** (any public repo
does — the demo coolstore fork, `https://github.com/ibolton336/coolstore`,
is a fine default). The harness resolves the application from the hub and
clones its repository before the agent runs; on a repo-less application it
currently dies on a nil pointer right after Hub Resolution instead of
failing cleanly (upstream harness bug). No git identity is needed until an
agent actually produces commits — the harness skips the final push when
there are none.

Everything reconciles in the hub's namespace (`konveyor-agents`), which is
where the console already creates runs, so nothing on the hub/console side
changes when this layer is added — runs launched from the console simply
start running.

## Things you will hit, and why they are that way

**Two known seed problems in the pinned hub image** — both fixed on the
#1119 branch, both **named** in the probe output: stock roles carry no
`agentic.*` scopes (everything is admin-only; architect/migrator 403), and
`POST /agentic/agentruns` 404s "SA (agentic.harness) not-found" (seed ships
`agent.harness`). The probe plants the missing SA on the rig so the ACP
legs still run. Build Jeff's branch with `HUB_LOCAL_BUILD=1` to see the
fixed behaviour — which is also a hard requirement for the runs layer:
the pinned image predates AgentRunCreate, so the console cannot start
runs on it (see "Adding real runs").

**Login only ever accepts the first origin — unless it is listed
literally.** The hub expands the operator's `${issuer.*}` redirect pattern
per request and writes the *first matching* `redirect_uri` back over the
pattern (`internal/auth/storage.go` `Client.Inject`, same on upstream
`main`), so after one login every other origin gets "The requested
redirect_uri is missing in the client configuration" until the hub
restarts. One UI behind one route never notices; a laptop with a login
script and a console on another port does. The rig's IdpClient therefore
lists `http://localhost:18081`, `http://localhost:9000` and the login
script's redirect as literals — literals are never rewritten. Verified: all
three accepted in any order. Change a port → re-run `hub-auth-up.sh` with it.

**Sessions used to die every ~5 minutes.** The hub mints 5-minute access
tokens by default and the console cannot silently renew (its scope lacks
`offline_access`, so no refresh token — tackle2-ui#3302, one line in
`userManager.ts`). The rig sets `OIDC_TOKEN_LIFESPAN=28800` (8 h) on the hub
as a laptop convenience; it does not fix the UI.

**No `DELETE /agentic/agentruns/{name}`** on the hub (at `a3af8307c` and at
#1119 head) — runs are create-only through the API. The console has no
run-delete action, so nothing breaks; a stuck run goes away with `kubectl
--context hub-auth -n konveyor-agents delete agentrun <name>`.

**The console image needs `NODE_EXTRA_CA_CERTS` set** even over plain
http — its entrypoint copies the service-account CA to that path
unconditionally on Kubernetes and crash-loops with "cp: missing destination
file operand" when it is unset. `ui-rig.yaml` sets the operator's value.

**`Ready: Unknown` everywhere** is the missing controller, not a bug —
`hack/runs-up.sh` is the layer that adds it.

## Where this replaces the old way

`docs/DEMO.md`, `hack/demo-up.sh`, `packages/hub-shim/` and `ui/` are the
shim era: a Node proxy standing in for hub endpoints that did not exist and
a Vite prototype in front of it. They still run, but nothing new should be
built against them — the hub has the endpoints and tackle2-ui has the
console. `hack/mock-inventory-stack.mjs` stays useful as the *contract
fixture* for cluster-free UI work; this page is for when you want the real
thing.

## Verification status

**2026-08-20, runs layer, converged over a live profile:** all three
scripts re-run in order (hub at the #1119 head via `HUB_LOCAL_BUILD=1`);
`runs-up.sh` flipped `bedrock-sonnet` from NotReady-forever (real Bedrock
endpoint) to `Verified/Ready` via the probe workaround and seeded
`migration-analyzer-goose` Ready on the public image. Browser, whole flow
through the console: login → **Create agent** (`kit-verify-agent`,
`ghcr.io/ibolton336/agent-base:demo`, gateway `bedrock-sonnet`) → create
`kit-verify-app` (with a Git source repository — see below) → **Create
run** → pod ran and the run went `Succeeded` in ~2 min; the harness log
shows the whole chain: Hub Resolution over the in-cluster `HUB_BASE_URL`
(`GET /applications/1` 200), coolstore cloned, goose turns against real
Bedrock, "no commits produced; skipping push", clean exit. Two
learnings: the console's run modal requires an **application**, and that
application must have a **source repository** — the harness panics
(nil-pointer, upstream bug to file) on a repo-less application after Hub
Resolution succeeds. The emptyDir reseed also renumbers hub application
ids, so old runs' application chips relabel after a hub roll — cosmetic.

**2026-08-17, from a freshly created profile:** `hub-auth-up.sh` → serving
auth-on hub in 37 s; `ui-up.sh` → console ready, `/hub/agentic/agents`
answers 401 anonymously through the proxy; browser: OIDC login as admin →
Application inventory → Agents page lists the seeded `migration-analyzer`
from the real hub; `/hub/agentic/{workflows,skills,gateways}` 200 with a
bearer whose lifespan is 8 h; **Create agent** modal (populated with the
seeded gateway/skills) → `kit-smoke-agent` landed as an Agent CR on the
profile with the hub-injected `konveyor.io/managed: true` label and the
list refreshed. The redirect-origin behaviour above was measured (first
match locks; literals do not), and the token lifespan read back from the
minted JWT.
