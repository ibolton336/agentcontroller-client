/**
 * ShimClient — RunApi over the hub-shim HTTP API (fetch-based, no node
 * builtins; works in browsers and node >= 18).
 *
 * SHIM HTTP API v1 (the future Konveyor Hub proxy is expected to expose the
 * same shape). Full route table + semantics: docs/adr/0009.
 *   GET    /api/applications         -> Application[] (platform inventory)
 *   GET    /api/agents               -> AgentResource[] (konveyor.io/managed=true)
 *   GET    /api/agentruns            -> AgentRun[]
 *   POST   /api/agentruns            -> 201 AgentRun (applicationRef resolves
 *                                       sourced params/credentials, ADR 0010)
 *   GET    /api/agentruns/:name      -> AgentRun | 404
 *   DELETE /api/agentruns/:name      -> 204
 *   WS     /api/agentruns/:name/acp  -> ACP tunnel to the sandbox pod
 *                                       (the shim injects X-Secret-Key)
 */
import type {
  AgentImage,
  AgentWorkflow,
  AgentWorkflowRun,
  AgentWorkflowSpec,
  AgentResource,
  AgentResourceSpec,
  AgentRun,
  Application,
  CatalogApi,
  CreateWorkflowRunInput,
  CreateRunInput,
  Gateway,
  RunApi,
  SkillCard,
  SkillCardSpec,
  SkillCollection,
  SkillCollectionSpec,
} from "../contract/index.js";

