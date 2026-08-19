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
| Real runs | — | **not in this kit.** No agentic-controller, no sandbox, no model gateway: runs you create sit in `Pending`, `Ready` shows `Unknown`, ACP chat has nothing to relay to. See "Adding real runs" below |

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

## Adding real runs (next layer, not scripted yet)

Everything needed exists, in pieces:

- **agentic-controller** — `kubectl kustomize
  "https://github.com/konveyor/agentic-controller//config/default?ref=main"`
  with the image set to `quay.io/konveyor/agentic-controller:latest` (public,
  CI-pushed, the Makefile default), or the checked-in ROKS render
  `deploy/roks/agentic-controller-install.yaml` (main @ `059b6f60`, image
  repointed to `ghcr.io/ibolton336/agentic-controller:demo`).
- **agent-sandbox** v0.5.0 — `deploy/roks/agent-sandbox-v0.5.0.json`.
- **A Gateway with real credentials** — `manifests/goose-bedrock.yaml` is
  the Bedrock shape; the sample `mock-gateway` in `manifests/samples.yaml`
  is inert.
- **Agent images** — `ghcr.io/ibolton336/agent-base:demo` /
  `agent-java:demo` etc. are public multi-arch.

The controller reconciles in the hub's namespace (`konveyor-agents`), which
is where the console already creates runs, so nothing on the hub/console
side changes when this layer lands. Filed as follow-up work, not done here.

## Things you will hit, and why they are that way

**Two known seed problems in the pinned hub image** — both fixed on the
#1119 branch, both **named** in the probe output: stock roles carry no
`agentic.*` scopes (everything is admin-only; architect/migrator 403), and
`POST /agentic/agentruns` 404s "SA (agentic.harness) not-found" (seed ships
`agent.harness`). The probe plants the missing SA on the rig so the ACP
legs still run. Build Jeff's branch with `HUB_LOCAL_BUILD=1` to see the
fixed behaviour.

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

**`Ready: Unknown` everywhere** is the missing controller, not a bug.

## Where this replaces the old way

`docs/DEMO.md`, `hack/demo-up.sh`, `packages/hub-shim/` and `ui/` are the
shim era: a Node proxy standing in for hub endpoints that did not exist and
a Vite prototype in front of it. They still run, but nothing new should be
built against them — the hub has the endpoints and tackle2-ui has the
console. `hack/mock-inventory-stack.mjs` stays useful as the *contract
fixture* for cluster-free UI work; this page is for when you want the real
thing.

## Verification status

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
