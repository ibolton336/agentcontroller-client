/**
 * E2E smoke for POST /api/defaults against a LIVE shim + cluster.
 *
 * Browser-constraint like dev/browser-smoke.ts: only globalThis.fetch,
 * only shim routes — every cluster assertion goes through the shim's own
 * GET endpoints, exactly what a browser UI could verify.
 *
 * Asserts the seed-plan contract:
 *   1. dryRun=true is pure computation — statuses come back, nothing is written
 *   2. the real seed binds agents to the cluster's actual Gateway and to
 *      catalog-resolved images (never the retired gcp-vertex-ai / inline set),
 *      and no seeded agent declares a required param without a default —
 *      bulk/workflow launches send no params at all (application data
 *      resolves from the Hub at runtime, enhancement #295 / ADR 0006), and
 *      the controller's validateParams fails a run missing a
 *      required-no-default param at create time (InvalidParams)
 *   3. sets the cluster can't supply surface as "skipped" with a reason
 *   4. re-seeding is idempotent (create-only: everything reports "exists")
 *   5. a seeded agent reaches Ready=True on the live controller
 *
 * Run with the shim already up:  npm run smoke:defaults   (SHIM_URL overrides)
 * Create-only endpoint — the smoke leaves seeded resources in place, which is
 * the same end state the UI's "Load defaults" button produces.
 */

