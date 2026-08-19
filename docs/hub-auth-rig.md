# Testing the agentic surface locally, with auth on

A disposable minikube profile running a hand-deployed hub with
`AUTH_REQUIRED=true` — no operator, no keycloak, no Postgres. It exists to
answer "what does this do under auth?" without a shared cluster, and to make a
hub branch testable in one rebuild.

Every auth finding raised on [tackle2-hub#1119](https://github.com/konveyor/tackle2-hub/pull/1119)
came out of this rig.

```bash
hack/hub-auth-up.sh          # profile + CRDs + hub + IdpClient, port-forward on :18080
hack/hub-auth-probe.sh       # the auth probe matrix (21 legs)
hack/ui-up.sh                # optional: the tackle2-ui console in front of it, :18081 — see local-stack.md
hack/hub-auth-down.sh        # drop the port-forwards
minikube delete -p hub-auth  # reclaim everything
```

Fresh profile → hub answering on `:18080` is about 40 seconds plus the image
pull. Nothing needs to exist beforehand except Docker and `minikube`; the
scripts never change your current `kubectl` context and only ever address
their own profile by name.

## What it covers, and what it doesn't

**Covered — the whole hub-side agentic surface under auth:** OIDC login,
scope enforcement per role, the ACP nonce mint and its single-use rejection,
`AgentRun` CR creation, the minted `agentic-run-*` token Secret landing in
the namespace, and whether that Secret is garbage-collected with its run.

**Not covered — an actual agent run.** The rig has no agentic-controller, no
sandbox pod, and no model gateway. A WebSocket dial with a valid nonce
therefore gets **503, and that 503 is a pass** — it means auth said yes and
there was simply nothing to relay to. Do not read it as a rejection; an auth
failure on that path is a 401.

To get a real run you additionally need the controller reconciling against
this profile and a `Gateway` carrying model credentials. That is a bigger
setup than this file — worth doing when the question is about run behavior,
unnecessary when the question is about the API surface.

## What the probe asserts

The auth *outcome*, not an exact status code:

| outcome | meaning |
| --- | --- |
| `401` | unauthenticated — no/invalid bearer, or no/spent nonce on the WS route |
| `403` | authenticated, scope not granted (`Required scope not granted: <res>:<verb>`) |
| pass | got past auth — 200/201/400/404/503 all count |

That distinction is the point: a 400 from a drifted request body still
proves the scope check passed, so the probe keeps telling the truth when the
payload shape changes underneath it. Every line prints the real code, and
known findings are **named** in the output rather than left as bare failures:

- **blocker 1** — stock roles carry zero `agentic.*` scopes, so every
  non-admin call 403s. Fixed by #1119 `8d62107`; an image from before it
  fails the architect/migrator legs, by design.
- **blocker 2** — the seed ships SA `agent.harness` but run-create looks up
  `agentic.harness`, so `POST /agentic/agentruns` 404s after auth passes.
  The probe plants the SA the hub wants (with the seed's `addon` role) so the
  ACP legs can still run, and says so; `HARNESS_SA_WORKAROUND=0` turns that
  off. The planted SA lives in the hub's emptyDir DB until the next
  `hub-auth-up.sh` reseeds it — the probe warns when a previous run left it
  there, because otherwise a re-run reads as "seed fixed".
- **finding (d)** — architect is `get`-only on agents/gateways under
  #1119's grants; the probe expects `POST /agentic/agents` and
  `POST /agentic/gateways` to 403 for architect while workflows create passes.
- **finding (a)** — project-manager's `agentic.agentruns.acp: get` is inert
  (the only ACP entry point is the POST nonce mint), so PM's mint must 403.
- **token Secret GC** — the run's Secret only follows the run when its
  ownerRef carries the full `konveyor.io/v1alpha1` (fixed by #1119
  `e8b8d1e`); the probe reports either way and cleans up itself.
- **no `DELETE /agentic/agentruns/{name}`** at either `a3af8307c` or #1119
  head — runs are create-only through the hub API. The probe deletes its CR
  with `kubectl` and says so. (Nothing in the UI calls one today.)

Expected results, so you know what "working" looks like:

- default image (`ghcr.io/ibolton336/tackle2-hub:agentic` = jortel
  `a3af8307c`, nonce-era, the same content the ROKS demo runs): **17 passed,
  4 failed** — the 4 are blocker 1, and blocker 2 shows as worked around.
  Exit 1 is correct: that image is admin-only.
- #1119 head `9e0fbc4` built locally: **21 passed, 0 failed** — blocker 1
  fixed, blocker 2 still live (worked around), (a)/(d) present, Secret GC'd.

## Testing a hub branch — the ~6 minute loop

Build straight into the profile's docker daemon; no registry round-trip:

```bash
eval "$(minikube -p hub-auth docker-env)"
docker build -t localhost/tackle2-hub:dev .
HUB_IMAGE=localhost/tackle2-hub:dev HUB_LOCAL_BUILD=1 hack/hub-auth-up.sh
hack/hub-auth-probe.sh
```

The DB is an `emptyDir`, so replacing the pod reseeds it. That is deliberate:
a seed change (roles, service accounts) is testable in one rollout instead of
a fresh cluster. `hub-auth-up.sh` always rolls the deployment for this reason.

## Where the pieces come from

- **Hub image** — default `ghcr.io/ibolton336/tackle2-hub:agentic`, a
  multi-arch (amd64+arm64) build of jortel `a3af8307c` pushed by
  [`.github/workflows/build-hub.yml`](../.github/workflows/build-hub.yml),
  which builds any fork/ref into that package. `HUB_IMAGE=` overrides.
- **Agentic CRDs** — this repo's `manifests/crd/` (byte-identical to
  agentic-controller `main` as of 2026-08-17). `CRD_DIR=` points at a
  checkout's `config/crd/bases` to test CRD changes.
- **Tackle CRDs** — the eight `tackle.konveyor.io_*.yaml` from the
  tackle2-operator bundle, applied from GitHub at a pinned commit
  (`TACKLE_OPERATOR_REF=`). The hub exits at boot if `idpclients`,
  `identityproviders`, `ldapproviders` or `schemas` are missing.
- **IdpClient `web-ui`** — the operator's, plus literal redirect entries
  for the local origins (see the redirect trap below), in
  [`hack/hub-auth-rig.yaml`](../hack/hub-auth-rig.yaml). Seeded login is
  `admin` / `admin`, from the `users.yaml` seed.
- **RBAC** — a namespace-local Role for the hub's ServiceAccount covering the
  agentic CRs, Secrets/pods, and `tackle.konveyor.io/*`. Missing that last
  group is a boot crash that looks like a slow start (below).

## Traps worth knowing before you burn an hour on them

**PKCE is mandatory.** A token exchange without a `code_verifier` 400s
"PKCE required". `hub-auth-login.sh` does the S256 auth-code flow headlessly.

**The login page is a JS app, not a form.** `/oidc/authorize` 302s to
`/oidc/login?authRequestId=…`, whose HTML carries
`window.__LOGIN_CONFIG__ = {"formAction": …}` and no `<form>`. The hub reads
PatternFly's field ids from the POST (`pf-login-username-id`,
`pf-login-password-id`), then bounces through `/oidc/authorize/callback?id=…`
before redirecting to `redirect_uri?code=…`. The script follows hub-side hops
by hand and stops at the first that leaves the hub — nothing listens on the
redirect target, the code is read out of that `Location`.

