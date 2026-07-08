# Follow-up comment for konveyor/agentic-controller#22

Paste-ready. Standing rule: upstream delivery is a human decision — post
this manually after review. Posting matters before @djzager's Hub fork gets
far, since it targets the surface table in the earlier comment.

---

Two updates on the contract above, both backed by running code.

## 1. Answering my own open question about diff preview

**No protocol extension is needed.** ACP already standardizes it:
`session/request_permission`'s `toolCall` is a `ToolCallUpdate`, whose
`content[]` accepts `{type: "diff", path, oldText, newText}` (`oldText: null`
= new file). Agents just have to populate it.

Implemented end to end — the mock harness attaches diff blocks to its
permission ask, and the browser UI renders them above Allow/Reject. For the
real harness (@savitha, @hiteshwari) this reduces to "emit the diff blocks
you already have"; nothing needs designing.

## 2. Platform-resolved params — where the repo URL, branch and creds come from

The gap the client layer kept hitting: an Agent declares typed params, but
nothing declares that `repository` **is** the selected application's repo
URL. Hub needs to know what to fill; the UI needs to know what not to ask.

Proposal, prototyped and verified against the real controller:

```yaml
metadata:
  labels:
    konveyor.io/managed: "true"          # Konveyor UIs list only these
  annotations:
    konveyor.io/param-sources: |
      {"repository": "konveyor.io/application-repository-url",
       "branch": "konveyor.io/application-repository-branch"}
    konveyor.io/credential-sources: |
      {"git": "konveyor.io/application-identity"}
```

Three deliberate choices, and the reasoning behind each:

- **Source ids are free-form namespaced strings, not a CRD enum.** An enum
  bakes Hub's domain vocabulary into a CRD whose own controller ignores the
  field, and makes every new source value a schema upgrade — one that fails
  *closed* (an older CRD rejects a newer Agent manifest at admission). The
  `storageClassName`/`ingressClassName` precedent applies: generic mechanism,
  operator-defined vocabulary, documented rather than validated.

- **Fail open, and it outranks every other rule.** A consumer that does not
  recognize a source id MUST treat the param as caller-supplied and render
  the field. Skew then degrades to "the user types it", never to "the field
  vanished" or "the manifest was rejected". (We shipped the opposite bug
  first and caught it in review — a UI that hides unrecognized-source params
  strands the user with an unfillable required param. Worth stating
  normatively.)

- **Credentials use the same mechanism**, resolving to a Secret the platform
  mounts via `spec.envFrom`. The alternative — callers passing `envFrom`
  themselves — couples every client to per-agent Secret knowledge, which is
  the same coupling this whole mechanism exists to remove. (It is also the
  structural problem behind the SigV4/Bedrock credential gap I raised on
  PR #4.)

Carrier is an **annotation** today, so no CRD change is required to try it.
The graduation path is an optional free-form `source` field on `AgentParam`
— no enum, no controller interpretation — once the pattern is agreed.

### API surface delta

- `GET /api/applications` → the platform's application inventory (mocked in
  the shim; Hub serves its real records)
- `GET /api/agents` list is filtered to `konveyor.io/managed=true`
  (get-by-name is never filtered)
- `POST /api/agentruns` accepts `applicationRef`; the platform resolves
  sourced params/credentials from it. Caller-supplied values always win. A
  required param with a *recognized* source the application cannot supply is
  a 400, never a silently empty value.

Verified: `POST {agentRef, applicationRef}` with **no params** yields an
AgentRun whose `spec.params` carries the resolved repo URL and branch and
whose `spec.envFrom` mounts the application's identity Secret — and the
controller starts a Running pod with those credentials. The create form for
a fully sourced agent collapses to **application picker + instructions**.

Details: [ADR 0005](https://github.com/ibolton336/agentcontroller-client/blob/main/docs/adr/0005-platform-resolved-params.md).

### This also answers open question 1 from the comment above

I asked whether read-only was sufficient for SkillCard/SkillCollection/
LLMProvider. With param sources in place the answer for the UI phase is
**yes** — the UI reads those resources and resolves values from the
application inventory; it never needs to create or mutate them through Hub.

Remaining question for Stream 2: does the source vocabulary live in a
well-known-values doc, and does `source` graduate to a CRD field, or stay
annotation-based until Hub's application model settles?
