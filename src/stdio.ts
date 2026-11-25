#!/usr/bin/env node
// stdio entry: newline-delimited JSON-RPC on stdin/stdout. Logs go to stderr only.
import { createInterface } from "node:readline";
import { DEFAULT_REGISTRY, RegistryClient } from "./registry.js";
import { handlePayload } from "./jsonrpc.js";

const client = new RegistryClient(process.env.REGISTRY_BASE_URL || DEFAULT_REGISTRY);
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let pending = 0;
let closed = false;

rl.on("line", async (line) => {
  if (!line.trim()) return;
  pending++;
  try {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
      return;
    }
    const out = await handlePayload(client, msg);
    if (out !== null) process.stdout.write(JSON.stringify(out) + "\n");
  } catch (e) {
    console.error("smithery-registry-mcp:", (e as Error).message);
  } finally {
    pending--;
    if (closed && pending === 0) process.exit(0);
  }
});
rl.on("close", () => {
  closed = true;
  if (pending === 0) process.exit(0);
});
console.error("smithery-registry-mcp 2.0.0 on stdio, backed by the official MCP Registry");
