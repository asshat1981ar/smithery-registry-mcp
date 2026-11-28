// Client for the official MCP Registry API (v0).
// Docs: https://registry.modelcontextprotocol.io/docs

export const DEFAULT_REGISTRY = "https://registry.modelcontextprotocol.io";

export interface RegistryRemote {
  type: string; // "streamable-http" | "sse"
  url: string;
  headers?: { name: string; description?: string; isRequired?: boolean; isSecret?: boolean }[];
}

export interface RegistryEnvVar {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
}

export interface RegistryPackage {
  registryType: string; // npm | pypi | oci | nuget | mcpb | cargo
  identifier: string;
  version?: string;
  registryBaseUrl?: string;
  runtimeHint?: string;
  transport?: { type: string; url?: string };
  environmentVariables?: RegistryEnvVar[];
  packageArguments?: unknown[];
  runtimeArguments?: unknown[];
}

export interface RegistryServer {
  name: string;
  title?: string;
  description?: string;
  version: string;
  websiteUrl?: string;
  repository?: { url?: string; source?: string; subfolder?: string };
  remotes?: RegistryRemote[];
  packages?: RegistryPackage[];
}

export interface OfficialMeta {
  status?: string; // active | deprecated | deleted
  publishedAt?: string;
  updatedAt?: string;
  isLatest?: boolean;
}

export interface RegistryEntry {
  server: RegistryServer;
  _meta?: { "io.modelcontextprotocol.registry/official"?: OfficialMeta; [k: string]: unknown };
}

export interface ListResponse {
  servers: RegistryEntry[];
  metadata?: { nextCursor?: string; count?: number };
}

export class RegistryError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "RegistryError";
  }
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class RegistryClient {
  private readonly base: string;
  constructor(base: string = DEFAULT_REGISTRY, private readonly fetchImpl: Fetch = (u, i) => fetch(u, i)) {
    this.base = base.replace(/\/+$/, "");
  }

  private async get<T>(path: string, signal?: AbortSignal, maxBytes?: number): Promise<T> {
    const res = await this.fetchImpl(this.base + path, {
      headers: { accept: "application/json", "user-agent": "smithery-registry-mcp/2.0" },
      signal,
    });
    if (res.status === 404) throw new RegistryError("Not found in the MCP Registry", 404);
    if (!res.ok) throw new RegistryError(`MCP Registry returned HTTP ${res.status}`, res.status);
    if (!maxBytes) return (await res.json()) as T;
    const reader = res.body?.getReader();
    if (!reader) throw new RegistryError("Registry returned an empty body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new RegistryError("Registry page exceeds response byte limit");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }

  /** Search latest versions. `query` matches server names; empty lists everything. */
  async search(opts: { query?: string; limit?: number; cursor?: string; updatedSince?: string; signal?: AbortSignal; maxResponseBytes?: number } = {}): Promise<ListResponse> {
    const p = new URLSearchParams({ version: "latest" });
    if (opts.query) p.set("search", opts.query);
    p.set("limit", String(clamp(opts.limit ?? 10, 1, 100)));
    if (opts.cursor) p.set("cursor", opts.cursor);
    if (opts.updatedSince) p.set("updated_since", opts.updatedSince);
    return this.get<ListResponse>(`/v0/servers?${p}`, opts.signal, opts.maxResponseBytes);
  }

  /** One server by its reverse-DNS name, e.g. "io.github.github/github-mcp-server". */
  async getServer(name: string, version = "latest"): Promise<RegistryEntry> {
    return this.get<RegistryEntry>(`/v0/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`);
  }

  async listVersions(name: string): Promise<ListResponse> {
    return this.get<ListResponse>(`/v0/servers/${encodeURIComponent(name)}/versions`);
  }
}

export function officialMeta(e: RegistryEntry): OfficialMeta {
  return e._meta?.["io.modelcontextprotocol.registry/official"] ?? {};
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(Number.isFinite(n) ? n : lo)));
}
