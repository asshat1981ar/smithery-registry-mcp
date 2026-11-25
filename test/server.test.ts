import { test } from "node:test";
import assert from "node:assert/strict";
import { RegistryClient, RegistryEntry } from "../src/registry.js";
import { handleMessage, handlePayload } from "../src/jsonrpc.js";
import { installConfig, packageConfig, resolveLegacyName, TOOLS } from "../src/tools.js";
import { handleRequest } from "../src/worker.js";

const meta = (status = "active") => ({ "io.modelcontextprotocol.registry/official": { status, isLatest: true, publishedAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" } });
const LINEAR: RegistryEntry = {
  server: { name: "app.linear/linear", title: "Linear", description: "Issues", version: "1.0.2", remotes: [{ type: "streamable-http", url: "https://mcp.linear.app/mcp" }] },
  _meta: meta(),
};
const GH: RegistryEntry = {
  server: {
    name: "io.github.github/github-mcp-server",
    version: "0.30.0",
    repository: { url: "https://github.com/github/github-mcp-server" },
    packages: [
      { registryType: "oci", identifier: "ghcr.io/github/github-mcp-server", version: "0.30.0", environmentVariables: [{ name: "GITHUB_PERSONAL_ACCESS_TOKEN", isSecret: true }] },
    ],
  },
  _meta: meta(),
};
const OLD: RegistryEntry = { server: { name: "io.github.someone/old", version: "0.1.0" }, _meta: meta("deprecated") };

function mockFetch(calls: string[] = []) {
  return async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    const body = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/v0/servers") {
      const q = u.searchParams.get("search") ?? "";
      const all = [LINEAR, GH, OLD].filter((e) => e.server.name.includes(q));
      return body({ servers: all, metadata: { nextCursor: "next-1", count: all.length } });
    }
    const m = u.pathname.match(/^\/v0\/servers\/([^/]+)\/versions(?:\/([^/]+))?$/);
    if (m) {
      const name = decodeURIComponent(m[1]);
      const e = [LINEAR, GH, OLD].find((x) => x.server.name === name);
      if (!e) return body({ title: "Not Found" }, 404);
      return m[2] ? body(e) : body({ servers: [e, { ...e, server: { ...e.server, version: "0.0.9" }, _meta: { "io.modelcontextprotocol.registry/official": { status: "active", publishedAt: "2026-01-01T00:00:00Z" } } }] });
    }
    return body({}, 404);
  };
}

const client = (calls?: string[]) => new RegistryClient("https://registry.test", mockFetch(calls));
const call = async (name: string, args: Record<string, unknown> = {}, c = client()) => {
  const r = (await handleMessage(c, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as any;
  return r.result;
};

test("initialize negotiates a supported protocol version", async () => {
  const r = (await handleMessage(client(), { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })) as any;
  assert.equal(r.result.protocolVersion, "2025-06-18");
  assert.equal(r.result.serverInfo.version, "2.0.0");
  const r2 = (await handleMessage(client(), { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })) as any;
  assert.equal(r2.result.protocolVersion, "2025-11-25");
});

test("tools/list keeps the four v1 names and adds the registry tools", async () => {
  const r = (await handleMessage(client(), { jsonrpc: "2.0", id: 1, method: "tools/list" })) as any;
  const names = r.result.tools.map((t: any) => t.name);
  for (const n of ["smithery_search_servers", "smithery_get_server", "smithery_create_connection_url", "smithery_health_check", "registry_search_servers", "registry_get_server", "registry_list_versions", "registry_install_config"])
    assert.ok(names.includes(n), n);
  assert.equal(TOOLS.length, 8);
});

test("notifications get no response and unknown methods get -32601", async () => {
  assert.equal(await handleMessage(client(), { jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const r = (await handleMessage(client(), { jsonrpc: "2.0", id: 9, method: "nope" })) as any;
  assert.equal(r.error.code, -32601);
});

test("search hides deprecated servers unless asked and returns the cursor", async () => {
  const calls: string[] = [];
  const res = await call("registry_search_servers", { query: "", limit: 5 }, client(calls));
  assert.equal(res.structuredContent.count, 2);
  assert.equal(res.structuredContent.nextCursor, "next-1");
  assert.match(calls[0], /version=latest/);
  assert.match(calls[0], /limit=5/);
  const withOld = await call("registry_search_servers", { include_deprecated: true });
  assert.equal(withOld.structuredContent.count, 3);
});

test("get_server encodes the slash in the name", async () => {
  const calls: string[] = [];
  const res = await call("registry_get_server", { name: "app.linear/linear" }, client(calls));
  assert.equal(res.structuredContent.name, "app.linear/linear");
  assert.ok(calls[0].endsWith("/v0/servers/app.linear%2Flinear/versions/latest"));
});

test("a missing server is a tool error, not a protocol error", async () => {
  const res = await call("registry_get_server", { name: "nope/nope" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Not found/);
});

test("list_versions sorts newest first", async () => {
  const res = await call("registry_list_versions", { name: "app.linear/linear" });
  assert.deepEqual(res.structuredContent.versions.map((v: any) => v.version), ["1.0.2", "0.0.9"]);
});

test("install config for a remote server", () => {
  const c = installConfig(LINEAR);
  assert.deepEqual(c.mcpServers, { linear: { type: "http", url: "https://mcp.linear.app/mcp" } });
  assert.equal(c.claudeCodeCommand, "claude mcp add --transport http linear https://mcp.linear.app/mcp");
});

test("install config for an OCI package uses placeholders for secrets", () => {
  const c = installConfig(GH) as any;
  const e = c.mcpServers["github-mcp-server"];
  assert.equal(e.command, "docker");
  assert.deepEqual(e.args, ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server:0.30.0"]);
  assert.equal(e.env.GITHUB_PERSONAL_ACCESS_TOKEN, "<GITHUB_PERSONAL_ACCESS_TOKEN>");
});

test("npm and pypi packages pin their versions", () => {
  assert.deepEqual(packageConfig({ registryType: "npm", identifier: "@playwright/mcp", version: "0.0.86" }), { command: "npx", args: ["-y", "@playwright/mcp@0.0.86"] });
  assert.deepEqual(packageConfig({ registryType: "pypi", identifier: "chroma-mcp", version: "0.2.6" }), { command: "uvx", args: ["chroma-mcp==0.2.6"] });
  assert.equal(packageConfig({ registryType: "mcpb", identifier: "https://x/y.mcpb" }), null);
});

test("v1 smithery_get_server resolves an old qualified name", async () => {
  const e = await resolveLegacyName(client(), "@github/github-mcp-server");
  assert.equal(e?.server.name, "io.github.github/github-mcp-server");
  const res = await call("smithery_get_server", { qualifiedName: "linear" });
  assert.equal(res.structuredContent.name, "app.linear/linear");
  assert.match(res.structuredContent.deprecated, /Deprecated alias/);
});

test("v1 smithery_create_connection_url now returns install config", async () => {
  const res = await call("smithery_create_connection_url", { qualifiedName: "app.linear/linear" });
  assert.ok(res.structuredContent.mcpServers.linear);
});

test("batches drop notifications", async () => {
  const out = (await handlePayload(client(), [
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 1, method: "ping" },
  ])) as any[];
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].result, {});
});

test("worker routes: health, server card, /mcp POST, GET 405, parse error", async () => {
  const f = mockFetch() as unknown as typeof fetch;
  const health = await handleRequest(new Request("https://w.test/"), { REGISTRY_BASE_URL: "https://registry.test" }, f);
  assert.equal((await health.json()).ok, true);
  const card = await (await handleRequest(new Request("https://w.test/.well-known/mcp/server-card.json"), {}, f)).json();
  assert.equal(card.tools.length, 8);
  const post = await handleRequest(
    new Request("https://w.test/mcp", { method: "POST", headers: { "content-type": "application/json", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "registry_get_server", arguments: { name: "app.linear/linear" } } }) }),
    { REGISTRY_BASE_URL: "https://registry.test" },
    f,
  );
  assert.equal(post.headers.get("mcp-protocol-version"), "2025-06-18");
  assert.equal((await post.json()).result.structuredContent.name, "app.linear/linear");
  assert.equal((await handleRequest(new Request("https://w.test/mcp"), {}, f)).status, 405);
  const bad = await handleRequest(new Request("https://w.test/mcp", { method: "POST", body: "{" }), {}, f);
  assert.equal(bad.status, 400);
  const note = await handleRequest(new Request("https://w.test/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }), {}, f);
  assert.equal(note.status, 202);
});

test("live: the real registry answers search and get (LIVE=1)", { skip: !process.env.LIVE }, async () => {
  const live = new RegistryClient();
  const s = await call("registry_search_servers", { query: "github", limit: 3 }, live);
  assert.ok(s.structuredContent.count > 0, "search returned servers");
  const g = await call("registry_get_server", { name: "app.linear/linear" }, live);
  assert.equal(g.isError, undefined);
  assert.equal(g.structuredContent.name, "app.linear/linear");
  const i = await call("registry_install_config", { name: "app.linear/linear" }, live);
  assert.ok(i.structuredContent.mcpServers);
  const h = await call("smithery_health_check", {}, live);
  assert.equal(h.structuredContent.ok, true);
});
