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
const CONTRIBUTION_INPUT = { backlog: {}, tasks: [] };
const BEARINGS = { schema: "fm-bearings.v1", generated: "stub", in_flight: [], decisions_open: [], landed: [], omitted: [] };
const STUBS = {
  "fm-fleet-snapshot.sh": `if [ "$1" = "--contribution-input" ]; then echo '${JSON.stringify(CONTRIBUTION_INPUT)}'; else echo '${JSON.stringify(SNAPSHOT)}'; fi\n`,
  "fm-crew-state.sh": "echo 'state: unknown · source: none · stub: no such crew'\n",
  "fm-peek.sh": 'echo "peek-stub:$1 lines=$2"\n',
  "fm-fleet-view.sh": "echo '# Fleet View stub'\n",
  "fm-review-diff.sh": 'echo "diff-stub:$1 stat=$2"\n',
  "fm-bearings-snapshot.sh": `echo '${JSON.stringify(BEARINGS)}'\n`,
  "fm-wake-drain.sh": "echo 'wake-drain stub: empty'\n",
  "fm-guard.sh": "exit 0\n",
  "fm-remote-doctor.sh": "echo 'doctor-stub: mode=check'\n",
  "fm-remote-file.sh": 'echo "file-stub:$2 max=$3"\n',
  "fm-remote-delta-read.sh": 'echo "delta-stub:$1 off=$2 wait=$4"\n',
  "fm-secondmate-reconcile.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-secondmate-restart.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-secondmate-report.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-remote-secondmate-control.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-backlog-handoff.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-harness.sh": 'echo "harness-stub:$1"\n',
  "fm-project-mode.sh": 'echo "local-only off"\n',
  "fm-lock.sh": "echo 'lock: free'\n",
  "fm-lease.sh": 'if [ "$1" = "check" ]; then if [ "$2" = "leased-task" ]; then echo "main 4242 1700000000 live"; exit 0; else exit 1; fi; fi\nexit 2\n',
  "fm-bearings-board.sh": 'echo "$FM_HOME/.lavish/bearings-board.html"\n',
  "fm-inbox.sh": 'echo "inbox-stub:$1"\n',
  "fm-contributions.sh": 'if [ "$1" = "pending" ]; then echo "[]"; else cat "$2"; fi\n',
  "fm-mail.sh": 'if [ "$1" = "status" ]; then echo "mail-stub:status"; elif [ "$1" = "read" ]; then echo "mail-stub:read"; elif [ "$1" = "send" ]; then cat >/dev/null; echo "mail-stub:sent to $2 subj=$3"; else echo "stub: refused" >&2; exit 1; fi\n',
  "fm_voice_records.py": 'if [ "$1" = "status" ]; then echo "{\\"scope\\":\\"$3\\",\\"workers_on_deck\\":0,\\"in_flight\\":0,\\"queued\\":0}"; elif [ "$1" = "queue" ]; then echo "voice-stub:queued $2"; else echo "stub: refused" >&2; exit 1; fi\n',
  "fm-lint.sh": 'if [ "$1" = "--required-version" ]; then echo "0.11.0"; else exit 1; fi\n',
  "fm-lint-workflows.sh": 'if [ "$1" = "--required-version" ]; then echo "1.7.12"; else exit 1; fi\n',
  "fm-tool-update-check.sh": 'echo "tool-update-stub:check"\n',
  "fm-vendor-auth-probe.sh": 'echo "probe=$1 status=unauthenticated version=none versionVerified=none"\n',
  "fm-startup-memory-budget.sh": 'echo "memory-stub:$1"\n',
  "fm-pr-state.sh": 'echo "pr-stub:$1"\n',
  "fm-x-poll.sh": 'echo "x-poll stub: empty"\n',
  "fm-send.sh": "echo 'stub: no such crew' >&2\nexit 1\n",
  "fm-control.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-spawn.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-brief.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-decision-hold.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-captain-hold.sh": "echo 'stub: refused' >&2\nexit 1\n",
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
      ["peek", "peek", { target: "no-such-id" }],
      ["peek traversal", "peek", { target: "../escape" }],
      ["peek bad lines", "peek", { target: "x", lines: "many" }],
      ["fleet_view", "fleet_view", {}],
      ["review_diff", "review_diff", { id: "no-such-id" }],
      ["review_diff traversal", "review_diff", { id: "../escape" }],
      ["review_diff bad stat", "review_diff", { id: "x", stat: "yes" }],
      ["bearings_snapshot", "bearings_snapshot", {}],
      ["wake_drain", "wake_drain", {}],
      ["guard_check", "guard_check", {}],
      ["remote_doctor", "remote_doctor", {}],
      ["remote_file", "remote_file", { path: "data/probe.txt" }],
      ["remote_file traversal", "remote_file", { path: "../escape" }],
      ["remote_file bad max_bytes", "remote_file", { path: "x", max_bytes: "big" }],
      ["remote_delta", "remote_delta", { log: "state/job.log", offset: 0, sha256: "e".repeat(64) }],
      ["remote_delta traversal", "remote_delta", { log: "../x", offset: 0, sha256: "e".repeat(64) }],
      ["remote_delta bad offset", "remote_delta", { log: "x", offset: -1, sha256: "e".repeat(64) }],
      ["remote_delta bad sha256", "remote_delta", { log: "x", offset: 0, sha256: "short" }],
      ["remote_delta bad wait", "remote_delta", { log: "x", offset: 0, sha256: "e".repeat(64), wait: "long" }],
      ["handoff_status", "handoff_status", {}],
      ["handoff_status traversal", "handoff_status", { id: "../escape" }],
      ["handoff_status missing", "handoff_status", { id: "ghost" }],
      ["handoff_status bad lines", "handoff_status", { lines: "many" }],
      ["nudge no approval", "secondmate_nudge", {}],
      ["nudge stub error", "secondmate_nudge", { approval: APPROVAL }],
      ["restart no approval", "secondmate_restart", { ids: ["m1"] }],
      ["restart bad ids", "secondmate_restart", { ids: ["../x"], approval: APPROVAL }],
      ["restart stub error", "secondmate_restart", { ids: ["m1"], approval: APPROVAL }],
      ["report no approval", "secondmate_report", { verb: "done", corr: "a".repeat(16), note: "ok" }],
      ["report bad corr", "secondmate_report", { verb: "done", corr: "short", note: "ok", approval: APPROVAL }],
      ["report bad verb", "secondmate_report", { verb: "has space", corr: "a".repeat(16), note: "ok", approval: APPROVAL }],
      ["report stub error", "secondmate_report", { verb: "done", corr: "a".repeat(16), note: "ok", approval: APPROVAL }],
      ["remote_control no approval", "remote_control", { verb: "state", id: "m1" }],
      ["remote_control bad verb", "remote_control", { verb: "launch", id: "m1", approval: APPROVAL }],
      ["remote_control send slash", "remote_control", { verb: "send", id: "m1", text: "/raw key", approval: APPROVAL }],
      ["remote_control stub error", "remote_control", { verb: "state", id: "m1", approval: APPROVAL }],
      ["remote_control send stub error", "remote_control", { verb: "send", id: "m1", text: "steady on", approval: APPROVAL }],
      ["handoff no approval", "handoff_move", { id: "m1", keys: ["k1"] }],
      ["handoff bad keys", "handoff_move", { id: "m1", keys: [], approval: APPROVAL }],
      ["handoff bad resume", "handoff_move", { id: "m1", resume: "yes", approval: APPROVAL }],
      ["handoff stub error", "handoff_move", { id: "m1", keys: ["k1"], approval: APPROVAL }],
      ["handoff resume stub error", "handoff_move", { id: "m1", resume: true, approval: APPROVAL }],
      ["harness_detect", "harness_detect", {}],
      ["harness_detect crew", "harness_detect", { mode: "crew" }],
      ["harness_detect bogus", "harness_detect", { mode: "bogus" }],
      ["harness_detect null", "harness_detect", { mode: null }],
      ["project_mode", "project_mode", { project: "myproj" }],
      ["project_mode traversal", "project_mode", { project: "../escape" }],
      ["lock_status", "lock_status", {}],
      ["lease_check held", "lease_check", { id: "leased-task" }],
      ["lease_check unleased", "lease_check", { id: "ghost-task" }],
      ["lease_check traversal", "lease_check", { id: "../escape" }],
      ["bearings_board_path", "bearings_board_path", {}],
      ["inbox_status", "inbox_status", {}],
      ["inbox_list", "inbox_list", {}],
      ["home_summary missing", "home_summary", {}],
      ["contributions_snapshot", "contributions_snapshot", {}],
      ["contributions_snapshot all", "contributions_snapshot", { all: true }],
      ["contributions_snapshot bad all", "contributions_snapshot", { all: "yes" }],
      ["contributions_snapshot null all", "contributions_snapshot", { all: null }],
      ["contributions_pending", "contributions_pending", {}],
      ["mail_status", "mail_status", {}],
      ["mail_read", "mail_read", {}],
      ["mail_send no approval", "mail_send", { to: "a@example.com", subject: "hi", body: "hello" }],
      ["mail_send bad to", "mail_send", { to: "not-an-address", subject: "hi", body: "hello", approval: APPROVAL }],
      ["mail_send bad subject", "mail_send", { to: "a@example.com", subject: "hi\nthere", body: "hello", approval: APPROVAL }],
      ["mail_send empty body", "mail_send", { to: "a@example.com", subject: "hi", body: "", approval: APPROVAL }],
      ["mail_send stub", "mail_send", { to: "a@example.com", subject: "hi", body: "hello via stdin", approval: APPROVAL }],
      ["voice_status", "voice_status", {}],
      ["voice_status full", "voice_status", { scope: "full" }],
      ["voice_status bogus", "voice_status", { scope: "bogus" }],
      ["voice_queue no approval", "voice_queue", { text: "check the fleet" }],
      ["voice_queue multiline", "voice_queue", { text: "one\ntwo", approval: APPROVAL }],
      ["voice_queue stub", "voice_queue", { text: "check the fleet", approval: APPROVAL }],
      ["lint_versions", "lint_versions", {}],
      ["tool_update_check", "tool_update_check", {}],
      ["vendor_auth_probe", "vendor_auth_probe", { probe: "grok" }],
      ["vendor_auth_probe bogus", "vendor_auth_probe", { probe: "bogus" }],
      ["startup_memory", "startup_memory", {}],
      ["startup_memory report", "startup_memory", { mode: "report" }],
      ["startup_memory bogus", "startup_memory", { mode: "bogus" }],
      ["pr_state", "pr_state", { url: "https://github.com/octo/repo/pull/42" }],
      ["pr_state non-github", "pr_state", { url: "https://example.com/o/r/pull/1" }],
      ["pr_state malformed", "pr_state", { url: "not a url" }],
      ["relay_poll", "relay_poll", {}],
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
