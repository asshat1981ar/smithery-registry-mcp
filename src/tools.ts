import { RegistryClient, RegistryEntry, RegistryError, RegistryPackage, officialMeta } from "./registry.js";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; openWorldHint: boolean; idempotentHint?: boolean };
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const RO = { readOnlyHint: true, openWorldHint: true, idempotentHint: true };
const DEPRECATED =
  "Deprecated alias kept so v1 clients keep working: Smithery's registry API shut down on 2026-10-31, so this now reads the official MCP Registry.";

export const TOOLS: ToolDef[] = [
  {
    name: "registry_search_servers",
    title: "Search MCP servers",
    description:
      "Search the official MCP Registry for servers by name or keyword. Returns the latest version of each match with its remote endpoints and installable packages. Page with the returned nextCursor.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to match in server names, e.g. 'github' or 'postgres'. Leave empty to browse." },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
        cursor: { type: "string", description: "nextCursor from a previous call." },
        updated_since: { type: "string", description: "RFC 3339 timestamp; only servers updated after it." },
        include_deprecated: { type: "boolean", default: false, description: "Include servers the registry marks deprecated." },
      },
      additionalProperties: false,
    },
    annotations: RO,
  },
  {
    name: "registry_get_server",
    title: "Get an MCP server",
    description:
      "Get one server from the official MCP Registry by its reverse-DNS name (for example 'io.github.github/github-mcp-server'), at its latest version or a version you name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Registry name, e.g. 'app.linear/linear'." },
        version: { type: "string", default: "latest" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: RO,
  },
  {
    name: "registry_list_versions",
    title: "List versions of an MCP server",
    description: "List every published version of one server in the official MCP Registry, newest first, with status and dates.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Registry name." } },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: RO,
  },
  {
    name: "registry_install_config",
    title: "Build an install config",
    description:
      "Build ready-to-paste client config for one registry server: an mcpServers JSON entry (Claude Code, Claude Desktop, Cursor) and a 'claude mcp add' command. Secrets appear as placeholders, never values.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Registry name." },
        version: { type: "string", default: "latest" },
        prefer: { type: "string", enum: ["remote", "package"], default: "remote", description: "Use the hosted endpoint or a local package when both exist." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  },
  // ---- v1 aliases -----------------------------------------------------------
  {
    name: "smithery_search_servers",
    title: "Search MCP servers (v1 alias)",
    description: `${DEPRECATED} Same as registry_search_servers.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        pageSize: { type: "integer", minimum: 1, maximum: 100, default: 10 },
        cursor: { type: "string" },
      },
      additionalProperties: true,
    },
    annotations: RO,
  },
  {
    name: "smithery_get_server",
    title: "Get an MCP server (v1 alias)",
    description: `${DEPRECATED} Takes a registry name, or an old Smithery qualified name, which is matched by search.`,
    inputSchema: {
      type: "object",
      properties: { qualifiedName: { type: "string" } },
      required: ["qualifiedName"],
      additionalProperties: true,
    },
    annotations: RO,
  },
  {
    name: "smithery_create_connection_url",
    title: "Install config (v1 alias)",
    description: `${DEPRECATED} Smithery Connect URLs no longer exist, so this returns the same install config as registry_install_config.`,
    inputSchema: {
      type: "object",
      properties: { qualifiedName: { type: "string" } },
      required: ["qualifiedName"],
      additionalProperties: true,
    },
    annotations: RO,
  },
  {
    name: "smithery_health_check",
    title: "Health check",
    description: "Check that this server can reach the official MCP Registry. Kept under its v1 name.",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    annotations: RO,
  },
];

// ---------------------------------------------------------------------------

function summarize(e: RegistryEntry) {
  const s = e.server;
  const m = officialMeta(e);
  return {
    name: s.name,
    title: s.title ?? null,
    description: s.description ?? null,
    version: s.version,
    status: m.status ?? null,
    updatedAt: m.updatedAt ?? null,
    websiteUrl: s.websiteUrl ?? null,
    repository: s.repository?.url ?? null,
    remotes: (s.remotes ?? []).map((r) => ({ type: r.type, url: r.url, headers: (r.headers ?? []).map((h) => h.name) })),
    packages: (s.packages ?? []).map((p) => ({
      registryType: p.registryType,
      identifier: p.identifier,
      version: p.version ?? null,
      transport: p.transport?.type ?? null,
      secrets: (p.environmentVariables ?? []).filter((v) => v.isSecret).map((v) => v.name),
    })),
  };
}

const ok = (data: Record<string, unknown>, text?: string): ToolResult => ({
  content: [{ type: "text", text: text ?? JSON.stringify(data, null, 2) }],
  structuredContent: data,
});
const fail = (msg: string): ToolResult => ({ content: [{ type: "text", text: msg }], isError: true });

function argString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function placeholder(name: string): string {
  return `<${name}>`;
}

function argList(raw: unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const a of raw ?? []) {
    if (!a || typeof a !== "object") continue;
    const o = a as { type?: string; name?: string; value?: string; valueHint?: string; default?: string };
    const val = o.value ?? o.default ?? (o.valueHint ? placeholder(o.valueHint) : undefined);
    if (o.type === "named" && o.name) {
      out.push(o.name);
      if (val !== undefined) out.push(val);
    } else if (val !== undefined) out.push(val);
  }
  return out;
}

export function packageConfig(p: RegistryPackage): Record<string, unknown> | null {
  const env: Record<string, string> = {};
  for (const v of p.environmentVariables ?? []) env[v.name] = v.isSecret || v.default === undefined ? placeholder(v.name) : v.default;
  const pinned = (sep: string) => (p.version ? `${p.identifier}${sep}${p.version}` : p.identifier);
  const pkgArgs = argList(p.packageArguments);
  const rtArgs = argList(p.runtimeArguments);
  const withEnv = (c: Record<string, unknown>) => (Object.keys(env).length ? { ...c, env } : c);
  switch (p.registryType) {
    case "npm":
      return withEnv({ command: "npx", args: ["-y", ...rtArgs, pinned("@"), ...pkgArgs] });
    case "pypi":
      return withEnv({ command: "uvx", args: [...rtArgs, pinned("=="), ...pkgArgs] });
    case "nuget":
      return withEnv({ command: "dnx", args: [...rtArgs, pinned("@"), "--yes", ...pkgArgs] });
    case "oci": {
      const envFlags = Object.keys(env).flatMap((k) => ["-e", k]);
      const image = p.version && !p.identifier.includes(":") ? `${p.identifier}:${p.version}` : p.identifier;
      return withEnv({ command: "docker", args: ["run", "-i", "--rm", ...rtArgs, ...envFlags, image, ...pkgArgs] });
    }
    default:
      return null; // mcpb, cargo and others need a manual download or build
  }
}

export function installConfig(e: RegistryEntry, prefer: "remote" | "package" = "remote") {
  const s = e.server;
  const key = (s.name.split("/").pop() || s.name).replace(/[^A-Za-z0-9_-]/g, "-");
  const remote = (s.remotes ?? []).find((r) => !/\{[^}]+\}/.test(r.url)) ?? (s.remotes ?? [])[0];
  const pkg = (s.packages ?? []).find((p) => packageConfig(p) !== null);
  const notes: string[] = [];
  let entry: Record<string, unknown> | null = null;
  let cli: string | null = null;
  const useRemote = remote && (prefer === "remote" || !pkg);
  if (useRemote && remote) {
    const headers: Record<string, string> = {};
    for (const h of remote.headers ?? []) headers[h.name] = placeholder(h.name);
    const type = remote.type === "sse" ? "sse" : "http";
    entry = { type, url: remote.url, ...(Object.keys(headers).length ? { headers } : {}) };
    cli = `claude mcp add --transport ${type} ${key} ${remote.url}` + Object.keys(headers).map((h) => ` --header "${h}: ${placeholder(h)}"`).join("");
    if (/\{[^}]+\}/.test(remote.url)) notes.push("The URL has {placeholders} to fill in, such as a region or workspace id.");
    if (!remote.headers?.length) notes.push("If the server needs sign-in, the client opens its OAuth page on first connect.");
  } else if (pkg) {
    entry = packageConfig(pkg);
    const c = entry as { command: string; args: string[]; env?: Record<string, string> };
    cli = `claude mcp add ${key}` + Object.keys(c.env ?? {}).map((k) => ` -e ${k}=${placeholder(k)}`).join("") + ` -- ${c.command} ${c.args.join(" ")}`;
  } else {
    notes.push("No remote endpoint or runnable package (npm, PyPI, NuGet, OCI) is listed; see the repository for setup.");
  }
  return {
    name: s.name,
    version: s.version,
    using: useRemote ? "remote" : pkg ? `package:${pkg.registryType}` : "none",
    mcpServers: entry ? { [key]: entry } : null,
    claudeCodeCommand: cli,
    notes,
    repository: s.repository?.url ?? null,
  };
}

// ---------------------------------------------------------------------------

export async function callTool(client: RegistryClient, name: string, rawArgs: unknown): Promise<ToolResult> {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "registry_search_servers":
      case "smithery_search_servers": {
        const limit = Number(args.limit ?? args.pageSize ?? 10);
        const res = await client.search({
          query: argString(args, "query"),
          limit,
          cursor: argString(args, "cursor"),
          updatedSince: argString(args, "updated_since"),
        });
        const includeDeprecated = args.include_deprecated === true;
        const servers = res.servers
          .filter((e) => includeDeprecated || (officialMeta(e).status ?? "active") === "active")
          .map(summarize);
        return ok({ servers, nextCursor: res.metadata?.nextCursor ?? null, count: servers.length });
      }
      case "registry_get_server": {
        const n = argString(args, "name");
        if (!n) return fail("name is required, e.g. 'app.linear/linear'.");
        return ok(summarize(await client.getServer(n, argString(args, "version") ?? "latest")));
      }
      case "registry_list_versions": {
        const n = argString(args, "name");
        if (!n) return fail("name is required.");
        const res = await client.listVersions(n);
        const versions = res.servers
          .map((e) => ({ version: e.server.version, ...officialMeta(e) }))
          .sort((a, b) => String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? "")));
        return ok({ name: n, versions });
      }
      case "registry_install_config": {
        const n = argString(args, "name");
        if (!n) return fail("name is required.");
        const prefer = args.prefer === "package" ? "package" : "remote";
        return ok(installConfig(await client.getServer(n, argString(args, "version") ?? "latest"), prefer));
      }
      case "smithery_get_server":
      case "smithery_create_connection_url": {
        const q = argString(args, "qualifiedName");
        if (!q) return fail("qualifiedName is required.");
        const entry = await resolveLegacyName(client, q);
        if (!entry) return fail(`No server matching '${q}' in the official MCP Registry. Try registry_search_servers.`);
        const data = name === "smithery_get_server" ? summarize(entry) : installConfig(entry);
        return ok({ ...data, deprecated: DEPRECATED, resolvedFrom: q });
      }
      case "smithery_health_check": {
        const t0 = Date.now();
        await client.search({ limit: 1 });
        return ok({ ok: true, registry: "official MCP Registry", latencyMs: Date.now() - t0 });
      }
      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof RegistryError) return fail(err.message + (err.status === 404 ? ". Check the name with registry_search_servers." : "."));
    return fail(`Request to the MCP Registry failed: ${(err as Error).message}`);
  }
}

/** v1 used Smithery qualified names like "@owner/repo" or "owner/repo". Try them as registry names, then by search. */
export async function resolveLegacyName(client: RegistryClient, q: string): Promise<RegistryEntry | null> {
  const bare = q.replace(/^@/, "");
  const candidates = [q, bare, `io.github.${bare}`];
  for (const c of candidates) {
    if (!c.includes("/")) continue;
    try {
      return await client.getServer(c);
    } catch (e) {
      if (!(e instanceof RegistryError && e.status === 404)) throw e;
    }
  }
  const term = bare.split("/").pop() || bare;
  const res = await client.search({ query: term, limit: 20 });
  const active = res.servers.filter((e) => (officialMeta(e).status ?? "active") === "active");
  const lc = bare.toLowerCase();
  return (
    active.find((e) => e.server.name.toLowerCase().endsWith(lc)) ??
    active.find((e) => e.server.name.toLowerCase().includes(term.toLowerCase())) ??
    active[0] ??
    null
  );
}