**Only the first `redirect_uri` after boot is accepted — unless it is
listed literally.** The hub expands the operator's `${issuer.*}` pattern per
request and writes the *first matching* requested URI back over the pattern
(`internal/auth/storage.go` `Client.Inject`, same on upstream `main`), so
every other origin then 400s "The requested redirect_uri is missing in the
client configuration" until the hub restarts. That is why the rig's
IdpClient carries literal entries for the login script (`http://localhost:8080/`),
the console (`http://localhost:18081`) and a UI dev server
(`http://localhost:9000`) — literals are never rewritten. Verified: all three
accepted in any order. Anything else needs adding as a literal or will race.

**Access tokens live 8 hours on this rig** (`OIDC_TOKEN_LIFESPAN=28800` on
the hub Deployment; the hub default is 5 minutes, which is what a stock
install gives you). Calls that start 401'ing "Token expired" are expiring,
not broken — re-run the login.

**Role tokens come from service accounts, not users.** `POST /auth/tokens`
only self-issues for the caller's own subject, so you cannot mint an architect
token while authenticated as admin. Create an SA per role, then
`POST /serviceaccounts/:id/tokens`.

**SA role refs must carry the numeric ID.** `POST /serviceaccounts` with a
role referenced by name nil-derefs in `auth/cache` `addSaScopes` and 500s —
pre-existing on main, [tackle2-hub#1124](https://github.com/konveyor/tackle2-hub/issues/1124).
Seeded role IDs: admin 1, architect 2, migrator 3, project-manager 4, addon 100.

**Scope denials are 403, not 401.** `Required()` runs `Authenticate()` first,
then matches granted scopes.

**A hub that "never becomes ready" is usually an RBAC exit.** With
`AUTH_REQUIRED` the hub lists `identityproviders.tackle.konveyor.io` at boot
(`auth.Tenant.Load`) and exits 0 on a forbidden — a crash loop with no
obvious error. `kubectl --context hub-auth -n konveyor-agents logs
deploy/tackle-hub` shows it one line above the stack trace. The rig's Role
grants `tackle.konveyor.io/*`; the Deployment also carries a TCP readiness
probe so `rollout status` means "listening", not "container started".

**Two bash things that bit the first version of these scripts.** macOS ships
bash 3.2, which cannot parse a heredoc containing parentheses inside
`$(…)` — the login script's parser lives in a temp file for that reason. And
`${VAR:-{"json":…}}` ends at the first `}` inside the JSON, silently
truncating the default — the probe builds its request bodies in two steps.

**AgentRun create takes the CR itself.** The hub binds
`agentic-controller`'s `AgentRun` type directly; `spec.agentRef` (a string)
is the only required field and nothing checks the Agent exists on a rig with
no controller. The nonce mint answers 201 with the JSON-encoded nonce string,
not an object.

## Verification status

**Verified end to end on 2026-08-17.** From a freshly created profile
(`minikube delete -p hub-auth` first): `hub-auth-up.sh` to a serving hub in
37 s, then the probe against the default image — 17 passed / 4 failed, both
blockers named. Earlier the same day, on the previous profile, the
`HUB_LOCAL_BUILD=1` path was exercised against a local build of #1119 head
`9e0fbc4`: 21 passed / 0 failed, matching the review findings. The scripts in
`hack/` are the ones that produced those numbers.