export class ShimClient implements RunApi, CatalogApi {
  /** Normalized base URL, no trailing slash (e.g. http://127.0.0.1:7080). */
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    // Validate eagerly so a bad base fails at construction, not first call.
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`ShimClient: baseUrl must be http(s), got ${parsed.protocol}//`);
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  // ---------------------------------------------------------- RunApi: agents

  listAgents(): Promise<AgentResource[]> {
    return this.json<AgentResource[]>("GET", "/api/agents");
  }

  getAgent(name: string): Promise<AgentResource> {
    return this.json<AgentResource>("GET", `/api/agents/${encodeURIComponent(name)}`);
  }

  // --------------------------------------------------- RunApi: applications

  listApplications(): Promise<Application[]> {
    return this.json<Application[]>("GET", "/api/applications");
  }

  async listApplicationsWithSource(): Promise<{
    source: "hub" | "stub" | "unknown";
    endpoint: string;
    applications: Application[];
  }> {
    const res = await this.send("GET", "/api/applications");
    const applications = (await res.json()) as Application[];
    const header = res.headers.get("X-Inventory-Source");
    const source = header === "hub" || header === "stub" ? header : "unknown";
    return { source, endpoint: res.headers.get("X-Inventory-Endpoint") ?? "", applications };
  }

  // -------------------------------------------------------- RunApi: images

  listImages(): Promise<AgentImage[]> {
    return this.json<AgentImage[]>("GET", "/api/images");
  }

  async listImagesWithSource(): Promise<{
    source: "configmap" | "builtin";
    images: AgentImage[];
  }> {
    const res = await this.send("GET", "/api/images");
    const images = (await res.json()) as AgentImage[];
    const header = res.headers.get("X-Catalog-Source");
    const source = header === "configmap" ? "configmap" : "builtin";
    return { source, images };
  }

  async seedDefaults(): Promise<{
    seeded: number;
    existed: number;
    skipped: number;
    results: unknown[];
  }> {
    return this.json("POST", "/api/defaults");
  }

  // ---------------------------------------------------------- RunApi: runs

  listRuns(): Promise<AgentRun[]> {
    return this.json<AgentRun[]>("GET", "/api/agentruns");
  }

  createRun(input: CreateRunInput): Promise<AgentRun> {
    return this.json<AgentRun>("POST", "/api/agentruns", input);
  }

  getRun(name: string): Promise<AgentRun> {
    return this.json<AgentRun>("GET", `/api/agentruns/${encodeURIComponent(name)}`);
  }

  async deleteRun(name: string): Promise<void> {
    await this.send("DELETE", `/api/agentruns/${encodeURIComponent(name)}`);
  }

  // ----------------------------------------------------- RunApi: workflows

  listWorkflows(): Promise<AgentWorkflow[]> {
    return this.json<AgentWorkflow[]>("GET", "/api/agentworkflows");
  }

  listWorkflowRuns(): Promise<AgentWorkflowRun[]> {
    return this.json<AgentWorkflowRun[]>("GET", "/api/agentworkflowruns");
  }

  getWorkflowRun(name: string): Promise<AgentWorkflowRun> {
    return this.json<AgentWorkflowRun>("GET", `/api/agentworkflowruns/${encodeURIComponent(name)}`);
  }

  createWorkflowRun(input: CreateWorkflowRunInput): Promise<AgentWorkflowRun> {
    return this.json<AgentWorkflowRun>("POST", "/api/agentworkflowruns", input);
  }

  async deleteWorkflowRun(name: string): Promise<void> {
    await this.send("DELETE", `/api/agentworkflowruns/${encodeURIComponent(name)}`);
  }

  // --------------------------------------------------- CatalogApi: gateways

  listGateways(): Promise<Gateway[]> {
    return this.json<Gateway[]>("GET", "/api/gateways");
  }

  getGateway(name: string): Promise<Gateway> {
    return this.json<Gateway>("GET", `/api/gateways/${encodeURIComponent(name)}`);
  }

  // ------------------------------------------------- CatalogApi: skillcards

  listSkillCards(): Promise<SkillCard[]> {
    return this.json<SkillCard[]>("GET", "/api/skillcards");
  }

  getSkillCard(name: string): Promise<SkillCard> {
    return this.json<SkillCard>("GET", `/api/skillcards/${encodeURIComponent(name)}`);
  }

  createSkillCard(name: string, spec: SkillCardSpec): Promise<SkillCard> {
    return this.json<SkillCard>("POST", "/api/skillcards", { name, spec });
  }

  updateSkillCard(name: string, spec: SkillCardSpec): Promise<SkillCard> {
    return this.json<SkillCard>("PUT", `/api/skillcards/${encodeURIComponent(name)}`, { spec });
  }

  async deleteSkillCard(name: string): Promise<void> {
    await this.send("DELETE", `/api/skillcards/${encodeURIComponent(name)}`);
  }

  // -------------------------------------------- CatalogApi: skillcollections

  listSkillCollections(): Promise<SkillCollection[]> {
    return this.json<SkillCollection[]>("GET", "/api/skillcollections");
  }

  getSkillCollection(name: string): Promise<SkillCollection> {
    return this.json<SkillCollection>("GET", `/api/skillcollections/${encodeURIComponent(name)}`);
  }

  createSkillCollection(name: string, spec: SkillCollectionSpec): Promise<SkillCollection> {
    return this.json<SkillCollection>("POST", "/api/skillcollections", { name, spec });
  }

  updateSkillCollection(name: string, spec: SkillCollectionSpec): Promise<SkillCollection> {
    return this.json<SkillCollection>("PUT", `/api/skillcollections/${encodeURIComponent(name)}`, { spec });
  }

  async deleteSkillCollection(name: string): Promise<void> {
    await this.send("DELETE", `/api/skillcollections/${encodeURIComponent(name)}`);
  }

  // -------------------------------------------------- CatalogApi: agents

  createAgent(name: string, spec: AgentResourceSpec): Promise<AgentResource> {
    return this.json<AgentResource>("POST", "/api/agents", { name, spec });
  }

  updateAgent(name: string, spec: AgentResourceSpec): Promise<AgentResource> {
    return this.json<AgentResource>("PUT", `/api/agents/${encodeURIComponent(name)}`, { spec });
  }

  async deleteAgent(name: string): Promise<void> {
    await this.send("DELETE", `/api/agents/${encodeURIComponent(name)}`);
  }

  // ------------------------------------------------ CatalogApi: workflows

  getWorkflow(name: string): Promise<AgentWorkflow> {
    return this.json<AgentWorkflow>("GET", `/api/agentworkflows/${encodeURIComponent(name)}`);
  }

  createWorkflow(name: string, spec: AgentWorkflowSpec): Promise<AgentWorkflow> {
    return this.json<AgentWorkflow>("POST", "/api/agentworkflows", { name, spec });
  }

  updateWorkflow(name: string, spec: AgentWorkflowSpec): Promise<AgentWorkflow> {
    return this.json<AgentWorkflow>("PUT", `/api/agentworkflows/${encodeURIComponent(name)}`, { spec });
  }

  async deleteWorkflow(name: string): Promise<void> {
    await this.send("DELETE", `/api/agentworkflows/${encodeURIComponent(name)}`);
  }

  // --------------------------------------------------------------- ACP URL

  acpUrl(runName: string): string {
    const u = new URL(this.baseUrl);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    const prefix = u.pathname.replace(/\/+$/, "");
    u.pathname = `${prefix}/api/agentruns/${encodeURIComponent(runName)}/acp`;
    u.search = "";
    u.hash = "";
    return u.toString();
  }

  // ------------------------------------------------------------ internals

  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    const url = this.baseUrl + path;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new Error(
        `${method} ${url} failed: ${err instanceof Error ? err.message : String(err)} — is the hub-shim running?`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `${method} ${url} failed: HTTP ${res.status}${text ? ` — ${text.slice(0, 300)}` : ""}`,
      );
    }
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.send(method, path, body);
    return (await res.json()) as T;
  }
}
