import { RegistryClient, officialMeta } from "./registry.js";
import type { ToolDef, ToolResult } from "./tools.js";

export const SNAPSHOT_TOOL: ToolDef = {
  name: "registry_snapshot",
  title: "Snapshot the MCP Registry",
  description: "Read latest registry entries across up to max_pages pages (100 entries/page). Requires the Tasks extension on this stdio request. Returns a task immediately; poll tasks/get. Results report partial coverage and capped name lists. Does not install or execute servers. Publication dates describe the latest version, not when a server first appeared.",
  inputSchema: {
    type: "object", additionalProperties: false,
    properties: {
      updated_since: { type: "string", format: "date-time", maxLength: 40 },
      max_pages: { type: "integer", minimum: 1, maximum: 1000, default: 1000 },
    },
  },
  outputSchema: {
    type: "object", additionalProperties: false,
    required: ["counts", "names", "namesTruncated", "pages", "partial", "nextCursor", "updatedSince"],
    properties: {
      counts: { type: "object", additionalProperties: false,
        required: ["total", "active", "deprecated", "deleted", "unknown", "published_since", "updated_since"],
        properties: Object.fromEntries(["total", "active", "deprecated", "deleted", "unknown", "published_since", "updated_since"].map(key => [key, { type: "integer", minimum: 0, maximum: 100000 }])) },
      names: { type: "object", additionalProperties: false, required: ["published_since", "updated_since", "deprecated"],
        properties: Object.fromEntries(["published_since", "updated_since", "deprecated"].map(key => [key, { type: "array", maxItems: 1000, items: { type: "string", maxLength: 512 } }])) },
      namesTruncated: { type: "boolean" }, pages: { type: "integer", minimum: 1, maximum: 1000 },
      partial: { type: "boolean" }, nextCursor: { type: ["string", "null"], maxLength: 4096 }, updatedSince: { type: ["string", "null"] },
    },
  },
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },
};
export interface SnapshotArgs { updated_since?: string; max_pages: number }
export function parseSnapshotArgs(raw: unknown): SnapshotArgs {
  if (raw === undefined) return { max_pages: 1000 };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("arguments must be an object");
  const args = raw as Record<string, unknown>;
  if (Object.keys(args).some(k => !["updated_since", "max_pages"].includes(k))) throw new Error("Unknown snapshot argument");
  const pages = args.max_pages ?? 1000;
  if (typeof pages !== "number" || !Number.isInteger(pages) || pages < 1 || pages > 1000) throw new Error("max_pages must be an integer from 1 to 1000");
  const since = args.updated_since;
  if (since !== undefined && (typeof since !== "string" || since.length > 40 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(since) || !Number.isFinite(Date.parse(since)) || new Date(Date.parse(since.slice(0, 10) + "T00:00:00Z")).toISOString().slice(0, 10) !== since.slice(0, 10))) throw new Error("updated_since must be an RFC 3339 timestamp");
  return { max_pages: pages, ...(since === undefined ? {} : { updated_since: since as string }) };
}

/** Bounded, sequential crawl: no installs, retries, or model calls. */
export async function crawlSnapshot(client: RegistryClient, args: SnapshotArgs, signal: AbortSignal, progress: (message: string) => void): Promise<ToolResult> {
  let cursor: string | undefined;
  let pages = 0;
  const seenCursors = new Set<string>();
  const seenNames = new Set<string>();
  const counts = { total: 0, active: 0, deprecated: 0, deleted: 0, unknown: 0, published_since: 0, updated_since: 0 };
  const names: Record<string, string[]> = { published_since: [], updated_since: [], deprecated: [] };
  let namesTruncated = false;
  const addName = (key: string, name: string) => {
    if (names[key].length < 1000) names[key].push(name); else namesTruncated = true;
  };
  const since = args.updated_since === undefined ? undefined : Date.parse(args.updated_since);
  do {
    signal.throwIfAborted();
    const page = await client.search({ limit: 100, cursor, updatedSince: args.updated_since, signal, maxResponseBytes: 2 * 1024 * 1024 });
    signal.throwIfAborted();
    if (!Array.isArray(page.servers) || page.servers.length > 100) throw new Error("Invalid registry page");
    for (const entry of page.servers) {
      const name = entry?.server?.name;
      if (typeof name !== "string" || !name || name.length > 512) throw new Error("Invalid registry server name");
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      counts.total++;
      const meta = officialMeta(entry);
      const status = meta.status;
      if (status === "active" || status === "deprecated" || status === "deleted") counts[status]++;
      else counts.unknown++;
      if (status === "deprecated") addName("deprecated", name);
      if (since !== undefined && Date.parse(meta.publishedAt ?? "") > since) { counts.published_since++; addName("published_since", name); }
      if (since !== undefined && Date.parse(meta.updatedAt ?? "") > since) { counts.updated_since++; addName("updated_since", name); }
    }
    pages++;
    progress(`${pages} pages, ${counts.total} distinct latest entries read`);
    const next = page.metadata?.nextCursor;
    if (next !== undefined && (typeof next !== "string" || next.length > 4096)) throw new Error("Invalid registry cursor");
    cursor = next || undefined;
    if (cursor && seenCursors.has(cursor)) throw new Error("Registry repeated a pagination cursor");
    if (cursor) seenCursors.add(cursor);
  } while (cursor && pages < args.max_pages);
  const data = { counts, names, namesTruncated, pages, partial: Boolean(cursor), nextCursor: cursor ?? null, updatedSince: args.updated_since ?? null };
  return { content: [{ type: "text", text: `Read ${counts.total} distinct latest entries in ${pages} pages${cursor ? " (partial: page bound reached)" : ""}. This is a paginated observation, not an atomic registry snapshot.` }], structuredContent: data };
}
