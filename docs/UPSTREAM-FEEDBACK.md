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

## 4. Skills are broken on Docker-runtime clusters (ImageVolume support)

**Where:** `resolveSkillVolumes()` — skills mount as `corev1.ImageVolumeSource`
at `/opt/skills/{name}/`.

**What:** verified live on minikube (k8s v1.35.1, runtime `docker://29.2.1`
via cri-dockerd): the whole chain works — SkillCard Ready
(`ImageResolved`), Agent Ready, ImageVolume present in the pod spec,
kubelet accepts it ("can be accessed by the pod") — and then the pod
sticks in `CreateContainerError`:

> Error response from daemon: invalid mount config for type "bind":
> field Source must not be empty

cri-dockerd doesn't implement CRI image-volume mounts (containerd >= 2.0 /
CRI-O do). Default minikube — the documented dev path — uses the docker
runtime, so **any Agent that declares a skill produces runs that can never
start** there. Repro: `docs/demo/skill-probe.yaml` in the client repo.

**Compounding it:** the AgentRun reports `phase=Running` the whole time —
the Sandbox-condition mapping doesn't surface container-level failure, so
clients show "connecting…" forever with no hint.

**Asks:** (a) document the minimum platform for skills (containerd >= 2.0 /
CRI-O with image-volume support; feature gate); (b) consider an
initContainer-copy fallback (skill image as initContainer, `cp` into a
shared emptyDir) which works on every runtime; (c) map sandbox/pod
container failures into AgentRun conditions (and ideally a Failed phase)
so unstartable runs are visible.

## 5. Per-run skill selection doesn't exist yet (worth stating)

`AgentRunSpec` has no skills field — every run mounts all of its Agent's
skills. Fine for MVP, but the enhancement's "Agent = capability menu,
AgentRun = specific selections" is currently only true for models. Worth a
doc note so client teams don't design per-run skill pickers against an API
that isn't there.

## 6. Minor operational notes

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

- Client contract + transport layering ADR: `docs/adr/0009-client-contract-and-transports.md`
- Reference shape for the future Hub passthrough proxy (route table the
  UIs were built against): `packages/hub-shim`
- Working agent base showing the KONVEYOR_* env contract end-to-end:
  `harness-goose/entrypoint.sh`

---

# Upstream feedback for konveyor/agentic-controller PR #36 (AgentPlaybookRun — since renamed AgentWorkflowRun)

Findings from running the merged PR #36 controller (commit `fff23af`) on
minikube, verified empirically 2026-07-21. Same format and standing rule
as above: nothing here gets posted upstream by tooling — delivery is a
human decision.

## 7. Exit-code stage failures hang the playbook run instead of failing it

**Where:** the AgentPlaybookRun controller's stage execution — sandbox
pods are created with `restartPolicy: OnFailure`.

**What:** a playbook stage whose container exits non-zero crashloops
indefinitely: kubelet keeps restarting it, so the pod phase stays
`Running`, Agent Sandbox v0.5.0 never reports a terminal failure reason,
the stage's AgentRun never leaves `Running`, and the AgentPlaybookRun
hangs with all subsequent stages `Pending` forever instead of failing the
run. The PR's "stage failure fails the entire playbook run" semantics are
therefore unreachable for exit-code failures — the only failure mode a
run-to-completion container actually has. Repro: a two-stage playbook
where stage 1's image runs `sh -c 'sleep 3; exit 1'` — observed 4+
restarts and the run stuck `Running` >2.5 minutes with stage 2 `Pending`;
the success-path control (same playbook, `exit 0`) completed in ~20s.

**Asks:** (a) run-to-completion stage pods should use
`restartPolicy: Never` or a bounded retry (`backoffLimit`-style) so a
failing stage reaches a terminal pod state; (b) the AgentRun controller
could treat sustained `CrashLoopBackOff` as failure — same surfacing gap
as item 4's ask (c), where container-level failure never maps into
AgentRun conditions; (c) until then, document the constraint so playbook
authors know exit-code failures hang rather than fail.

