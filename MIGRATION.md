# What changed from v1

## Why

Smithery shut down its registry API, Connect, accounts, CLI and SDK on 2026-10-31. Its site is now a read-only directory run by Arcade (see smithery.ai/future). Every v1 tool depended on that API, so v1 can no longer return results.

## Changes

- **Backend:** v2 calls the official MCP Registry v0 API: `/v0/servers`, `/v0/servers/{name}/versions` and `/v0/servers/{name}/versions/{version}`. Smithery is no longer called.
- **Secrets:** v2 needs none. `SMITHERY_API_KEY` is no longer read, and you can delete it from the Worker.
- **New tools:**
  - `registry_search_servers`
  - `registry_get_server`
  - `registry_list_versions`
  - `registry_install_config`
- **v1 tool names still work.** They are kept as aliases, so existing clients and prompts don't break:
  - `smithery_search_servers` takes `pageSize` and `cursor`. The registry pages by cursor, not by page number, so `page` is ignored.
  - `smithery_get_server` takes `qualifiedName` and maps old names like `@owner/repo` to registry names. Where no name matches exactly, it falls back to search, so check the `name` it returns.
  - `smithery_create_connection_url` can't return a Connect URL any more. It returns install config instead: an `mcpServers` entry and a `claude mcp add` command.
  - `smithery_health_check` now checks the registry.
- **Kept:**
  - The health check at `GET /`
  - The server card at `/.well-known/mcp/server-card.json`
  - `POST /mcp`
  - The stdio entry point
- **Protocol:** v2 accepts MCP protocol versions 2024-11-05 through 2025-11-25 and answers with the version the client asked for.

## What to check

This rewrite was built from the known shape of v1: its routes, its four tool names and the Worker plus stdio layout. The v1 source wasn't in any repository this session could read. Before you merge, compare these against v1:

- Tool argument names
- Output fields
- Anything in v1's `client.js` that other code imports
