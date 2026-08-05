/**
 * E2E smoke for the per-application run filter against a LIVE shim + cluster.
 *
 * Browser-constraint like dev/browser-smoke.ts: only globalThis.fetch, only
 * shim routes — every cluster assertion goes through the shim's own GET
 * endpoints, exactly what a browser UI could verify.
 *
 * Asserts the konveyor.io/application contract (client#3):
 *   1. an application-scoped AgentRun is stamped with the label at create
 *   2. an application-scoped AgentWorkflowRun is too, without losing managed
 *   3. a run created with no applicationRef carries no application label
 *   4. ?application=<id> returns that application's runs and nothing else
 *   5. the filter is server-side — a foreign id returns an empty list while
 *      the unfiltered list still holds the runs
 *   6. a filter the endpoint cannot honour is a 400, never a silent full list
 *
 * Needs a REAL Hub inventory: application-scoped creates are refused against
 * the offline stub, so the smoke skips itself when the shim reports one.
 *
 * Run with the shim already up:  npm run smoke:appfilter   (SHIM_URL overrides)
 * Deletes every run it creates.
 */

const BASE = process.env.SHIM_URL ?? "http://127.0.0.1:7080";
const APPLICATION_LABEL = "konveyor.io/application";

let failures = 0;
function pass(step: string, detail?: string): void {
  console.log(`PASS ${step}${detail ? ` — ${detail}` : ""}`);
}
function fail(step: string, detail: string): never {
  failures++;
  console.error(`FAIL ${step} — ${detail}`);
  throw new SmokeAbort(step);
}
class SmokeAbort extends Error {
  constructor(step: string) {
    super(`aborted at step: ${step}`);
  }
}