_(Item 7 recovered 2026-08-18 from a July worktree draft; the gap is tracked on the personal board as "fail-path gap" and is adjacent to AC #129 / A5. Not filed upstream yet.)_


---

# Gateway verification on a fresh ROKS bring-up (2026-09-10)

Full-stack bring-up on a new ROKS cluster (OpenShift 4.21, 3×amd64,
`agentic-demo` / `c116-e.us-south`) following `deploy/roks/README.md`.

**Neither finding below is a new upstream bug.** Both were chased from live
symptoms before checking upstream state, and both turned out to be already
known — one already fixed. Recorded here for the cluster-side consequence and
so the same rabbit hole isn't re-entered.

Standing rule as above: nothing gets posted upstream by tooling.

## 8. Bedrock Gateway can't verify — already filed as AC #167

Live symptom: `bedrock-sonnet` and `bedrock-haiku` park at
`Ready=False reason=ConnectionFailed`, Agents go `DependenciesNotReady`, and
runs cannot start. Root cause is the OpenAI-shaped `/v1/models` probe, which
Bedrock 404s, combined with #149 tightening the accepted code to `^2`.

This is exactly **konveyor/agentic-controller#167** ("Gateway verification
cannot pass for native aws-bedrock / gcp-vertex-ai providers"), filed
2026-08-20. Still open, still unlabeled, zero comments, and the closing
question ("is skip-with-reason acceptable as the interim? Happy to PR it")
is unanswered three weeks on. Confirmed still present on `origin/main`
(`cfb101f`): `endpointModelsProbe` and `verificationHTTPCodePattern` are
unchanged and `aws_bedrock` is still in `knownProviders`.

Two details from this bring-up that were not in #167 and argue for the
skip-with-reason option:

- The probe returns **404**, not the 403 the issue assumes. Immaterial to the
  conclusion (both matched the old `^[2-4]`), but the diagnostic on status
  will read `http code=404`.
- Because Bedrock uses a **keyless** `credentialRef`, `includeAuth` is false
  and the verification pod is handed **no credentials at all** — its env is
  `LLM_ENDPOINT` only. So for these providers the probe cannot be an auth
  check even in principle, which undercuts the argument for keeping a real
  probe and favours skipping with an honest reason.
- Blast radius is a **silent hang, not a failure**: `agentrun_controller.go`
  sets `Succeeded=Unknown reason=AgentNotReady` and returns, deliberately
  ("the run is not failed — it waits"). Runs sit with no terminal state,
  the same UX as item 7.

**Cluster-side workaround** (not a fix): patch the Gateway status to
`Ready=True reason=ConnectionVerified` with `observedGeneration` equal to
`metadata.generation`. `isTerminalReadyReason` treats that as settled and the
reconciler stops re-probing until the spec changes.

**Update 2026-09-10:** the skip-with-reason option the issue proposed is
written and tested on branch `fix/gateway-verify-native-providers` in the
agentic-controller checkout (`3fdcf28`, off `cfb101f`). `aws_bedrock` and
`gcp_vertex_ai` settle as `Ready=True reason=VerificationSkipped` with
`connectionVerified` left false, so the Gateway is usable and status still
says nothing was checked. Full `internal/...` suite and golangci-lint pass.
Not pushed - per the standing rule above, that is a human decision.

## 9. Gateway Secret watch — already fixed upstream; our image is stale

Live symptom: creating `aws-bedrock-creds` after the Gateways left them
reporting `Secret "aws-bedrock-creds" not found` indefinitely. Secret created
`18:08:45Z`, last Gateway reconcile `18:05:25Z`, status still stale at
`18:13Z`. A no-op annotation unstuck it.

**This is fixed upstream.** AC #103 ("Gateway controller should watch
credential Secrets for re-reconciliation") was closed COMPLETED 2026-09-03 by
`69c677c` (#208), which adds the `gatewayCredentialSecretIndexField` index and
a `Watches(&corev1.Secret{}, ...)` — the same pattern the Agent controller
uses. Nothing to file.

The reason we saw it live is that
`ghcr.io/ibolton336/agentic-controller:demo` predates #208. That is an
image-currency problem on our side, and it matches the `:demo` moving-tag trap
already documented in `deploy/roks/README.md`.

**Ask of ourselves, not upstream:** rebuild the demo images off current main
before the next demo, and treat "reproduce against `origin/main`, not the
local checkout" as step zero. This section was originally written up as two
upstream bugs off a checkout that was 17 commits behind; the fetch is what
corrected it.
