# Prepared upstream patches

Patches in this directory are **prepared but not submitted**. They target
[konveyor/agentic-controller](https://github.com/konveyor/agentic-controller)
and were authored while validating the client contract against the real
controller (PR #4) on a live minikube cluster.

> **Sending anything upstream is a HUMAN decision.** Nothing in this repo's
> automation may post, push, or comment on the upstream project. These files
> exist so the change is ready to go the moment a maintainer decides to send
> it — review it, apply it to a branch of your fork, and open the PR yourself.

## 0001-add-agentrun-labels-to-pod-template.patch

**What it does:** in `createSandbox` (`internal/controller/agentrun_controller.go`),
mirrors the `konveyor.io/agentrun` and `konveyor.io/agent` labels into
`Sandbox.Spec.PodTemplate.ObjectMeta.Labels`.

**Why:** the controller already puts those labels on the Sandbox CR and the
ACP key Secret, but Agent Sandbox v0.5.0 copies only the *PodTemplate's*
labels/annotations onto the pod it creates. Today the sandbox pod carries only
`agents.x-k8s.io/sandbox-name-hash`, so label-based pod discovery by run name
is impossible and clients must resolve the pod by name via
`AgentRun.status.sandboxName` (which remains the recommended path — this patch
is additive observability/selectability, not a contract change).

**Verified:** `git apply --check` passes against the PR #4 branch (commit
`1766fcb`), the patched file is `gofmt`-clean, and `go build
./internal/controller/` succeeds with the patch applied.

**Apply (in an agentic-controller checkout of the PR #4 branch):**

```sh
git apply /path/to/0001-add-agentrun-labels-to-pod-template.patch
```