interface NamedCR {
  metadata: { name: string; labels?: Record<string, string> };
}
interface ShimApplication {
  id: string;
  name: string;
  repository?: { url?: string; branch?: string };
}

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) as unknown };
  } catch {
    return { status: res.status, body: text };
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await call("GET", path);
  if (res.status !== 200) fail(`GET ${path}`, `HTTP ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as T;
}

const names = (list: NamedCR[]) => list.map((r) => r.metadata.name).sort();
const has = (list: NamedCR[], name: string) => list.some((r) => r.metadata.name === name);

/** Runs created by this smoke, torn down in reverse order. */
const created: Array<{ plural: string; name: string }> = [];

async function createRun(
  plural: string,
  body: Record<string, unknown>,
  step: string,
): Promise<NamedCR> {
  const res = await call("POST", `/api/${plural}`, body);
  if (res.status !== 201) fail(step, `HTTP ${res.status} ${JSON.stringify(res.body)}`);
  const run = res.body as NamedCR;
  created.push({ plural, name: run.metadata.name });
  return run;
}

async function main(): Promise<void> {
  // -- inventory: the filter is only meaningful against real Hub ids
  const inventoryRes = await fetch(`${BASE}/api/applications`);
  if (!inventoryRes.ok) fail("inventory", `GET /api/applications -> HTTP ${inventoryRes.status}`);
  if (inventoryRes.headers.get("X-Inventory-Source") !== "hub") {
    console.log(
      "application-filter-smoke: SKIPPED — shim is serving the offline stub inventory, " +
        "which refuses application-scoped runs. Point HUB_URL at a reachable Hub.",
    );
    return;
  }
  const applications = ((await inventoryRes.json()) as ShimApplication[]).filter((a) =>
    /^\d+$/.test(a.id),
  );
  if (applications.length < 2) {
    fail("inventory", `need two numeric-id applications to prove isolation, got ${applications.length}`);
  }
  const [appA, appB] = applications;
  pass("inventory", `filtering between application ${appA.id} and ${appB.id}`);

  // A managed agent is the one a real per-application view drives.
  const agents = await get<NamedCR[]>("/api/agents");
  if (agents.length === 0) fail("agent fixture", "no managed agents — POST /api/defaults first");
  const agentRef = agents[0].metadata.name;

  try {
    // -- 1. the single-run create stamps the label
    const runA = await createRun(
      "agentruns",
      { agentRef, applicationRef: appA.id },
      "create AgentRun",
    );
    if (runA.metadata.labels?.[APPLICATION_LABEL] !== appA.id) {
      fail("AgentRun label", `expected ${appA.id}, got ${runA.metadata.labels?.[APPLICATION_LABEL]}`);
    }
    pass("AgentRun label", `${runA.metadata.name} -> ${APPLICATION_LABEL}=${appA.id}`);

    const runB = await createRun(
      "agentruns",
      { agentRef, applicationRef: appB.id },
      "create AgentRun (second application)",
    );

    // -- 2/3. the workflow-run create stamps it too, and only when scoped
    const workflows = await get<NamedCR[]>("/api/agentworkflows");
    let workflowRunA: NamedCR | undefined;
    if (workflows.length === 0) {
      pass("AgentWorkflowRun label", "skipped — no managed workflows on this cluster");
    } else {
      const workflowRef = workflows[0].metadata.name;
      workflowRunA = await createRun(
        "agentworkflowruns",
        { workflowRef, applicationRef: appA.id },
        "create AgentWorkflowRun",
      );
      const labels = workflowRunA.metadata.labels ?? {};
      if (labels[APPLICATION_LABEL] !== appA.id) {
        fail("AgentWorkflowRun label", `expected ${appA.id}, got ${labels[APPLICATION_LABEL]}`);
      }
      if (labels["konveyor.io/managed"] !== "true") {
        fail("AgentWorkflowRun label", "application label displaced the managed label");
      }
      pass("AgentWorkflowRun label", `${workflowRunA.metadata.name} keeps managed + application`);

      const unscoped = await createRun(
        "agentworkflowruns",
        { workflowRef },
        "create unscoped AgentWorkflowRun",
      );
      if (unscoped.metadata.labels?.[APPLICATION_LABEL] !== undefined) {
        fail("unscoped run", `expected no application label, got ${unscoped.metadata.labels?.[APPLICATION_LABEL]}`);
      }
      pass("unscoped run", "no applicationRef -> no application label");
    }

    // -- 4/5. the filter isolates, and the unfiltered list is unaffected
    const filteredA = await get<NamedCR[]>(`/api/agentruns?application=${appA.id}`);
    if (!has(filteredA, runA.metadata.name) || has(filteredA, runB.metadata.name)) {
      fail(
        `?application=${appA.id}`,
        `expected ${runA.metadata.name} without ${runB.metadata.name}, got ${names(filteredA).join(", ")}`,
      );
    }
    pass(`?application=${appA.id}`, `${filteredA.length} run(s), ${runB.metadata.name} excluded`);

    const filteredB = await get<NamedCR[]>(`/api/agentruns?application=${appB.id}`);
    if (!has(filteredB, runB.metadata.name) || has(filteredB, runA.metadata.name)) {
      fail(`?application=${appB.id}`, `leaked across applications: ${names(filteredB).join(", ")}`);
    }
    pass(`?application=${appB.id}`, `${filteredB.length} run(s), ${runA.metadata.name} excluded`);

    // An id no run carries proves the apiserver is doing the selecting.
    const foreign = await get<NamedCR[]>("/api/agentruns?application=999999");
    if (foreign.length !== 0) {
      fail("unmatched application", `expected [], got ${names(foreign).join(", ")}`);
    }
    pass("unmatched application", "empty list, not a silent full list");

    const unfiltered = await get<NamedCR[]>("/api/agentruns");
    if (!has(unfiltered, runA.metadata.name) || !has(unfiltered, runB.metadata.name)) {
      fail("unfiltered list", "filtering removed runs from the unfiltered list");
    }
    pass("unfiltered list", `${unfiltered.length} run(s) with both applications present`);

    if (workflowRunA) {
      const wfrA = await get<NamedCR[]>(`/api/agentworkflowruns?application=${appA.id}`);
      if (!has(wfrA, workflowRunA.metadata.name)) {
        fail(`agentworkflowruns?application=${appA.id}`, `missing ${workflowRunA.metadata.name}`);
      }
      const wfrB = await get<NamedCR[]>(`/api/agentworkflowruns?application=${appB.id}`);
      if (has(wfrB, workflowRunA.metadata.name)) {
        fail(`agentworkflowruns?application=${appB.id}`, "leaked across applications");
      }
      pass("agentworkflowruns filter", `isolated ${appA.id} from ${appB.id}`);
    }

    // -- 6. an unhonourable filter is loud
    const rejects: Array<[string, string]> = [
      ["non-run resource", "/api/agents?application=" + appA.id],
      ["empty value", "/api/agentruns?application="],
      ["non-numeric id", "/api/agentruns?application=not-a-number"],
      // Digits alone must not pass: 21 nines overflows the harness's
      // uint64 APP_ID parse, so the filter rejects what the harness would.
      ["uint64 overflow", "/api/agentruns?application=999999999999999999999"],
    ];
    for (const [label, path] of rejects) {
      const res = await call("GET", path);
      if (res.status !== 400) {
        fail(`400 on ${label}`, `expected 400, got HTTP ${res.status} for ${path}`);
      }
      pass(`400 on ${label}`, String((res.body as { error?: string })?.error ?? res.status));
    }
  } finally {
    for (const { plural, name } of created.reverse()) {
      const res = await call("DELETE", `/api/${plural}/${name}`);
      if (res.status !== 204) console.error(`WARN leaked ${plural}/${name} (HTTP ${res.status})`);
    }
    if (created.length > 0) pass("cleanup", `deleted ${created.length} run(s)`);
  }
}

main()
  .then(() => {
    if (failures === 0) console.log("application-filter-smoke: all checks passed");
  })
  .catch((err) => {
    if (!(err instanceof SmokeAbort)) console.error(`FAIL unexpected — ${err}`);
    process.exitCode = 1;
  });
