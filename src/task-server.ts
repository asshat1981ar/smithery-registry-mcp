// Process-scoped stdio adapter. Never instantiate this in the stateless Worker.
import { randomUUID } from "node:crypto";
import { handleMessage, JsonRpcRequest, JsonRpcResponse, SERVER_INFO, SUPPORTED_VERSIONS } from "./jsonrpc.js";
import { RegistryClient } from "./registry.js";
import { TOOLS, ToolResult } from "./tools.js";
import { crawlSnapshot, parseSnapshotArgs, SNAPSHOT_TOOL } from "./snapshot.js";

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
export const MODERN_VERSION = "2026-07-28";
const VERSIONS = [MODERN_VERSION, ...SUPPORTED_VERSIONS];
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
interface Task {
  taskId: string; status: "working" | "completed" | "failed" | "cancelled";
  createdAt: string; lastUpdatedAt: string; ttlMs: number; pollIntervalMs: number;
  statusMessage: string; result?: ToolResult & { resultType: "complete" };
}
interface StoredTask { task: Task; controller: AbortController; timer: ReturnType<typeof setTimeout> }

export class StdioTaskServer {
  private readonly tasks = new Map<string, StoredTask>();
  constructor(private readonly client: RegistryClient, private readonly now = Date.now, private readonly ttlMs = 3_600_000, private readonly executionMs = 600_000) {}

  private removeExpired() {
    for (const [id, entry] of this.tasks) {
      if (this.now() >= Date.parse(entry.task.createdAt) + entry.task.ttlMs) {
        entry.controller.abort(); clearTimeout(entry.timer); this.tasks.delete(id);
      }
    }
  }
  close() { for (const entry of this.tasks.values()) { entry.controller.abort(); clearTimeout(entry.timer); } this.tasks.clear(); }

