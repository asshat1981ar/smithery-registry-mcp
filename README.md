# smithery-registry-mcp 2.0

An MCP server that searches the **official MCP Registry** (`registry.modelcontextprotocol.io`). Version 1 read Smithery's registry API, which shut down on 2026-10-31 along with Smithery Connect, accounts, the CLI and the SDK. Version 2 reads the official registry instead. That registry is public, so the server needs no API key.

It runs two ways from the same code:

- **Cloudflare Worker:** stateless streamable HTTP at `POST /mcp`, a health check at `GET /`, and a server card at `/.well-known/mcp/server-card.json`.
- **stdio:** `npx smithery-registry-mcp`, or `node dist/stdio.js`.

## Tools

| Tool | What it does |
| --- | --- |
| `registry_search_servers` | Searches servers by name and returns the latest version of each, with remotes and packages. Deprecated servers are hidden unless `include_deprecated` is set. Pages with `nextCursor`. |
| `registry_get_server` | Gets one server by its registry name (for example `app.linear/linear`), at `latest` or at a version you name. |
| `registry_list_versions` | Lists every published version of a server, newest first, with each version's status. |
| `registry_install_config` | Builds a ready-to-paste `mcpServers` entry and a `claude mcp add` command from the remote endpoint or the npm, PyPI, NuGet or OCI package. Secrets appear as `<PLACEHOLDERS>`. |
| `smithery_search_servers` | v1 alias of `registry_search_servers`. It takes `query`, `pageSize` and `cursor`. |
| `smithery_get_server` | v1 alias. It takes `qualifiedName`, tries it as a registry name, then as `io.github.<name>`, then by search. |
| `smithery_create_connection_url` | v1 alias. Smithery Connect URLs no longer exist, so it returns the same output as `registry_install_config`. |
| `smithery_health_check` | Checks that the server can reach the registry and reports the latency. |

All eight tools are read-only.

## Develop

```bash
npm install
npm test          # offline regression, task lifecycle, and stdio subprocess tests
npm run test:live # adds a check against the real registry
```

## Deploy

```bash
npm run build
wrangler deploy
wrangler secret delete SMITHERY_API_KEY   # optional clean-up: v2 never reads it
```

`REGISTRY_BASE_URL` in `wrangler.toml` points at the public registry. To use a self-hosted or mirrored registry, change it there.

## Client config

```json
{ "mcpServers": { "mcp-registry": { "type": "http", "url": "https://smithery-registry-mcp.<your-subdomain>.workers.dev/mcp" } } }
```


## Task-backed snapshots (stdio, development branch)

Modern stdio clients using protocol `2026-07-28` can discover a ninth read-only tool,
`registry_snapshot`. The eight existing tools retain their synchronous behavior.
HTTP Workers continue serving legacy protocols and do not advertise Tasks.
This change is stacked on the unmerged v2 rewrite; it is not a published npm release.

Build locally and configure your client to run `node /absolute/path/to/dist/stdio.js`.
The client must send the following metadata on **each** modern request:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "registry_snapshot",
    "arguments": { "max_pages": 1 },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {
        "extensions": { "io.modelcontextprotocol/tasks": {} }
      }
    }
  }
}
```

The response is a flat `resultType: "task"` handle. Send `tasks/get` with its
`taskId` and the same metadata; honor `pollIntervalMs: 5000`. A terminal
`completed` task contains the ordinary tool result, including `structuredContent`.
`isError: true` is also a completed task. `tasks/cancel` stops unfinished work;
`tasks/update` accepts an `inputResponses` object but this tool requests no input.
Both acknowledge with `{ "resultType": "complete" }` (plus server metadata).

Limits: 1–1,000 pages, 100 entries/page, 2 MiB/page, 10 minutes execution,
2 concurrent crawls, 32 retained task records (starting a 33rd evicts the oldest
finished one), one hour TTL from creation, and 1,000 names per output category.
There are no automatic retries. `partial` and `nextCursor` mean coverage stopped
early; `stopReason` says why (`page_limit`, `deadline` or `upstream_error`), and
pages read before a deadline or registry failure are kept. A failure before the
first page is a tool `isError`. `namesTruncated` indicates capped lists.
Only requests that declare the Tasks extension see `registry_snapshot` in `tools/list`. Counts cover distinct names observed, not an atomic registry state.
`updated_since` is an optional RFC 3339 registry filter. `published_since` refers
to latest-version publication dates, not newly discovered server identities.

Task IDs are random UUIDs and scoped to this server process. The local stdio
pipe and OS process boundary supply caller isolation; clientInfo is never used
as authentication. Closing stdin, process exit, or restart discards all tasks.
Persistent HTTP tasks require a separate authorized storage design.

For independent upstream-schema validation (optional Python test dependency):

```bash
python3 -m pip install -r test/requirements-schema.txt
npm run test:schema
```

See [TASKS-DEVELOPMENT.md](TASKS-DEVELOPMENT.md) for evidence and remaining gates.
