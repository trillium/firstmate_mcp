#!/usr/bin/env node
/**
 * Thin TypeScript-boundary adapter: one MCP tools/call over stdio, no assertions.
 * The server spawns via process.execPath, so `node mcp_call.mjs` proves node
 * and `bun mcp_call.mjs` proves bun.
 *
 * Usage:
 *   FM_HOME=/tmp/stub node tests/upstream/adapters/mcp_call.mjs fleet_snapshot '{}'
 */
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const SERVER = path.join(ROOT, "ts", "dist", "server.js");

const [tool, argsJson] = process.argv.slice(2);
if (!tool || argsJson === undefined) {
  console.error("usage: mcp_call.mjs <tool> '<json-args>'");
  process.exit(2);
}

const child = spawn(process.execPath, [SERVER], {
  stdio: ["pipe", "pipe", "ignore"],
  env: { ...process.env },
});
const rl = readline.createInterface({ input: child.stdout });
child.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: JSON.parse(argsJson) } }) + "\n",
);
const line = await new Promise((resolve) => rl.once("line", resolve));
console.log(line);
child.stdin.end();
await new Promise((resolve) => {
  const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 10000);
  child.on("exit", () => { clearTimeout(timer); resolve(); });
});
rl.close();
