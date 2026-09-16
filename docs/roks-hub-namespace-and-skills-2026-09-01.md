# ROKS c111-e — Hub namespace regression + missing skill images (2026-09-01)

Audit of the state a prior OpenAI/Codex "redeploy" session left on the ROKS demo
cluster (`demo-agentic-controller`, `c111-e.us-east`), plus the two follow-ups:
a durable fix for the Hub 500 and the SkillCard image gap.

All findings verified read-only. The only mutation applied this session was the
Hub namespace stopgap (see below).

---

## 1. Hub `/agentic/*` 500 — durable fix

### What breaks, and why the stopgap is a stopgap

- Hub image is stock `quay.io/konveyor/tackle2-hub@sha256:f09eb23b…` — the
  agentic endpoints exist; the 500 is authorization, not a missing build.
- The Hub decides which namespace holds agentic resources from its `NAMESPACE`
  env. The stock operator template hardcodes it:

  ```yaml
  # tackle2-operator roles/tackle/templates/deployment-hub.yml.j2
  env:
    - name: NAMESPACE
      valueFrom:
        fieldRef:
          fieldPath: metadata.namespace   # always konveyor-tackle
  ```

- Agents live in `konveyor-agents`, not `konveyor-tackle`. So the Hub lists
  `agents.konveyor.io` in `konveyor-tackle`, where there are 0 agents **and** the
  hub SA has no RBAC → 500:

  ```
  agents.konveyor.io is forbidden: User
  "system:serviceaccount:konveyor-tackle:tackle-hub" cannot list resource
  "agents" in API group "konveyor.io" in the namespace "konveyor-tackle"
  ```

- RBAC in the *right* namespace is already present:
  `oc auth can-i list agents.konveyor.io -n konveyor-agents --as=…tackle-hub` →
  **yes** (RoleBinding `tackle-hub-agentic`).

- The `tackle-hub` Deployment is owned by the `Tackle/tackle` operator CR. The
  operator was scaled back up at some point, reconciled the Deployment back to
  the template, and wiped the `NAMESPACE=konveyor-agents` override that used to
  make this work. That is the regression.

### Why "set it in the Tackle CR" does not work

Stock `tackle2-operator@sha256:985f0c62…`:

- CRD `tackles.tackle.konveyor.io` is `x-kubernetes-preserve-unknown-fields`
  (0 typed spec props) — so it *accepts* arbitrary spec keys, but
- the Ansible role has **no** variable that feeds the Hub's `NAMESPACE`.
  `app_namespace` defaults to `konveyor-tackle` and drives every hub object's own
  metadata.namespace; there is no separate "agent namespace" var to set.

So there is no supported knob. Any value you put in the CR is ignored by the
role.

### Stopgap applied this session (reversible)

```bash
oc -n konveyor-tackle scale deploy/tackle-operator --replicas=0   # pause reconcile
oc -n konveyor-tackle set env deploy/tackle-hub NAMESPACE=konveyor-agents
```

Verified: `/agentic/agents` + `/agentic/agentruns` → 200 both in-pod and through
the console route `/hub/agentic/*` (1 managed agent, 33 agentruns).

**Trap:** scaling `tackle-operator` back to 1 reverts the env and re-breaks
agentic. While the operator is at 0 it reconciles nothing else either.

### Durable fix: co-locate agentic resources in `app_namespace` (per #596)

An earlier draft here proposed adding a `hub_agent_namespace` operator var to let
the Hub watch a *separate* agent namespace (filed as `konveyor/operator#597`).
That was **closed** in favour of the model established by David Zager's
`konveyor/operator#596` ("Add agentic controller as an opt-in operand", merged
2026-09-01 ~20:10Z).

What #596 established:

- The operator deploys the agentic controller as an opt-in operand into
  `app_namespace`, gated on `agentic_enabled` + the Agent Sandbox CRD.
- The controller gets a **ClusterRole**, so it watches **cluster-wide**.
- It did **not** change the Hub's `NAMESPACE` — the Hub still serves agentic
  resources from its own namespace only.

The intended topology is therefore **co-location**: the agentic CRs live in
`app_namespace` (`konveyor-tackle`) alongside the Hub. The controller can watch
anywhere, but the Hub is the read/API layer and serves a single namespace, so
the CRs belong where the Hub is. A split layout (agents in `konveyor-agents`,
Hub in `konveyor-tackle`) is exactly what breaks, and it's not the supported
shape.

ROKS currently runs the split layout for historical reasons — that is the thing
to migrate away from. Aligning ROKS to the #596 model:

1. Upgrade the operator to a #596+ image (the deployed `sha256:985f0c62…`
   predates it — the agentic controller here is deployed manually, not as an
   operand).
2. Move the agentic CRs (`Agents`, `Gateways`, `AgentRuns`, `AgentWorkflows`,
   `SkillCards`) into `konveyor-tackle` (or make `konveyor-agents` the
   `app_namespace` and run the whole stack there).
3. Set `agentic_enabled: true` (and `agentic_steer_enabled` as desired) on the
   Tackle CR; let the operator manage the controller + console.
4. Retire the manual `NAMESPACE` env patch and un-pause the operator
   (`scale deploy/tackle-operator --replicas=1`).

This is a real migration, not a one-liner, so the stopgap above holds until it's
scheduled. Until then: **operator stays at 0** and the Hub keeps the literal
`NAMESPACE=konveyor-agents`.

---

## 2. SkillCards reference unpublished images

SkillCards exist in two namespaces (`konveyor-agents`, `agent-sandbox-system`),
identical set. Each sets `spec.image: quay.io/konveyor/skills:<name>` and the
controller pulls that image into the AgentRun pod.

Published tags at `quay.io/konveyor/skills` (repo exists, anonymous read OK):

| tag                   | published? | SkillCard type |
| --------------------- | ---------- | -------------- |
| `ejb-to-cdi`          | ✅ yes     | skill          |
| `maven-migration`     | ✅ yes     | skill          |
| `no-javax-imports`    | ✅ yes     | rule           |
| `javaee-to-quarkus`   | ❌ **no**  | skill          |
| `javax-to-jakarta-ee` | ❌ **no**  | skill          |

(Also present but unused by cards: `latest`, `latest-amd64`.)

So 3 of 5 exist; **`javaee-to-quarkus` and `javax-to-jakarta-ee` were never
published.** Run `ui-fbm4b-assess` used `javaee-to-quarkus` → `manifest unknown`
→ ImagePullBackOff → (now, on the fail-fast controller) Failed/StageFailed.

**Gap:** the SkillCards report `READY=True` even though their images don't exist —
readiness doesn't validate the image is pullable; only the AgentRun discovers it
at pull time. This is the class of thing AC#171/#172 (loader failures / never-
starting pods surfacing on status) are meant to cover.

### Options

- Publish the two missing tags to `quay.io/konveyor/skills` (matches every other
  card's convention). Preferred if these skills are meant to be first-class.
- Or repoint the two cards at an existing image (e.g. bundle their content in the
  agent-java image + `subPath`, per the current getting-started samples) and stop
  referencing per-skill tags that aren't built.
- Either way, don't rely on SkillCard `READY` — it does not prove pullability.

---

## Owed

- Rotate the two `sha256~…` login tokens pasted into chat this session.
- Controller + UI are backed by one-off in-cluster binary builds
  (`agentic-controller-redeploy`, `tackle2-ui-agent-runs` BuildConfigs) — rebuild
  through CI before treating this as a stable demo image set.
