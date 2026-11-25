// Cloudflare Worker entry: streamable HTTP MCP endpoint at POST /mcp (stateless, JSON responses).
import { DEFAULT_REGISTRY, RegistryClient } from "./registry.js";
import { SERVER_INFO, SUPPORTED_VERSIONS, handlePayload } from "./jsonrpc.js";
import { TOOLS } from "./tools.js";

export interface Env {
  REGISTRY_BASE_URL?: string;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id",
  "access-control-expose-headers": "mcp-protocol-version",
};

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS, ...extra } });

export function serverCard() {
  return {
    serverInfo: SERVER_INFO,
    description: "Search the official MCP Registry from any MCP client.",
    transport: { type: "streamable-http", endpoint: "/mcp" },
    protocolVersions: SUPPORTED_VERSIONS,
    authentication: { required: false },
    tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description })),
  };
}

export async function handleRequest(request: Request, env: Env = {}, fetchImpl?: typeof fetch): Promise<Response> {
  const url = new URL(request.url);
  const client = new RegistryClient(env.REGISTRY_BASE_URL || DEFAULT_REGISTRY, fetchImpl ? (u, i) => fetchImpl(u, i) : undefined);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (url.pathname === "/" && request.method === "GET") {
    return json({ ok: true, name: SERVER_INFO.name, version: SERVER_INFO.version, backend: env.REGISTRY_BASE_URL || DEFAULT_REGISTRY, mcp: "/mcp" });
  }
  if (url.pathname === "/.well-known/mcp/server-card.json" && request.method === "GET") return json(serverCard());

  if (url.pathname === "/mcp") {
    if (request.method === "GET") return json({ error: "This server does not offer an SSE stream; POST JSON-RPC to /mcp." }, 405, { allow: "POST" });
    if (request.method === "DELETE") return new Response(null, { status: 405, headers: { ...CORS, allow: "POST" } });
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { allow: "POST" });
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    const out = await handlePayload(client, payload);
    if (out === null) return new Response(null, { status: 202, headers: CORS });
    const pv = request.headers.get("mcp-protocol-version");
    return json(out, 200, pv && SUPPORTED_VERSIONS.includes(pv) ? { "mcp-protocol-version": pv } : {});
  }
  return json({ error: "Not found" }, 404);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
