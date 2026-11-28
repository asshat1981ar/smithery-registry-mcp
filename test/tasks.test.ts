import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { RegistryClient, Fetch } from "../src/registry.js";
import { StdioTaskServer, MODERN_VERSION, TASKS_EXTENSION } from "../src/task-server.js";
import { crawlSnapshot, parseSnapshotArgs } from "../src/snapshot.js";

const caps = (declared = true) => ({ "io.modelcontextprotocol/protocolVersion": MODERN_VERSION, "io.modelcontextprotocol/clientCapabilities": { extensions: declared ? { [TASKS_EXTENSION]: {} } : {} } });
const rpc = (method: string, params: Record<string, unknown> = {}, declared = true) => ({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: caps(declared) } });
const entry = (name: string, status = "active") => ({ server: { name, version: "1" }, _meta: { "io.modelcontextprotocol.registry/official": { status, publishedAt: "2026-11-25T00:00:00Z", updatedAt: "2026-11-26T00:00:00Z" } } });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const client = (fetcher: Fetch = async () => response({ servers: [entry("test/a")], metadata: {} })) => new RegistryClient("https://test.invalid", fetcher);
const send = async (server: StdioTaskServer, method: string, params: Record<string, unknown> = {}, declared = true): Promise<any> => server.handle(rpc(method, params, declared));
const start = (server: StdioTaskServer, args: unknown = {}) => send(server, "tools/call", { name: "registry_snapshot", arguments: args });
async function terminal(server: StdioTaskServer, taskId: string) {
  for (let i = 0; i < 30; i++) {
    const r = await send(server, "tasks/get", { taskId });
    if (r.result.status !== "working") return r.result;
    await tick();
  }
  assert.fail("Task did not settle within 30 event-loop turns");
}

test("discovery, modern synchronous results, and unchanged legacy initialization", async t => {
  const server = new StdioTaskServer(client()); t.after(() => server.close());
  const discover = await send(server, "server/discover");
  assert.ok(discover.result.capabilities.extensions[TASKS_EXTENSION]);
  assert.equal(discover.result.resultType, "complete");
  const modern = await send(server, "tools/list");
  assert.equal(modern.result.tools.length, 9);
  const legacy: any = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  assert.equal(legacy.result.protocolVersion, "2025-11-25");
  assert.equal(legacy.result.capabilities.extensions, undefined);
  const legacyList: any = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(legacyList.result.tools.length, 8);
  assert.equal((await send(server, "ping")).result.resultType, "complete");
});

test("capabilities are required on each snapshot and task request", async t => {
  let fetches = 0;
  const server = new StdioTaskServer(client(async () => { fetches++; return response({ servers: [] }); })); t.after(() => server.close());
  const created = await start(server);
  for (const method of ["tasks/get", "tasks/cancel", "tasks/update"]) {
    const r = await send(server, method, { taskId: created.result.taskId, inputResponses: {} }, false);
    assert.equal(r.error.code, -32021);
    assert.ok(r.error.data.requiredCapabilities.extensions[TASKS_EXTENSION]);
  }
  const noCaps = await send(server, "tools/call", { name: "registry_snapshot" }, false);
  assert.equal(noCaps.error.code, -32021);
  assert.equal(fetches, 0, "no crawl before returning handles");
});