const BASE = process.env.SHIM_URL ?? "http://127.0.0.1:7080";
const READY_TIMEOUT_MS = Number(process.env.READY_TIMEOUT_MS ?? 90_000);

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SeedEntry {
  kind: string;
  name: string;
  status: "created" | "exists" | "skipped";
  reason?: string;
}
interface SeedResponse {
  seeded: number;
  existed: number;
  skipped: number;
  dryRun: boolean;
  gateway: { name: string; source: "env" | "discovered"; ready: boolean } | null;
  results: SeedEntry[];
}
interface NamedCR {
  metadata?: { name?: string };
  spec?: Record<string, unknown>;
  status?: { conditions?: { type?: string; status?: string; reason?: string }[] };
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}
async function getStatus(path: string): Promise<number> {
  return (await fetch(`${BASE}${path}`)).status;
}
async function post<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: "POST" });
  if (!res.ok) throw new Error(`POST ${path} -> HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

const names = (list: NamedCR[]) =>
  list
    .map((r) => r.metadata?.name ?? "")
    .filter(Boolean)
    .sort()
    .join(",");

/** Resources the old broken seed set created; none may ever appear again. */
const RETIRED = new Set(["gcp-vertex-ai", "plan-phase", "execute-phase", "verify-phase"]);

async function main(): Promise<void> {
  // -- 0. shim up, cluster reachable
  const health = await fetch(`${BASE}/healthz`);
  if (!health.ok) fail("healthz", `HTTP ${health.status}`);
  pass("healthz");

  const gateways = await get<NamedCR[]>("/api/gateways");
  pass("gateways listed", `${gateways.length} in namespace`);
  const expectSkipAll = gateways.length === 0;

  const images = await get<{ name: string; image: string }[]>("/api/images");
  const catalogImage = (name: string) => images.find((i) => i.name === name)?.image;
  pass("image catalog", images.map((i) => i.name).join(","));

  const before = {
    agents: names(await get<NamedCR[]>("/api/agents")),
    skills: names(await get<NamedCR[]>("/api/skillcards")),
    workflows: names(await get<NamedCR[]>("/api/agentworkflows")),
  };

  // -- 1. dry run: full plan, zero writes
  const dry = await post<SeedResponse>("/api/defaults?dryRun=true");
  if (!dry.dryRun) fail("dryRun flag", `expected dryRun=true, got ${JSON.stringify(dry.dryRun)}`);
  if (dry.seeded + dry.existed + dry.skipped !== dry.results.length) {
    fail("dryRun counts", `seeded+existed+skipped != results.length in ${JSON.stringify(dry)}`);
  }
  if (expectSkipAll) {
    if (dry.gateway !== null) fail("dryRun gateway", "expected null with no gateways");
  } else if (!dry.gateway?.name) {
    fail("dryRun gateway", `no gateway resolved despite ${gateways.length} existing`);
  }
  for (const r of dry.results) {
    if (r.kind === "LLMProvider" || r.kind === "Gateway" || RETIRED.has(r.name)) {
      fail("retired resources", `${r.kind}/${r.name} is back in the plan`);
    }
    if (r.status === "skipped" && !r.reason) fail("skip reason", `${r.kind}/${r.name} has none`);
  }
  pass(
    "dryRun plan",
    `gateway=${dry.gateway?.name ?? "none"}(${dry.gateway?.source ?? "-"}) ` +
      `create=${dry.seeded} exist=${dry.existed} skip=${dry.skipped}`,
  );

  const after = {
    agents: names(await get<NamedCR[]>("/api/agents")),
    skills: names(await get<NamedCR[]>("/api/skillcards")),
    workflows: names(await get<NamedCR[]>("/api/agentworkflows")),
  };
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    fail("dryRun purity", `cluster changed: ${JSON.stringify({ before, after })}`);
  }
  const wouldCreate = dry.results.find((r) => r.status === "created" && r.kind !== "ConfigMap");
  if (wouldCreate) {
    const plural = wouldCreate.kind === "Agent" ? "agents" : wouldCreate.kind === "SkillCard" ? "skillcards" : "agentworkflows";
    const code = await getStatus(`/api/${plural}/${wouldCreate.name}`);
    if (code !== 404) {
      fail("dryRun purity", `${wouldCreate.kind}/${wouldCreate.name} exists after dry run (HTTP ${code})`);
    }
  }
  pass("dryRun purity", "no resource was written");

  // -- 2. real seed matches the dry-run plan
  const seed = await post<SeedResponse>("/api/defaults");
  if (seed.dryRun) fail("seed flag", "dryRun=true on a real seed");
  const planOf = (r: SeedResponse) =>
    r.results.map((e) => `${e.kind}/${e.name}:${e.status}`).sort().join("\n");
  if (planOf(seed) !== planOf(dry)) {
    fail("plan stability", `dry run and real seed disagree:\n${planOf(dry)}\n--\n${planOf(seed)}`);
  }
  pass("seed applied", `created=${seed.seeded} existed=${seed.existed} skipped=${seed.skipped}`);

  // -- 3. seeded agents bind to the real gateway + catalog image
  const seededSets: { agent: string; catalogKey: string; workflow: string; members: string[] }[] = [];
  for (const set of [
    {
      agent: "java-migration-analyzer",
      catalogKey: "agent-java",
      workflow: "javaee-to-quarkus",
      members: ["java-migration-analyzer", "java-migration-remediator", "java-migration-validator"],
    },
    {
      agent: "pf-migration-analyzer",
      catalogKey: "agent-nodejs",
      workflow: "patternfly-migration",
      members: ["pf-migration-analyzer", "pf-migration-remediator", "pf-migration-validator"],
    },
  ]) {
    const entry = seed.results.find((r) => r.kind === "Agent" && r.name === set.agent);
    if (!entry) fail("plan coverage", `no entry for Agent/${set.agent}`);
    if (entry.status === "skipped") {
      pass(`set ${set.catalogKey} skipped`, entry.reason ?? "");
      continue;
    }
    seededSets.push(set);
    const agent = await get<NamedCR>(`/api/agents/${set.agent}`);
    const gwRef = (agent.spec?.gateways as { ref?: string }[] | undefined)?.[0]?.ref;
    if (gwRef !== seed.gateway?.name) {
      fail("agent gateway", `${set.agent} references "${gwRef}", expected "${seed.gateway?.name}"`);
    }
    const expectImage = catalogImage(set.catalogKey);
    if (agent.spec?.image !== expectImage) {
      fail("agent image", `${set.agent} runs "${agent.spec?.image}", catalog says "${expectImage}"`);
    }
    const wfStatus = await getStatus(`/api/agentworkflows/${set.workflow}`);
    if (wfStatus !== 200) fail("workflow", `${set.workflow} -> HTTP ${wfStatus}`);
    // Bulk/workflow launches create stage runs with NO params — application
    // data resolves from the Hub at runtime (enhancement #295 / ADR 0006).
    // The controller's validateParams mirrors exactly this predicate: a
    // param that is required AND has no default fails those runs at create
    // time with InvalidParams. (required-with-default is create-safe.)
    for (const member of set.members) {
      const stageAgent = member === set.agent ? agent : await get<NamedCR>(`/api/agents/${member}`);
      const params = (stageAgent.spec?.params ?? []) as { name?: string; required?: boolean; default?: string }[];
      const req = params.filter((p) => p.required === true && !p.default);
      if (req.length > 0) {
        fail(
          "paramless launch",
          `${member} declares required param(s) without defaults ${req.map((p) => `"${p.name}"`).join(", ")} — ` +
            `a paramless bulk/stage run fails InvalidParams at create time`,
        );
      }
    }
    pass(`set ${set.catalogKey} seeded`, `gateway=${gwRef} image=${expectImage} requiredNoDefault=0`);
  }
  if (expectSkipAll && seededSets.length > 0) {
    fail("skip-all", "agents were seeded with no gateway on the cluster");
  }

  // -- 4. idempotent re-seed
  const again = await post<SeedResponse>("/api/defaults");
  if (again.seeded !== 0) fail("idempotency", `${again.seeded} resources re-created`);
  if (again.skipped !== seed.skipped) {
    fail("idempotency", `skip set changed: ${seed.skipped} -> ${again.skipped}`);
  }
  pass("idempotent re-seed", `existed=${again.existed} skipped=${again.skipped}`);

  // -- 5. a seeded agent goes Ready on the live controller
  if (seededSets.length === 0) {
    pass("ready gate", "skipped — no agent set seedable on this cluster");
  } else {
    const target = seededSets[0].agent;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const agent = await get<NamedCR>(`/api/agents/${target}`);
      const ready = agent.status?.conditions?.find((c) => c.type === "Ready");
      if (ready?.status === "True") {
        pass("ready gate", `${target} Ready=True`);
        break;
      }
      if (Date.now() > deadline) {
        fail(
          "ready gate",
          `${target} not Ready after ${READY_TIMEOUT_MS}ms ` +
            `(reason=${ready?.reason ?? "no Ready condition"})`,
        );
      }
      await sleep(2_000);
    }
  }
}

main()
  .then(() => {
    console.log("defaults-smoke: all checks passed");
  })
  .catch((err) => {
    if (!(err instanceof SmokeAbort)) console.error(`FAIL unexpected — ${err}`);
    process.exitCode = 1;
  });
