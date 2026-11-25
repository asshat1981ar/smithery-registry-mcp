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
npm test          # 14 offline tests against a mocked registry
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
