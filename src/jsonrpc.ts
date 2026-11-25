// Minimal, stateless MCP JSON-RPC handler shared by the Worker and stdio entry points.
import { RegistryClient } from "./registry.js";
import { TOOLS, callTool } from "./tools.js";

export const SERVER_INFO = { name: "smithery-registry-mcp", title: "MCP Registry search", version: "2.0.0" };
export const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS =
  "Searches the official MCP Registry (registry.modelcontextprotocol.io). Use registry_search_servers to find servers, registry_get_server for details and registry_install_config for ready-to-paste client config. The smithery_* tools are v1 aliases.";

type Id = string | number | null;
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: Id;
  method: string;
  params?: Record<string, unknown>;
}
export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: Id; result: unknown }
  | { jsonrpc: "2.0"; id: Id; error: { code: number; message: string; data?: unknown } };

const err = (id: Id, code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

/** Returns null for notifications (no id), which get no response. */
export async function handleMessage(client: RegistryClient, msg: unknown): Promise<JsonRpcResponse | null> {
  if (!msg || typeof msg !== "object" || (msg as JsonRpcRequest).jsonrpc !== "2.0" || typeof (msg as JsonRpcRequest).method !== "string") {
    return err((msg as { id?: Id })?.id ?? null, -32600, "Invalid Request");
  }
  const req = msg as JsonRpcRequest;
  const isNotification = req.id === undefined;
  const id = req.id ?? null;
  const reply = (result: unknown): JsonRpcResponse | null => (isNotification ? null : { jsonrpc: "2.0", id, result });

  switch (req.method) {
    case "initialize": {
      const asked = String(req.params?.protocolVersion ?? "");
      const protocolVersion = SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0];
      return reply({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = req.params?.name;
      if (typeof name !== "string") return isNotification ? null : err(id, -32602, "params.name is required");
      if (!TOOLS.some((t) => t.name === name)) return isNotification ? null : err(id, -32602, `Unknown tool: ${name}`);
      return reply(await callTool(client, name, req.params?.arguments));
    }
    default:
      return isNotification ? null : err(id, -32601, `Method not found: ${req.method}`);
  }
}

export async function handlePayload(client: RegistryClient, payload: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(payload)) {
    const out = (await Promise.all(payload.map((m) => handleMessage(client, m)))).filter((r): r is JsonRpcResponse => r !== null);
    return out.length ? out : null;
  }
  return handleMessage(client, payload);
}