test("handle is immediately retrievable; paginated result counts deduplicated entries", async t => {
  const urls: string[] = [];
  const server = new StdioTaskServer(client(async url => {
    urls.push(url);
    return response(new URL(url).searchParams.has("cursor") ? { servers: [entry("test/a"), entry("test/b", "deprecated")] } : { servers: [entry("test/a")], metadata: { nextCursor: "second" } });
  })); t.after(() => server.close());
  const created = (await start(server, { updated_since: "2026-11-24T00:00:00Z" })).result;
  assert.equal(created.resultType, "task");
  assert.match(created.taskId, /^[0-9a-f-]{36}$/);
  assert.equal((await send(server, "tasks/get", { taskId: created.taskId })).result.status, "working");
  const result = await terminal(server, created.taskId);
  assert.equal(result.resultType, "complete"); assert.equal(result.status, "completed");
  assert.equal(result.result.resultType, "complete");
  const data = result.result.structuredContent;
  assert.equal(data.counts.total, 2); assert.equal(data.counts.deprecated, 1);
  assert.equal(data.counts.published_since, 2); assert.equal(data.partial, false);
  assert.deepEqual(data.names.deprecated, ["test/b"]);
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[0]).searchParams.get("updated_since"), "2026-11-24T00:00:00Z");
  assert.deepEqual((await send(server, "tasks/get", { taskId: created.taskId })).result, result);
  assert.deepEqual((await send(server, "tasks/update", { taskId: created.taskId, inputResponses: { unused: {} } })).result.resultType, "complete");
  assert.equal((await send(server, "tasks/cancel", { taskId: created.taskId })).result.resultType, "complete");
  assert.equal((await send(server, "tasks/get", { taskId: created.taskId })).result.status, "completed");
});

test("unknown and expired tasks fail without crossing process boundaries", async t => {
  let now = 0;
  const server = new StdioTaskServer(client(), () => now); t.after(() => server.close());
  const other = new StdioTaskServer(client()); t.after(() => other.close());
  const taskId = (await start(server)).result.taskId;
  assert.equal((await send(other, "tasks/get", { taskId })).error.code, -32602);
  now = 3_600_000;
  for (const method of ["tasks/get", "tasks/cancel", "tasks/update"]) assert.equal((await send(server, method, { taskId, inputResponses: {} })).error.code, -32602);
});

test("cancellation aborts in-flight fetch and does not overwrite terminal state", async t => {
  let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; });
  let aborted = false;
  const server = new StdioTaskServer(client(async (_url, init) => {
    started();
    return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true }));
  })); t.after(() => server.close());
  const taskId = (await start(server)).result.taskId;
  await began;
  assert.equal((await send(server, "tasks/cancel", { taskId })).result.resultType, "complete");
  await tick(); assert.equal(aborted, true);
  assert.equal((await send(server, "tasks/get", { taskId })).result.status, "cancelled");
});

test("upstream and repeated cursor errors are completed tool errors", async t => {
  for (const fetcher of [async () => response({}, 503), async () => response({ servers: [], metadata: { nextCursor: "loop" } })]) {
    const server = new StdioTaskServer(client(fetcher)); t.after(() => server.close());
    const taskId = (await start(server)).result.taskId;
    const task = await terminal(server, taskId);
    assert.equal(task.status, "completed"); assert.equal(task.result.isError, true);
  }
});

test("page bound reports partial coverage without a second fetch", async () => {
  let calls = 0;
  const result = await crawlSnapshot(client(async () => { calls++; return response({ servers: [], metadata: { nextCursor: "more" } }); }), { max_pages: 1 }, new AbortController().signal, () => {});
  assert.equal(calls, 1); assert.equal(result.structuredContent!.partial, true);
  assert.equal(result.structuredContent!.nextCursor, "more");
});

test("strict argument and protocol validation rejects malformed inputs", async t => {
  const server = new StdioTaskServer(client()); t.after(() => server.close());
  for (const args of [null, [], "text", { max_pages: 0 }, { max_pages: 1001 }, { max_pages: 1.2 }, { extra: true }, { updated_since: "yesterday" }, { updated_since: "2026-02-30T00:00:00Z" }]) assert.equal((await start(server, args)).error.code, -32602);
  assert.throws(() => parseSnapshotArgs({ max_pages: "4" }));
  const bad = rpc("server/discover"); bad.params._meta["io.modelcontextprotocol/protocolVersion"] = "2099-01-01";
  const result: any = await server.handle(bad); assert.equal(result.error.code, -32022);
  const missing: any = await server.handle({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_VERSION } } });
  assert.equal(missing.error.code, -32602);
  const taskId = (await start(server)).result.taskId;
  assert.equal((await send(server, "tasks/update", { taskId })).error.code, -32602);
});

