# Running the migrated tackle2-ui against the real hub

> **2026-08-11: this recipe is LIVE on the ROKS demo cluster, running the
> `/agentic/agentruns` pair pinned below** (hub `sha256:8a3fe0a0…` @
> `0969d735` + UI `sha256:2da83eb1…` @ `20162dc92`, UI rolled forward
> later the same day for the sidebar-unmount fix; verified live — run
> history, stage runs now visible, Agents page through the managed
> filter, sidebar + hamburger toggle survive the agentic routes).
> **2026-08-17: the cluster was RESET (Ian) — `konveyor-agents` deleted
> outright (console, IdpClient, gateway, every CR incl. the run history, the
> Bedrock secret) and David's getting-started stack installed in its own
> namespaces (`agentic-controller-system` on `quay.io/konveyor/agentic-controller:latest`,
> `agent-sandbox-system` v0.5.5). 2026-08-18: rebuilt minimal — namespace,
> hub RBAC (`hub-agentic-swap.yaml`), IdpClient (`idpclient-webui.yaml` plus
> the console route origin as a literal redirect), the console (this doc's
> UI digest, from `agentic-stack.yaml`), Bedrock gateways, coolstore demo
> agent — and the hub rolled to Jeff's `quay.io/jortel/tackle2-hub@sha256:d849875b3dcdb14929516e1b64ad354c42d46bc25c3fdc4b87cb0db279f02224`
> (`:agent` pushed 08-18 15:17Z; rollback ref `d9136077…`): SA seed rename +
> role grants live, run-create needs no workaround; three console runs green.
> Trap: the hub's Role/RoleBinding live in `konveyor-agents` — delete that
> namespace and the hub cannot restart (`Tenant.Load` forbidden). The
> `agentic-gateway` was NOT restored (retired).**
>
> **2026-08-19 (evening): "ask the human" on ROKS (option A, Ian's call).**
> The agent can now stop and ask: the harness mounts an `ask_user` MCP tool
> (the harness binary itself, `migration-harness ask-user-mcp`) whose
> questions reach viewers through the tee as `elicitation/create` asks
> (`kask-*` ids, pending asks replayed to late viewers) and block the turn
> until a human answers; the UI renders each as a form card (Answer /
> Decline). Harness branch `ibolton336/agentic-controller`
> `feat/harness-ask-user` @ `94da2df` (not yet a PR); live-proven locally
> against real goose 1.45 + Bedrock (the turn blocked until the viewer
> answered "postgres" and the final sentence named it). Images: CI run
> 32288862173 (`controller_ref=feat/harness-ask-user`) →
> `ghcr.io/ibolton336/agent-java@sha256:caf6edaa5197c858d90616e9f2b8f454ef5fe228938faa1c0566c2ff6fc37525`
> (on agent-base `sha256:fb5c1c56…`), proven to carry the tool with an
> Always-pull throwaway pod; **the Agent CR `coolstore-quarkus-migrator`
> is pinned to that digest** (was the `:demo` tag — IfNotPresent would have
> kept a node-cached older image; rollback = set `spec.image` back to
> `ghcr.io/ibolton336/agent-java:demo`). UI: `feature/agent-runs`
> `9785ef32b` (ask cards) — see the digest block below for the roll.
> `HARNESS_HITL_ASK=off` on a run/Agent env disables the tool.
>
> **2026-08-19 (later): UI rolled to the steer build — `deploy/tackle2-ui` →
> `sha256:4771757311629fb8e67c2ff80843be84fd9fc9adb687b360d5b19eb483423bd2` @ `2082e16c0`
> (CI run 32280563070). The run chat's send box is now REAL goose steer on the
> run's session (relayed by the harness tee; late viewers discover the run
> id from goose's mismatch error) plus a confirmed "Stop the agent's turn",
> both behind the new UI env flag `AGENTIC_STEER_ENABLED` — **set to `true`
> on ROKS for Ian's live test; the dev-preview posture is `false`/unset (no
> send box at all).** Flip with
> `oc set env deploy/tackle2-ui AGENTIC_STEER_ENABLED=false -n konveyor-agents`.
> Rollback ref `sha256:4e1cc1fa…` (below).**
>
> **2026-08-19: controller + UI rolled to the ACPReady contract.**
> `deploy/agentic-controller-controller-manager` (agentic-controller-system)
> → `ghcr.io/ibolton336/agentic-controller@sha256:6986585c19ca7e8af8879643e64ef51154c986184766a05699e2fdeaa482ede5`
> (tag `pr160`, built by `build-controller.yml` from
> konveyor/agentic-controller#160 @ `f30937c`: `ACPReady` condition +
> `tcpSocket:4000` readiness probe, `phase=Running` = pod running; the
> ClusterRole `agentic-controller-manager-role` was patched to add
> `pods get/list/watch` which the pod watch needs; rollback =
> `quay.io/konveyor/agentic-controller:latest`, the extra rule is harmless
> to leave). `deploy/tackle2-ui` → `sha256:4e1cc1fa…` @ `d6d50ba50`: the
> chat panel dials ONCE on `ACPReady=True` (fallback loop only for
> controllers without the condition). Live-proven with a throwaway
> whoami-on-:4000 Agent: `phase=Running`, `ACPReady=True (Listening)`,
> single in-cluster dial of `<run>.konveyor-agents.svc:4000` → 200; then
> deleted. A real harness run through the console is the remaining
> end-to-end check (needs a logged-in session).
>
> **2026-08-18 (evening): UI rolled forward to `sha256:2dfae209…` @
> `ae6835dbe`** — the chat panel dials on the page's run status (one dial
> loop, no attempt counter, no second poll; the retry stays only because
> the controller still flips Running before :4000 listens — upstream fix
> in flight as konveyor/agentic-controller#130). Rolled via `kubectl set
> image` on `deploy/tackle2-ui` (container `ui`, konveyor-agents);
> route-verified: `/locales/en/translation.json` serves the new
> `startingAcp`/`waitingForSandbox` strings.
>
> **2026-08-12: UI rolled forward again to `sha256:19a151a0…` @
> `7787852`** — runs tables gain the application filter
> (column + Name/Application/Phase filters + pagination + deep-linkable
> URL params); live-verified on the route. Hub keeps `NAMESPACE=konveyor-agents` and
> the RBAC from `deploy/roks/hub-agentic-swap.yaml`; the UI runs with
> `AGENTIC_ENABLED=true` and no shim; the UI Deployment's container is
> named `ui` (the swap recipe's `tackle2-ui=` example is wrong there). The
> tackle-operator is scaled to 0 to hold the swap (scale to 1 to roll
> back; hub DB backed up on the PVC as `hub.db*.pre-agentic` — schema has
> been migrated forward by Jeff's builds).

2026-08-10. For the env being stood up around Jeff's hub `agent/*` endpoints.
The UI branch (`ibolton336/tackle2-ui@feature/agent-runs`, `b66c42efd`) no
longer speaks the hub-shim contract at all — every agentic call rides the
`/hub` proxy to the hub's `agent/*` surface, and the shim is not part of the
deployment.

## What the env needs

- **Hub** built from `jortel/tackle2-hub@agentic` — envelopes verified
  against `39b446bf` (2026-08-10); the `/agent/*` → `/agentic/*` prefix
  rename landed upstream at `7751e27d` (2026-08-11) and the UI speaks the
  renamed surface. Routes consumed:
  `/agentic/{agents,skills,skillcollections,gateways,agentruns,workflows,workflowruns}[/:name]`
  plus the `/agentic/agentruns/:name/acp` WebSocket relay.
  **Run-segment note:** agent runs ride `/agentic/agentruns` (renamed
  from `/agentic/runs` 2026-08-11 for kind-prefix parity with
  `workflowruns` and the CRD plural; landed upstream in `9ae3d72a`,
  branch head `0969d735`). Hub images built from OLDER refs still serve
  `/agentic/runs` — match whichever hub you run by adjusting the one-line
  segment/prefix constants at the top of
  `client/src/app/api/rest/agent-runs.ts`.
- **agentic-controller** installed (CRDs + controller) in the namespace the
  hub serves, plus at least one Gateway with working credentials.
- **Auth ON since 2026-08-12** (was `feature_auth_required: false` from the
  2026-07-30 install). Live-verified on ROKS end to end: browser OIDC login
  (hub builtin provider, PKCE) → bearer'd REST 200s → nonce mint 201 → ACP WS
  relay `Connected` on a Running run. Anonymous is 401 on every route (the UI
  proxy rewrites non-JSON 401s to a 302 → `/` — send `Accept:
  application/json` to see the raw status). Flip recipe, both sides:
  - Hub: `AUTH_REQUIRED=true` on the hub deployment. Prereq: the `web-ui`
    IdpClient CR must live in the hub's `NAMESPACE` (`konveyor-agents`) —
    `kubectl apply -f deploy/roks/idpclient-webui.yaml`. The operator's copy
    in `konveyor-tackle` is invisible to the swapped hub (`/oidc/authorize`
    400s "unable to retrieve client by id" without it; the hub picks up the
    CR live, no restart needed).
  - UI: `AUTH_REQUIRED=true` **plus** `OIDC_ISSUER=https://<route>/oidc` and
    `OIDC_CLIENT_ID=web-ui`. The image entrypoint exits 1 without the OIDC
    pair (crashloop); on this branch only the entrypoint reads
    `OIDC_ISSUER` — the client authority is hardcoded same-origin `/oidc`
    and the server proxies `/oidc` to `TACKLE_HUB_URL`.
  - Caveats: stock non-admin roles carry zero agentic scopes, so the console
    is effectively **admin-only** until jortel/tackle2-hub PR #2 lands in an
    image (architect/migrator 403 on all agentic routes). Harness token
    self-revoke 403s under auth (addon role lacks `tokens` scope) — token
    Secrets linger, runs unaffected. Hub OIDC keeps no SSO session: every
    authorize round-trip shows the login form, but the hub grants refresh
    tokens so `automaticSilentRenew` keeps live UI sessions alive.
  - Rollback: set `AUTH_REQUIRED=false` on both deployments (UI keeps the
    OIDC vars harmlessly).
- **Seed resources** cluster-side (there is no Load-defaults button anymore):
  `kubectl apply -f manifests/samples.yaml` from this repo, run by the env
  owner on their cluster.

## UI deployment

- Image: `ghcr.io/ibolton336/tackle2-ui:demo` (multi-arch amd64+arm64).
  `:demo` is a moving tag — pin the digest recorded at the bottom of this
  doc, or re-resolve with
  `skopeo inspect docker://ghcr.io/ibolton336/tackle2-ui:demo | jq -r .Digest`.
- Env on the UI container:
  - `AGENTIC_ENABLED=true` — plain flag now; without it the agentic nav and
    routes do not render. (`AGENTIC_SHIM_URL` is gone; setting it does
    nothing.)
  - `AGENTIC_STEER_ENABLED=true|false` (default false) — shows the run
    chat's send box, which steers the LIVE run (goose
    `_goose/unstable/session/steer` + `session/cancel` on the run session,
    relayed by the harness tee; the harness's own kill switch is
    `HARNESS_HITL_STEER=off`). Leave unset for the read-only dev-preview
    posture.
  - `TACKLE_HUB_URL=<in-cluster hub service URL>` — same value the stock
    image already uses; ALL agentic traffic rides it too.
- Deploy the image however the env manages the UI (operator image override
  or a raw Deployment patch) — no extra sidecars, no shim.

## What works now (verified against a contract-exact mock hub)

- All five list pages (Agent runs, Agents, Skills, Workflows, Workflow
  runs) and both detail pages, reading raw CRs from `/agentic/*`.
- Agent/skill/collection/workflow CRUD incl. the hub's PUT→204 semantics.
- Run creation from the Agent runs page, the Workflow runs page, and the
  application inventory (drawer + bulk launch): wire shape is a real CR —
  `metadata.generateName: "ui-"`, `metadata.labels["konveyor.io/application"]
  = "<hub app id>"` stamped client-side, platform params resolved by the
  modal into `spec.params`.
- Per-application run views filter on the `konveyor.io/application` label.
- ACP chat connects through the hub relay (`/hub/agentic/agentruns/:name/acp`);
  the Express server proxies the WS upgrade. Note the relay dials the
  sandbox Service by cluster DNS, so chat only works with the hub running
  in-cluster.
- Agent designer image field is free text with built-in suggestions
  (`agent-base`/`agent-java` ghcr refs); no catalog endpoint needed.

## Pending on the hub branch — what a tester will see

| Gap | Symptom in the UI |
|---|---|
| No run cancel (and no run delete by design) | Runs have no destructive actions; a stuck run must be handled with kubectl |
| ~~Token minting / env injection~~ **RESOLVED 2026-08-11** — contract split agreed with Jeff: the creating client supplies `APP_ID` + `TARGET_BRANCH` in `spec.env` (UI does since `7c39236ef`), the hub injects `HUB_BASE_URL` + the minted token Secret (`HUB_TOKEN`/`HUB_TOKEN_ID`) and MERGES with client env | Verified green on ROKS: run `ui-94kc2` grounded through the hub with the minted token (app + identities + 49 insights fetched), pushed its branch, and the harness revoked the token on completion (`POST /auth/tokens/:id/revoke → 204`) |
| Application label not stamped server-side | UI stamps it client-side at create; runs created by other clients won't appear in per-app views until the hub stamps |
| ~~Run lists filter `konveyor.io/managed=true`~~ **RESOLVED @ `0969d735`** — run lists are unfiltered; the managed filter moved to the Agents list (with create-side label injection) | Workflow-run drill-downs show controller-created stage runs on hubs ≥ `0969d735`; older hubs still hide them |
| No 400 on managed-agent run without an application | A doomed run is accepted and fails late in the harness (the UI's own modals prevent this path, other clients aren't protected) |
| Harness-SA name mismatch: `tokenSecret` looks up hub SA `agentic.harness` but `internal/auth/seed/serviceaccounts.yaml` still seeds `agent.harness` (rename casualty, present @ `0969d735` through branch head `a3af8307`) | **Every** run and workflow-run create fails `404 {"error":"SA (agentic.harness) not-found"}` — hit live on ROKS 2026-08-11 after the pair swap; remedy below applied there same day (SA id 1001), probe-verified. Needed once per hub install until the seed is fixed upstream |
| ~~WS auth mechanism~~ **IMPLEMENTED both sides 2026-08-11** — hub @ `a3af8307`: authenticated `POST /agentic/agentruns/:name/acp/nonce` → 201 nonce (single-use, 30s TTL), and `GET .../:name/acp?nonce=...` redeems it **unconditionally — required even with auth off**; UI mints per dial attempt, falling back to the bare dial when the mint 404s (pre-nonce hub) | Hubs built ≥ `a3af8307` refuse nonce-less dials — UI images older than the two-step lose chat against them. The pinned pair below predates the nonce era on BOTH sides and stays self-consistent |

Also: runs created before this migration carried the application only in
`spec.env` (`APP_ID`) with no label — they won't show up in per-application
views. Fresh runs are labeled.

### Remedy for the harness-SA mismatch (one-time, per hub install)

Create the missing hub service account via the API (hub auth is open on the
demo install; addon role id is `100` from the role seed). Omitting `id` makes
the PK sequence assign one ≥ 1000, which the boot-time seed reconciler never
deletes — so the row survives hub restarts:

```bash
curl -sS -X POST "$HUB/serviceaccounts" -H 'Content-Type: application/json' -d '{"name":"agentic.harness","description":"Agent harness. Hotfix row: hub@0969d735 looks up agentic.harness but the seed creates agent.harness.","roles":[{"id":100,"name":"addon"}]}'
```

Verify without launching anything: POST a workflow run whose CR name the
apiserver must reject — before the fix it 404s with the SA error, after it
the error changes to a DNS-1123 name validation failure (the handler revokes
the token and deletes the secret on that path, so nothing persists):

```bash
curl -sS -X POST "$HUB/agentic/workflowruns" -H 'Content-Type: application/json' -d '{"metadata":{"name":"SA-Probe-INVALID-NAME"}}'
```

## Drift check before testing

The hub branch moves fast (7 commits on 2026-08-10 alone). Before blaming
the UI, re-check the surface:

```bash
gh api repos/konveyor/tackle2-hub/compare/main...jortel:agentic --jq '.commits[-1].sha'
```

If it moved past `39b446bf`, diff `internal/api/agent.go` for route or
envelope changes. The UI's expectations are executable: the mock hub in
`hack/mock-inventory-stack.mjs` encodes the exact contract (CR envelopes,
204s, managed-label injection, WS handshake) — point the dev rig at a real
hub and any drift shows up as a concrete page/wire failure.

## Local reproduction of everything above

`.claude/launch.json` entry `mockstack` (mock hub on :18090) +
`tackle2-ui-dev-mockhub` (dev server on :9000) — or the prod-mode pair
`tackle2-ui-prod-agentic-on` (:9102) / `tackle2-ui-prod-no-agentic`
(:9101) for the feature-flag behaviors.

## Image digests (this build — the `/agentic` pair, deploy together)

- **UI (live on ROKS since 2026-08-19 evening):** `ghcr.io/ibolton336/tackle2-ui:demo` @
  `sha256:96c9f1c24a01fb83a23b598e3e923e8d8243ef2c7f0748a2e8b5bfe13474b1e6`
  (multi-arch index, CI run 32289704197, built from `feature/agent-runs` @
  `9785ef32b` — the agent's questions render as answerable cards
  (elicitation/create), plus the expand-to-full-screen toggle and the
  steer send box behind `AGENTIC_STEER_ENABLED`). Pairs with the `pr160`
  controller and the ask-capable agent image pinned on the Agent CR (see
  above). Rollback refs, newest first:
  `sha256:0e81fe79e2594557b2833fa013bcb597651f49fcddfbea19a1c799f5eceddc5f`
  (CI run 32284995333, `ad3b7fdf3` — expand toggle + steer), then
  `sha256:4771757311629fb8e67c2ff80843be84fd9fc9adb687b360d5b19eb483423bd2`
  (CI run 32280563070, `2082e16c0` — real steer behind the flag), then
  `sha256:4e1cc1fa9847b49238839098a470f108ca1301fb74b696d74f1c1ec600ec8959`
  (CI run 32267694980, `d6d50ba50` — chat panel dials once on the AgentRun
  `ACPReady` condition; fallback dial loop for controllers without it), then
  `sha256:2dfae209daaeca7ffe3efd4398a5076cdf09ebe9480c6059d4df8b3ac5564066`
  (CI run 32206879330, `ae6835dbe` — chat panel driven by the page's run
  status, dial loop on phase=Running), then
  `sha256:19a151a0a640f9be4c9bc4a64b9e7cb31d7b50fe682c3c99de1c084a6a3a40d0`
  (multi-arch index, amd64+arm64, CI run 31607291646, built from
  `feature/agent-runs` @ `7787852` — everything in `20162dc92` (agentruns
  segment, ACP nonce two-step with bare-dial fallback, sidebar-unmount
  fix) plus the runs tables on useLocalTableControls: Application column
  off the `konveyor.io/application` label, Name/Application/Phase
  filters, sorting, pagination, and URL-param persistence so
  per-application views deep-link, e.g.
  `/agent-runs?agr:filters={"application":["coolstore"]}`)
- **Agent images (`:demo` tag repaired 2026-08-19 17:46Z, CI run 32282717630,
  built from the fork's `main` = upstream `ef5a7e1`):**
  `ghcr.io/ibolton336/agent-java:demo` @
  `sha256:edfc357a56bb8cf925bfa8813f89e6986abff19fe81e98dea99ce513d06f60d5`
  (amd64 child `sha256:08122c18…`) on
  `ghcr.io/ibolton336/agent-base:demo` @
  `sha256:67df962a1f56cc4979868015101571d6002fec529b1c48c8cd0bd22c93a7d4f8`.
  Proven tee-capable with a throwaway `Always`-pull pod on ROKS (harness
  binary references `HARNESS_HITL_STEER` and `internal/tee`; goose 1.45.0).
  Before this, every default `build-images.yml` dispatch since 08-07 had
  re-pushed `:demo` from the fork's `demo/dylan-workload` (07-31, NO tee);
  ROKS runs kept a live view only via a node-cached older image
  (`sha256:97c31431…`, pull policy IfNotPresent). The Agent CR
  `coolstore-quarkus-migrator` pulls `agent-java:demo` by tag, so new nodes
  now get this build. (The same run also re-tagged `tackle2-ui:demo` as
  `sha256:64fdfc72…` from the same `2082e16c0` source — ROKS stays pinned to
  `sha256:47717573…`.)
- **Hub (live on ROKS since 2026-08-18):** `quay.io/jortel/tackle2-hub@sha256:d849875b3dcdb14929516e1b64ad354c42d46bc25c3fdc4b87cb0db279f02224`
  (Jeff's rolling `:agent`, pushed 08-18 15:17Z from his post-review
  branch — SA seed rename, role grants, PM acp fix, close-frame relay;
  linux/amd64). Rollback refs, newest first:
  `quay.io/jortel/tackle2-hub@sha256:d91360774eac150a466a81b802bfe505b195c46ba4725d4b42bf99cb2b1c0634`
  (nonce-era ≥ `a3af8307`, live 08-11 → 08-18; needs the hand-made
  `agentic.harness` SA row — the seed on d849875b adopted it by name), then
  `ghcr.io/ibolton336/tackle2-hub:agentic` @
  `sha256:8a3fe0a09fb929acdd9c99006cff3d481e7e26a8c73d4e9119c1c1ab255f9752`
  (multi-arch, CI run 31515352680, `jortel:tackle2-hub@agentic` @
  `0969d735` — pre-nonce; the DB schema has since been migrated forward by
  Jeff's builds, so rolling back this far is unverified).

Deploy as a pair — mixed pairs break the agentic pages, and four
contract eras now exist (`/agent/*`, `/agentic/runs`,
`/agentic/agentruns`, and `/agentic/agentruns` + required ACP nonce).
Superseded same-day pair: UI `eaac1de2` + hub `a484513f` (the
`/agentic/runs` era; also UI `cad1b3e5`, pre-nonce; also UI `04ee4721`
@ `f91267d13`, nonce-era but with the sidebar-unmount bug; also UI
`2da83eb1` @ `20162dc92`, sidebar fix but hand-rolled runs tables — no
filtering). The ROKS deployment runs the UI digest above since
2026-08-12 (rolled via `kubectl set image` through the demo-guest
context; live-verified — 37-run history paginates, application filter
narrows to the 4 labeled coolstore runs, workflow-runs multiselect
deep-links across daytrader+kitchensink). To run a nonce-era hub
today, Jeff publishes his branch as `quay.io/jortel/tackle2-hub:agent`
(rolling tag) — pair it with a UI built from the two-step commit onward
(the two-step falls back to a bare dial on pre-nonce hubs, so the UI tip
tolerates every `/agentic/agentruns`-era hub).
