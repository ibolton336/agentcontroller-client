/**
 * ShimClient — RunApi over the hub-shim HTTP API (fetch-based, no node
 * builtins; works in browsers and node >= 18).
 *
 * SHIM HTTP API v1 (the future Konveyor Hub proxy is expected to expose the
 * same shape):
 *   GET    /api/agents               -> AgentResource[]
 *   GET    /api/agentruns            -> AgentRun[]
 *   POST   /api/agentruns            -> 201 AgentRun
 *   GET    /api/agentruns/:name      -> AgentRun | 404
 *   DELETE /api/agentruns/:name      -> 204
 *   WS     /api/agentruns/:name/acp  -> ACP tunnel to the sandbox pod
 *                                       (the shim injects X-Secret-Key)
 */
import type { AgentResource, AgentRun, CreateRunInput, RunApi } from "../contract/index.js";

export class ShimClient implements RunApi {
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

  listAgents(): Promise<AgentResource[]> {
    return this.json<AgentResource[]>("GET", "/api/agents");
  }

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

  /**
   * ws(s):// URL of the shim's ACP tunnel for a run, derived from baseUrl
   * (http -> ws, https -> wss; any base path prefix is preserved). Pass to
   * AcpSession.connect — no secretKey needed, the shim injects it upstream.
   */
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