  async handle(payload: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    if (Array.isArray(payload)) {
      const results = await Promise.all(payload.map(item => this.message(item)));
      const replies = results.filter((r): r is JsonRpcResponse => r !== null);
      return replies.length ? replies : null;
    }
    return this.message(payload);
  }
  private async message(payload: unknown): Promise<JsonRpcResponse | null> {
    if (!object(payload) || payload.jsonrpc !== "2.0" || typeof payload.method !== "string") return handleMessage(this.client, payload);
    const req = payload as unknown as JsonRpcRequest;
    // Notifications must never start background work or mutate tasks.
    if (req.id === undefined) return null;
    if (req.params !== undefined && !object(req.params)) return { jsonrpc: "2.0", id: req.id, error: { code: -32602, message: "params must be an object" } };
    const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id: req.id!, result });
    const error = (code: number, message: string, data?: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id: req.id!, error: { code, message, ...(data === undefined ? {} : { data }) } });
    const meta = req.params?._meta;
    const version = object(meta) ? meta["io.modelcontextprotocol/protocolVersion"] : undefined;
    const modern = version !== undefined || req.method === "server/discover";
    if (modern) {
      if (version !== MODERN_VERSION) return error(-32022, "Unsupported protocol version", { supported: VERSIONS, requested: version ?? null });
      if (!object(meta) || !object(meta["io.modelcontextprotocol/clientCapabilities"])) return error(-32602, "Per-request clientCapabilities object is required");
    }
    const capabilities = object(meta) ? meta["io.modelcontextprotocol/clientCapabilities"] : undefined;
    const extensions = object(capabilities) ? capabilities.extensions : undefined;
    const declared = modern && object(extensions) && object(extensions[TASKS_EXTENSION]);
    const complete = (result: Record<string, unknown>) => ({ ...result, resultType: "complete", _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO } });
    if (req.method === "server/discover") return reply(complete({ supportedVersions: VERSIONS, capabilities: { tools: {}, extensions: { [TASKS_EXTENSION]: {} } }, instructions: "registry_snapshot is task-backed on stdio only. Tasks belong to this process and are lost on exit." }));
    // Only offer the task-backed tool to requests that can call it.
    if (req.method === "tools/list") return reply(modern ? complete({ tools: declared ? [...TOOLS, SNAPSHOT_TOOL] : TOOLS }) : { tools: TOOLS });
    const isSnapshot = req.method === "tools/call" && req.params?.name === SNAPSHOT_TOOL.name;
    const isTask = ["tasks/get", "tasks/cancel", "tasks/update"].includes(req.method);
    if (isSnapshot || isTask) {
      if (!declared) return error(-32021, "Missing required client capability", { requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } } });
      this.removeExpired();
      if (isSnapshot) {
        let args;
        try { args = parseSnapshotArgs(req.params?.arguments); } catch (e) { return error(-32602, (e as Error).message); }
        if ([...this.tasks.values()].filter(e => e.task.status === "working").length >= 2) return error(-32603, "Two snapshots are already running; wait for one to finish or cancel it");
        // At the retained limit, make room by evicting the oldest finished record (Map order is creation order).
        if (this.tasks.size >= 32) {
          const oldest = [...this.tasks].find(([, e]) => e.task.status !== "working");
          if (!oldest) return error(-32603, "Task capacity reached; wait for completion or expiry");
          clearTimeout(oldest[1].timer); this.tasks.delete(oldest[0]);
        }
        const timestamp = new Date(this.now()).toISOString();
        const task: Task = { taskId: randomUUID(), status: "working", createdAt: timestamp, lastUpdatedAt: timestamp, ttlMs: this.ttlMs, pollIntervalMs: 5000, statusMessage: "Snapshot queued" };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(this.executionMs, this.ttlMs));
        timer.unref();
        this.tasks.set(task.taskId, { task, controller, timer });
        const handle = { ...task, resultType: "task", _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO } };
        // Store before returning the handle; execution starts on a later event-loop turn.
        setImmediate(() => {
          void crawlSnapshot(this.client, args, controller.signal, message => { task.statusMessage = message; task.lastUpdatedAt = new Date(this.now()).toISOString(); })
            .then(result => {
              // Cancellation wins; a deadline still keeps the pages read before it (structuredContent.stopReason).
              if (task.status === "cancelled") return;
              task.result = { ...result, resultType: "complete" }; task.status = "completed";
              task.statusMessage = (result.structuredContent as { partial?: boolean } | undefined)?.partial ? "Snapshot completed with partial coverage" : "Snapshot completed";
            })
            .catch(() => {
              if (task.status === "cancelled") return;
              // Upstream/network/limit failures are tool errors, not JSON-RPC failures.
              task.status = "completed";
              task.statusMessage = "Snapshot did not finish";
              task.result = { resultType: "complete", isError: true, content: [{ type: "text", text: controller.signal.aborted ? "Snapshot execution deadline exceeded" : "Registry snapshot failed (upstream response, pagination, or byte limit). Retry with a smaller max_pages." }] };
            })
            .finally(() => { clearTimeout(timer); task.lastUpdatedAt = new Date(this.now()).toISOString(); });
        });
        return reply(handle);
      }
      const taskId = req.params?.taskId;
      const entry = typeof taskId === "string" ? this.tasks.get(taskId) : undefined;
      if (!entry) return error(-32602, "Unknown or expired taskId");
      if (req.method === "tasks/get") return reply(complete({ ...entry.task }));
      if (req.method === "tasks/update" && !object(req.params?.inputResponses)) return error(-32602, "inputResponses must be an object");
      if (req.method === "tasks/cancel" && entry.task.status === "working") {
        entry.task.status = "cancelled"; entry.task.statusMessage = "Cancellation accepted";
        entry.task.lastUpdatedAt = new Date(this.now()).toISOString(); entry.controller.abort(); clearTimeout(entry.timer);
      }
      // No input is requested by this tool; ignore responses for unknown input keys.
      return reply(complete({}));
    }
    const result = await handleMessage(this.client, req);
    if (modern && result && "result" in result && object(result.result)) return reply(complete(result.result));
    return result;
  }
}
