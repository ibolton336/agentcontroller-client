# Running the migrated tackle2-ui against the real hub

> **2026-08-11: this recipe is LIVE on the ROKS demo cluster.** The
> tackle-hub deployment runs `ghcr.io/ibolton336/tackle2-hub@sha256:e16ddab6…`
> (built from `jortel:agentic` by the `build-hub` workflow) with
> `NAMESPACE=konveyor-agents` and the RBAC from
> `deploy/roks/hub-agentic-swap.yaml`; the UI runs the migrated image with
> `AGENTIC_ENABLED=true` and no shim. The tackle-operator is scaled to 0 to
> hold the swap (scale to 1 to roll back; hub DB backed up on the PVC as
> `hub.db*.pre-agentic` — note Jeff's build migrated the schema forward).

2026-08-10. For the env being stood up around Jeff's hub `agent/*` endpoints.
The UI branch (`ibolton336/tackle2-ui@feature/agent-runs`, `b66c42efd`) no
longer speaks the hub-shim contract at all — every agentic call rides the
`/hub` proxy to the hub's `agent/*` surface, and the shim is not part of the
deployment.

## What the env needs

- **Hub** built from `jortel/tackle2-hub@agentic` — verified against
  `39b446bf` (2026-08-10). Routes consumed:
  `/agent/{agents,skills,skillcollections,gateways,runs,workflows,workflowruns}[/:name]`
  plus the `/agent/runs/:name/acp` WebSocket relay.
- **agentic-controller** installed (CRDs + controller) in the namespace the
  hub serves, plus at least one Gateway with working credentials.
- **Auth off** for now (`feature_auth_required: false`). With auth on, REST
  works (the UI attaches Bearer tokens) but the ACP WebSocket will 401 —
  browsers cannot send an Authorization header on WS; mechanism TBD with
  Jeff.
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
  - `TACKLE_HUB_URL=<in-cluster hub service URL>` — same value the stock
    image already uses; ALL agentic traffic rides it too.
- Deploy the image however the env manages the UI (operator image override
  or a raw Deployment patch) — no extra sidecars, no shim.

## What works now (verified against a contract-exact mock hub)

- All five list pages (Agent runs, Agents, Skills, Workflows, Workflow
  runs) and both detail pages, reading raw CRs from `/agent/*`.
- Agent/skill/collection/workflow CRUD incl. the hub's PUT→204 semantics.
- Run creation from the Agent runs page, the Workflow runs page, and the
  application inventory (drawer + bulk launch): wire shape is a real CR —
  `metadata.generateName: "ui-"`, `metadata.labels["konveyor.io/application"]
  = "<hub app id>"` stamped client-side, platform params resolved by the
  modal into `spec.params`.
- Per-application run views filter on the `konveyor.io/application` label.
- ACP chat connects through the hub relay (`/hub/agent/runs/:name/acp`);
  the Express server proxies the WS upgrade. Note the relay dials the
  sandbox Service by cluster DNS, so chat only works with the hub running
  in-cluster.
- Agent designer image field is free text with built-in suggestions
  (`agent-base`/`agent-java` ghcr refs); no catalog endpoint needed.

## Pending on the hub branch — what a tester will see

| Gap | Symptom in the UI |
|---|---|
| No run cancel (and no run delete by design) | Runs have no destructive actions; a stuck run must be handled with kubectl |
| ~~No token minting / env injection~~ **PARTIALLY LANDED** (verified on ROKS 2026-08-11): run create injects `spec.env HUB_BASE_URL` + `envFrom` a minted Secret with `HUB_TOKEN`/`HUB_TOKEN_ID` | What's still missing is the application id and `TARGET_BRANCH` |
| Env-name drift — **proven live on ROKS**: harness requires `APP_ID`, hub injects no app id at all | Every managed-agent run fail-fasts: pod exits `config: required env var APP_ID is not set`, run reports Failed within seconds |
| Application label not stamped server-side | UI stamps it client-side at create; runs created by other clients won't appear in per-app views until the hub stamps |
| Run lists filter `konveyor.io/managed=true` | Controller-created workflow **stage runs are invisible** — the workflow-run drill-down looks empty even while stages execute |
| No 400 on managed-agent run without an application | A doomed run is accepted and fails late in the harness (the UI's own modals prevent this path, other clients aren't protected) |
| WS auth mechanism | Works only while auth is off (see above) |

Also: runs created before this migration carried the application only in
`spec.env` (`APP_ID`) with no label — they won't show up in per-application
views. Fresh runs are labeled.

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

## Image digest (this build)

- `ghcr.io/ibolton336/tackle2-ui:demo` @
  `sha256:a660050d10dbb48d5a4df99ccae2dbd30e629f051aae886fa15cfc2d090cb034`
  (multi-arch index, amd64+arm64, CI run 31440982894, built from
  `feature/agent-runs` @ `b66c42efd`)
