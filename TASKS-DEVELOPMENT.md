# MCP Tasks: stdio registry snapshot increment

## Objective and baseline

Continue the Claude artifact “MCP Tasks extension mapped to your MCP server work”:
https://claude.ai/artifact/TX4vsei1qCdw9GmsQYYp1k

Repository inspection found PR #1 still draft/unmerged. Work branches from
`rewrite/official-mcp-registry` at `dea053cd5b72df73b218c116bb36f2ebfe72c57a`;
there is no merge or deployment in this increment.

Baseline: eight synchronous tools, 14 passing offline tests, one opt-in live test.
Strategy: plan and execute one implementation, deterministic lifecycle tests,
an actual stdio subprocess, and independent validation against a pinned released
upstream schema. No model sampling, agents, paid services, installs of third-party
MCP servers, or benchmark-based reliability claims.

Stopping condition: one bounded snapshot tool, lifecycle and transport checks
passing, evidence recorded, and a draft change available for review.

## Design and trade-offs

| Choice | Benefit | Cost / limitation |
| --- | --- | --- |
| Process-scoped stdio adapter | Adds background work without changing the stateless Worker | Tasks are lost on restart; client interoperability still needs validation |
| Worker + Durable Objects (deferred) | Would persist task state across requests | Requires auth binding, routing, persistence and deployment tests |
| Probe patch first (deferred) | Would measure ecosystem capability coverage | Does not implement snapshot lifecycle |

`src/task-server.ts` owns per-request capabilities, discovery, admission, task
records, timers and lifecycle. `src/snapshot.ts` owns the input/output contract
and sequential crawl. `RegistryClient` accepts optional abort and response-byte
limits. The stdio entry owns one adapter and closes it at EOF.

Authentication is the inherited stdio process/pipe boundary, not self-reported
client metadata. Each instance owns a separate task map. No HTTP Tasks endpoint
is exposed. Random UUID task IDs prevent predictable enumeration within the pipe.

The Tasks release schema requires `resultType: complete` on update and cancel
acks; the artifact's empty-ack shorthand must not be copied literally.

## Tool contract

Goal: observe latest public registry entries without holding tools/call open.
Actor: client of this local stdio process. System of record: configured registry.
Effect: public read, local ephemeral task creation. No package execution.

Input: closed object with optional RFC 3339 `updated_since` (40 characters max)
and integer `max_pages` (1–1,000; default 1,000). Invalid or extra fields fail
before any crawl. Output schema is advertised on the tool.

Output: counts of unique latest names by registry status, latest-version
publication/update counts since the supplied timestamp, capped matching names,
page count, partial flag, continuation cursor, and name-truncation flag.
A version's publication is not evidence that its server identity is new.
Deprecated names represent currently deprecated entries in the queried set,
not verified deprecation transitions. True added/changed/deprecated deltas
require a retained prior snapshot; that is deferred.

Retries: none. Repeated calls create independent tasks. Polls are idempotent.
Repeated cancel/update calls acknowledge known records; completed results persist
until TTL. Updates never approve anything and ignore unknown response keys.

Errors: `-32021` missing per-request Tasks declaration; `-32602` invalid arguments
or unknown/expired task; `-32022` unsupported modern revision; `-32603` admission
capacity. Upstream, cursor, response-size and execution-deadline failures become
`completed` with a tool `isError`, without exposing upstream internals.

Bounds: 2 concurrent tasks; 32 retained records; 1 hour TTL from creation;
10 minute execution; 1,000 pages × 100 entries; 2 MiB per response;
512 characters per server name; 4,096 per cursor; 1,000 names per category.
Expired work is aborted and removed on the next task operation; deadline timers
abort executing work independently. RegistryClient's default behavior for the
original eight tools is preserved.

## Evidence (2026-11-28)

- Original baseline: 14 offline tests passed.
- Final `npm test`: 28 offline tests passed; one live test skipped by default.
- `npm run test:live`: 26 tests passed before the last three additional offline
  bounds tests were added. Those final three then passed in the final offline run.
- `python3 test/check-schema.py`: six actual lifecycle outputs pass the released
  2026-07-28 JSON Schema; actual successful snapshot data passes outputSchema.
- Stdio subprocess test: real node process creates handle, polls to completion
  against local HTTP fixture, exits cleanly at EOF.
- One bounded live snapshot: completed, 1 page, 100 distinct active latest
  entries, partial=true and continuation cursor present. No full registry crawl.
- CI on Node 22 exposed a fixture-only event-loop lifetime issue: its synthetic
  pending fetch did not keep the process alive while the production deadline timer
  was unreferenced. Added a 500 ms referenced watchdog to represent the open
  stdio pipe; final local checks passed after the fix.
- Checked expiry, isolation between server instances, capability omission on each
  lifecycle method, malformed input, cancellation abort, upstream failure, repeated
  cursor, partial coverage, response bytes, deadline, concurrency, retained capacity,
  deduplication and name-list truncation.

These are fixture and bounded-smoke results, not a production success-rate estimate.
No Best-of-N was used; pass@k comparisons do not apply. Observed outcome supports
keeping a single process and deterministic checks for this increment.

## Next dependency-ready work

1. Review PR #1's v1 compatibility and this stacked increment before merging.
2. Verify an installed Claude Code version's discovery, backgrounding, polling,
   terminal tool errors, and cancellation against this exact commit. Record client
   version and sanitized transcript; do not infer support from docs alone.
3. Run a small LiteLLM relay conformance fixture before routing Tasks through it.
4. For true deltas, design a baseline identity/version/status comparison contract.
5. Only then propose durable HTTP storage, auth binding and per-task routing.

Follow-up prompt: “Validate this exact commit with Claude Code over stdio and
record a sanitized lifecycle transcript before attempting the LiteLLM relay.”