test("concurrency bound and notifications cannot create work", async t => {
  const server = new StdioTaskServer(client()); t.after(() => server.close());
  const note: any = rpc("tools/call", { name: "registry_snapshot" }); delete note.id;
  assert.equal(await server.handle(note), null);
  assert.equal((await start(server)).result.resultType, "task");
  assert.equal((await start(server)).result.resultType, "task");
  assert.equal((await start(server)).error.code, -32603);
});

test("page byte and shape bounds fail without returning success", async () => {
  const huge = "x".repeat(2 * 1024 * 1024 + 1);
  for (const body of [huge, JSON.stringify({ servers: Array.from({ length: 101 }, () => entry("test/a")) }), JSON.stringify({ servers: [entry("x".repeat(513))] })]) {
    await assert.rejects(crawlSnapshot(client(async () => new Response(body)), { max_pages: 1 }, new AbortController().signal, () => {}));
  }
});

test("stdio subprocess accepts a handle and returns its final result", { timeout: 5000 }, async t => {
  const upstream = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ servers: [entry("test/process")] })); });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  t.after(() => upstream.close());
  const address = upstream.address() as { port: number };
  const child = spawn(process.execPath, ["dist/stdio.js"], { env: { ...process.env, REGISTRY_BASE_URL: `http://127.0.0.1:${address.port}` }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  t.after(() => lines.close());
  const queue: any[] = []; let waiting: ((value: any) => void) | undefined;
  lines.on("line", line => { const data = JSON.parse(line); if (waiting) { const resolve = waiting; waiting = undefined; resolve(data); } else queue.push(data); });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise<any>(resolve => { waiting = resolve; });
  const request = async (data: unknown) => { child.stdin.write(JSON.stringify(data) + "\n"); return next(); };
  const handle = await request(rpc("tools/call", { name: "registry_snapshot", arguments: { max_pages: 1 } }));
  assert.equal(handle.result.resultType, "task");
  let final: any;
  for (let i = 0; i < 100; i++) {
    final = await request(rpc("tasks/get", { taskId: handle.result.taskId }));
    if (final.result.status !== "working") break;
    await tick();
  }
  assert.equal(final.result.status, "completed");
  assert.equal(final.result.result.structuredContent.counts.total, 1);
  const exited = once(child, "exit"); child.stdin.end();
  assert.equal((await exited)[0], 0);
});


test("execution deadline aborts a stalled upstream and returns a tool error", { timeout: 1000 }, async t => {
  let sawAbort!: () => void;
  const aborted = new Promise<void>(resolve => { sawAbort = resolve; });
  const server = new StdioTaskServer(client(async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => { sawAbort(); reject(new Error("deadline")); }, { once: true });
  })), Date.now, 3_600_000, 20);
  t.after(() => server.close());
  const taskId = (await start(server)).result.taskId;
  await aborted;
  const task = await terminal(server, taskId);
  assert.equal(task.status, "completed");
  assert.equal(task.result.isError, true);
  assert.match(task.result.content[0].text, /deadline/);
});

test("retained task capacity is bounded even after completion", async t => {
  const server = new StdioTaskServer(client()); t.after(() => server.close());
  for (let i = 0; i < 32; i++) await terminal(server, (await start(server)).result.taskId);
  assert.equal((await start(server)).error.code, -32603);
});

test("long name lists are capped while counts remain accurate", async () => {
  let page = 0;
  const result = await crawlSnapshot(client(async () => {
    const offset = page++ * 100;
    return response({ servers: Array.from({ length: 100 }, (_, i) => entry(`test/${offset + i}`, "deprecated")), metadata: page < 11 ? { nextCursor: String(page) } : {} });
  }), { max_pages: 11 }, new AbortController().signal, () => {});
  const data = result.structuredContent as any;
  assert.equal(data.counts.total, 1100);
  assert.equal(data.names.deprecated.length, 1000);
  assert.equal(data.namesTruncated, true);
  assert.equal(data.partial, false);
});
