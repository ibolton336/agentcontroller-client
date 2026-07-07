# Upstream feedback for konveyor/agentic-controller PR #4

Findings from running PR #4 for real on minikube — two working clients
(VSCode extension + browser SPA via a Hub-proxy stand-in) and a real
goose+Bedrock agent base. Each item is formatted to paste as a review
comment. Cheapest to absorb pre-merge; none block the PR.

**Standing rule: nothing here gets posted upstream by tooling — delivery
is a human decision.**

---

## 1. Sandbox pods carry no `konveyor.io/agentrun` label (patch attached)

**Where:** `internal/controller/agentrun_controller.go`, `createSandbox()`.

**What:** the run/agent labels are set on the Sandbox CR metadata and the
ACP Secret, but not on `Spec.PodTemplate.ObjectMeta.Labels`. Agent Sandbox
v0.5.0 copies only PodTemplate labels onto the pod (plus its own
`sandbox-name-hash`), so the pod is not addressable by run label —
`kubectl get pods -l konveyor.io/agentrun=<run>` returns nothing, and any
client or dashboard using label-based discovery silently breaks (ours did).

**Ask:** add `konveyor.io/agentrun` + `konveyor.io/agent` to the
PodTemplate labels. Verified patch (applies clean, `go build` passes):
`hack/upstream-patches/0001-add-agentrun-labels-to-pod-template.patch`.

## 2. LLMProvider credentials are single-key; SigV4 providers don't fit

**Where:** `buildEnvVars()` — `KONVEYOR_MODEL_<ROLE>_API_KEY` is injected
from `credentialRef.{secretName,key}` (one key).

**What:** right shape for OpenAI-style bearer-token providers; structurally
insufficient for AWS Bedrock (SigV4 needs `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_REGION`). Today the only way to run Bedrock
is having the *client* add `run.spec.envFrom: [{secretRef: aws-creds}]`,
which leaks a provider concern onto every caller.

**Ask (either):** (a) let the controller `envFrom` the provider's whole
credential Secret into the sandbox when a model selects that provider, or
(b) make `credentialRef` a list of keys. (a) matches what the credential
Secret already is.

## 3. Contract facts worth documenting in the API docs / CRD comments

Verified against the live controller; every client depends on these:

- **Pod name == `status.sandboxName` == run name.** No suffix. Clients must
  resolve the pod strictly from `status.sandboxName` (also covers item 1's
  gap).
- **ACP key Secret data key is `secret-key`**, referenced via
  `status.secretKeyRef.name`. Worth stating so harnesses/clients don't
  guess.
- **The auto-created Service is headless with no ports.** In-cluster
  consumers dial `<sandboxName>.<ns>.svc:4000` (DNS → pod IP); there is no
  VIP. Out-of-cluster tooling must port-forward the pod, not the Service.
- **Whole-spec immutability** (`self == oldSelf`) means client "edit/retry"
  affordances are delete + recreate. Intentional and fine — but say so, or
  every UI team rediscovers it via a 422.

## 4. Minor operational notes

- The LLMProvider verification image is hardcoded to
  `quay.io/konveyor/agentic-controller-agent:latest` with no flag/env
  override — awkward for air-gapped/local clusters (we pre-load the tag to
  work around it). A `--verification-image` flag would help.
- The verification probe depends on `curl` being present in that image via
  the ubi-minimal base (full `curl` package today, not installed
  explicitly). If the base ever drops it, verification fails looking
  exactly like an unreachable endpoint. One-line hardening: add `curl` to
  the `microdnf install` line.
- Verification is reachability-only (any HTTP 2xx–5xx passes, no auth).
  Reasonable for MVP — worth a doc note so `connectionVerified: true`
  isn't read as "credentials valid".

## Supporting material

- Client contract + transport layering ADR: `docs/adr/0004-client-contract-and-transports.md`
- Reference shape for the future Hub passthrough proxy (route table the
  UIs were built against): `packages/hub-shim`
- Working agent base showing the KONVEYOR_* env contract end-to-end:
  `harness-goose/entrypoint.sh`
