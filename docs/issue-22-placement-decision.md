# Placement-decision comment on konveyor/agentic-controller#22

**History:** posted upstream 2026-07-27 (issuecomment-5093285863),
then folded the same day into the consolidated canonical comment
(under **Placement decided**) and reduced to a stub. Current record:
`issue-22-contract.md`.

Records the outcome of the 2026-07-27 design sync with the Hub
maintainer; closes open question 2 (host placement). Source material:
the call transcript; `issue-22-explainer.md`;
`issue-22-concurrency-findings.md` (the goose v1.39.0 source research
behind the single-writer requirement).

---

> **Placement decided.** Outcome of a 2026-07-27 design sync with the Hub maintainer — this closes **open question 2** in the [consolidated contract comment above](https://github.com/konveyor/agentic-controller/issues/22#issuecomment-4905804098) (edited to point here). The surface itself is unchanged; what follows is where it lands and how the create path splits between Hub and harness.
> 
> ## Decisions
> 
> 1. **Hub-native endpoints; the task system is out.** A Task is the run of an addon — first-class, with the task engine creating the pod. Reusing it as an envelope for agent runs would force the task engine to act as a second agent-run controller. Instead the Hub exposes handlers under a common route namespace (e.g. `/agent/…`) with standard scopes: POST creates the CR and that's it — fire-and-forget, no Hub-side reconciliation, the UI polls the REST resources. Hub's value-add is RBAC (architect/migrator scoping) plus create-time injection (below).
> 
> 2. **The CR stays platform-neutral.** No Konveyor concepts in the spec — an `appID` field is out; generic env-var extensibility is in. The Hub passes `HUB_URL`, the application ID, and a token (materialized as a Secret) through the CR's env mechanism. Anything in-cluster can still create the CR outside a Konveyor install and have it just work.
> 
> 3. **The harness is Konveyor-aware, deliberately — the addon/addon-adapter pattern.** Given hub URL + token + app ID, the harness uses the published hub Go client to fetch the application's details itself, clones the repo, **withholds the credentials from the agent** (the agent can't push), constructs the prompt from skills, then starts the ACP server. Same philosophy as addons: the host doesn't anticipate what the workload needs; the workload is given everything it needs to pull whatever it wants from the inventory.
> 
> 4. **The interactive channel (R2) lands in Hub too, as a separate deliverable.** HTTP GET → WS upgrade on the Hub, resolve the pod from `status.sandboxName`, read `status.secretKeyRef`, inject `X-Secret-Key`, pipe frames. Tracked as its own issue so the launch path doesn't depend on it.
> 
> ## What this does to the host-obligations table
> 
> | # | Was | Now |
> |---|-----|-----|
> | R1 | REST CRUD | Unchanged — Hub, thin, fire-and-forget |
> | R2 | WS proxy | Unchanged in shape — Hub-hosted, separate issue, **plus single-writer enforcement** (below) |
> | R3 | App inventory read | Stays for the UI's application picker; the **harness now also reads inventory directly** via the hub client |
> | R4 | Identity → mounted Secret | Shrinks to **materializing the token Secret**; identity retrieval moves into the harness |
> | R5 | Param/credential resolution | Moves **into the harness** for the Hub path — the Hub passes only `{HUB_URL, app ID, token}` |
> 
> Credential domains become three, with a new wall *inside the pod*: browser hub-token → Hub (existing); harness hub-token (scoped, Secret-mounted) → Hub API; per-run ACP key → agent server. The harness sees the git credentials; the agent never does.
> 
> Note on the param-source annotations (ADR 0010): for the Hub path they're superseded by harness-pulls. They remain the mechanism for callers/hosts that resolve values at create time, and **open question 1 (vocabulary governance) is unchanged** — though its urgency drops now that the primary host doesn't consume them.
> 
> ## Two things settled by already-verified contract facts
> 
> - **Key discovery needs nothing new.** The Hub reads `status.secretKeyRef` → Secret `<run>-acp-key` with its own service account; the harness never has to communicate the key out.
> - **Reusing the hub API token as the ACP `X-Secret-Key` was floated and is rejected.** It would put a Hub-scoped credential into the pod env and into `?token=` URLs (goose accepts the key as a query param for browser clients, and key-in-URL leaks into access logs), for no gain over the strictly narrower per-run key the controller already mints.
> 
> ## New R2 requirement: single-writer
> 
> Verified against goose v1.39.0 source (the ACP server we ship): every WebSocket connection gets a **private agent instance** — its own event stream, its own active-run guard. Sessions are shared only through the SQLite store underneath. Consequences: no live fan-out (a second client attached to the same session sees nothing live, only `session/load` replay), and the "one prompt at a time" guard does **not** cross connections — two clients can start prompts on the same session and interleave writes. The platform proxy must therefore enforce single-writer per run (or, later, fan one upstream connection out to N viewers). goosed will not do either.
> 
> ## Next steps
> 
> - Enhancement update reflecting the above (in progress)
> - Hub tracking issue: R1 routes + scopes + create-time env/token injection
> - Separate linked Hub issue for R2: dynamic per-run upstream, credential swap at the proxy boundary, a WS-friendly auth carrier for the hub token (browsers can't set `Authorization` on upgrade), and single-writer enforcement
