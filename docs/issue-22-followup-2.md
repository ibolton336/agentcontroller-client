# Follow-up §3 for konveyor/agentic-controller#22 — host-neutral contract

**History:** posted upstream 2026-07-21 (issuecomment-5039708925), then
folded the same day into the consolidated canonical comment and reduced
to a stub. Current record: `issue-22-contract.md`.

Written after the 2026-07-21 UI/UX sync, where placement (Hub vs sidekick
vs launch addon) was explicitly deferred until the contract requirements
are established — this section IS those requirements.

---

## 3. Naming the contract host-neutral — and what any host must provide

The first comment framed the shim's surface as "the reference shape for the
Hub passthrough proxy." That baked in an assumption about *where* the
surface lives, and this week's UI/UX sync surfaced that placement is
genuinely open: native Hub endpoints, a sidekick service deployed next to
the agentic-controller, or — for the launch path only — a Hub addon that
constructs runs from task data, the way generators and analyzers consume
task Data today.

So, a reframe: the surface table above is proposed as **Agent Runs API
v1**, host-neutral. A client written against it works against any
placement by swapping base URL + auth (already demonstrated — the same
browser client runs against the shim today and was designed for Hub
tomorrow). Placement shouldn't block client work; what placement *does*
need is an explicit list of what the host must provide. From running all
of this end-to-end:

| # | Host obligation | Notes from the running system |
|---|-----------------|-------------------------------|
| R1 | Authenticated REST CRUD over the CRs (agents, runs, workloads, workload-runs; read-only providers/skillcards/skillcollections) | Plain k8s passthrough + authz + the `konveyor.io/managed` list filter. No domain logic. |
| R2 | Long-lived bidirectional WS proxy to the run pod: resolve via `status.sandboxName`, read `status.secretKeyRef`, inject `X-Secret-Key`, pipe frames for the life of the interactive session | The one capability browsers cannot supply themselves and no existing Hub mechanism provides. Makes the host stateful (holds connections). |
| R3 | Application inventory read (`GET /api/applications`) | Hub-native data; the shim reads a real Hub for it today. |
| R4 | Identity → Secret materialization: the application's platform credential becomes a mounted Secret before pod start | Stubbed in the shim (`IDENTITY_SECRET_BRIDGE`); only the vault owner can do this for real. |
| R5 | Param/credential resolution at run construction | Requires **zero** domain knowledge in the host — it's driven entirely by the Agent's own param-source annotations (§2 above). This is what keeps the controller use-case-agnostic. |

Two observations that fall out, offered to inform the placement discussion
rather than settle it:

- **R1/R3/R4/R5 fit shapes Hub already has.** Routing entity data into a
  workload at kickoff is exactly what the analysis wizard + addon path does
  today; a launch addon could carry run construction without new Hub
  machinery.
- **R2 fits none of them.** The task system is one-way (addon → Hub) and
  run-to-completion; nothing in it dials *into* a running pod. Wherever R2
  lands is the real decision, and it can be decided separately from the
  launch path.

### Workload surface delta

The three-stage workload flow (assess → remediate → validate, behind #36)
is running end-to-end in batch mode, and needed exactly two additions to
the surface:

| Method | Route | Behavior |
|--------|-------|----------|
| GET | `/api/agentworkloads[/:name]` | list filtered to `konveyor.io/managed=true`, same as agents |
| GET/POST | `/api/agentworkloadruns`; GET/DELETE `/:name` | POST body `{workloadRef, params?, applicationRef?}` — `applicationRef` resolves per §2, values forwarded to every stage |

Worth noting for placement: workload stage runs are batch (pod exits,
stage completes) — they exercise R1/R3–R5 but never R2. Interactive
single-agent runs are today's only R2 consumer. That split is why the
launch path and the interactive channel don't have to land in the same
host.

This also closes open question 3 from the first comment (auth): auth is a
property of whichever host takes R1/R2, not of the surface — folded into
the table above.
