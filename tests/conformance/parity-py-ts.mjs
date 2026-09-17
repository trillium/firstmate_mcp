#!/usr/bin/env node
/**
 * Cross-path wire parity: Python server vs TypeScript sibling.
 *
 * Same stub home, same call sequence, diffed payloads. Any behavioral
 * drift between the two implementations fails loudly naming the call.
 * Read-only plus validation refusals plus fail-closed stub errors only —
 * no live fleet, no side effects.
 *
 * Usage: node tests/conformance/parity-py-ts.mjs
 * (or bash tests/conformance/ts-parity.sh for the full TS gate)
 *
 * The TS server spawns via process.execPath, so the runner running this
 * script selects the server runtime: `node ...` proves the node server,
 * `bun ...` proves the bun server.
 */
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const APPROVAL = "I authorize parity proof";

const SNAPSHOT = { schema: "fm-fleet-snapshot.v1", generated: "stub", backlog: {}, tasks: [] };
const STUBS = {
  "fm-fleet-snapshot.sh": `echo '${JSON.stringify(SNAPSHOT)}'\n`,
  "fm-crew-state.sh": "echo 'state: unknown · source: none · stub: no such crew'\n",
  "fm-send.sh": "echo 'stub: no such crew' >&2\nexit 1\n",
  "fm-control.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-spawn.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-brief.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-decision-hold.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-review-decision.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-x-reply.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-x-dismiss.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-x-followup.sh": "echo 'stub: refused' >&2\nexit 1\n",
};

function makeStubHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fm-parity-"));
  fs.mkdirSync(path.join(home, "bin"));
  for (const [name, body] of Object.entries(STUBS)) {
    const script = path.join(home, "bin", name);
    fs.writeFileSync(script, "#!/bin/sh\n" + body, "utf8");
    fs.chmodSync(script, 0o755);
  }
  fs.mkdirSync(path.join(home, "state"));
  return home;
}

class Client {
  constructor(argv, env) {
    this.proc = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    this.seq = 0;
    this.queue = [];
    this.buffer = [];
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => {
      const next = this.queue.shift();
      if (next) next(line);
      else this.buffer.push(line);
    });
  }
  nextLine() {
    const ready = this.buffer.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise((resolve) => this.queue.push(resolve));
  }
  async request(method, params) {
    this.seq += 1;
    const msg = { jsonrpc: "2.0", id: this.seq, method };
    if (params !== undefined) msg.params = params;
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
    return JSON.parse(await this.nextLine());
  }
  async call(name, args) {
    return this.request("tools/call", { name, arguments: args });
  }
  async close() {
    this.proc.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { this.proc.kill("SIGKILL"); } catch {} resolve(); }, 10000);
      this.proc.on("exit", () => { clearTimeout(timer); resolve(); });
    });
    this.rl.close();
  }
}

function payload(resp) {
  return JSON.parse(resp.result.content[0].text);
}
function isError(resp) {
  return resp.result?.isError === true;
}

const failures = [];
function compare(label, py, ts) {
  try {
    assert.deepStrictEqual(ts, py);
    console.log(`ok - ${label}`);
  } catch (exc) {
    failures.push(label);
    console.error(`not ok - ${label}\n  py: ${JSON.stringify(py)?.slice(0, 400)}\n  ts: ${JSON.stringify(ts)?.slice(0, 400)}`);
  }
}

async function main() {
  const home = makeStubHome();
  const pyServer = path.join(ROOT, "fm_mcp_server.py");
  const tsServer = path.join(ROOT, "ts", "dist", "server.js");
  if (!fs.existsSync(tsServer)) {
    console.error("not ok - missing ts/dist/server.js; run `npm run build` in ts/ first");
    process.exit(2);
  }
  const py = new Client(["python3", pyServer], { FM_HOME: home });
  const ts = new Client([process.execPath, tsServer], { FM_HOME: home });
  try {
    const pyInit = await py.request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
    const tsInit = await ts.request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
    compare("initialize negotiates identically", pyInit.result, tsInit.result);
    py.notify ?? null;
    for (const c of [py, ts]) c.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    const pyList = await py.request("tools/list");
    const tsList = await ts.request("tools/list");
    compare("tools/list identical", pyList.result, tsList.result);

    const calls = [
      ["fleet_snapshot", {}],
      ["backlog", {}],
      ["crew_state unknown", "crew_state", { id: "no-such-id" }],
      ["crew_state traversal", "crew_state", { id: "../escape" }],
      ["status_tail missing", "status_tail", { id: "no-such-id", lines: 5 }],
      ["status_tail traversal", "status_tail", { id: "x/../../y" }],
      ["send_message slash", "send_message", { target: "x", text: "/merge now" }],
      ["send_message multiline", "send_message", { target: "x", text: "one\ntwo" }],
      ["send_message cap", "send_message", { target: "x", text: "z".repeat(501) }],
      ["send_message fail-closed", "send_message", { target: "no-such-id", text: "hello" }],
      ["interrupt no approval", "lifecycle_interrupt", { id: "x" }],
      ["interrupt traversal", "lifecycle_interrupt", { id: "../e", approval: APPROVAL }],
      ["interrupt stub error", "lifecycle_interrupt", { id: "x", approval: APPROVAL }],
      ["relaunch needs note", "lifecycle_relaunch", { id: "x", approval: APPROVAL }],
      ["spawn bad mode", "spawn_crew", { task_id: "x", project: "p", mode: "bogus", yolo: "off", approval: APPROVAL }],
      ["spawn absolute project", "spawn_crew", { task_id: "x", project: "/abs", mode: "local-only", yolo: "off", approval: APPROVAL }],
      ["brief bad mode", "scaffold_brief", { task_id: "x", project: "p", mode: "bogus", approval: APPROVAL }],
      ["decision hold no approval", "decision_hold", { origin_id: "x", decision_key: "k", title: "t", reason: "r" }],
      ["decision resolve no approval", "decision_resolve", { origin_id: "x", decision_key: "k", routed_to: "y", decision_text: "d" }],
      ["review bad verdict", "review_decision", { id: "x", verdict: "bogus", approval: APPROVAL }],
      ["relay reply traversal", "relay_reply", { request_id: "../x", text: "hi", approval: APPROVAL }],
      ["relay dismiss no approval", "relay_dismiss", { request_id: "x" }],
      ["relay followup bad final", "relay_followup", { task_id: "x", text: "d", final: "yes", approval: APPROVAL }],
      ["fleet_poll", "fleet_poll", { count: 1, interval_s: 0 }],
    ];
    for (const entry of calls) {
      const [label, name, args] = entry.length === 2 ? [entry[0], entry[0], entry[1]] : entry;
      const pyResp = await py.call(name, args);
      const tsResp = await ts.call(name, args);
      compare(`${label} isError agrees`, isError(tsResp), isError(pyResp));
      compare(`${label} payload identical`, payload(tsResp), payload(pyResp));
    }

    const pyUnknown = await py.call("promote_scout", {});
    const tsUnknown = await ts.call("promote_scout", {});
    compare("code-forbidden refused identically", tsUnknown.error ?? null, pyUnknown.error ?? null);

    const pyPing = await py.request("ping");
    const tsPing = await ts.request("ping");
    compare("ping identical", tsPing.result, pyPing.result);
  } finally {
    await py.close();
    await ts.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} parity check(s) failed`);
    process.exit(1);
  }
  console.log("\npy/ts wire parity holds");
}

await main();
