/**
 * Shared stub-home harness + JSON-RPC client for the TS server tests.
 * Mirrors the stub-home pattern test_client.py uses so the TS path is
 * proved standalone with no firstmate checkout required.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export const APPROVAL = "I authorize smarts-only PoC use";

export const SNAPSHOT = {
  schema: "fm-fleet-snapshot.v1",
  generated: "stub",
  backlog: {},
  tasks: [],
};

export const BEARINGS = {
  schema: "fm-bearings.v1",
  generated: "stub",
  in_flight: [],
  decisions_open: [],
  landed: [],
  omitted: [],
};

export const CONTRIBUTION_INPUT = { backlog: {}, tasks: [] as unknown[] };

export const STUBS: Record<string, string> = {
  "fm-fleet-snapshot.sh":
    `if [ "$1" = "--contribution-input" ]; then echo '${JSON.stringify(CONTRIBUTION_INPUT)}'; ` +
    `else echo '${JSON.stringify(SNAPSHOT)}'; fi\n`,
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
  "fm-lease.sh":
    'if [ "$1" = "check" ]; then ' +
    'if [ "$2" = "leased-task" ]; then echo "main 4242 1700000000 live"; exit 0; else exit 1; fi; fi\n' +
    "exit 2\n",
  "fm-bearings-board.sh": 'echo "$FM_HOME/.lavish/bearings-board.html"\n',
  "fm-inbox.sh": 'echo "inbox-stub:$1"\n',
  "fm-home-summary-refresh.sh": 'echo "home-summary-refresh-stub: $1"\n',
  "fm-contributions.sh": 'if [ "$1" = "pending" ]; then echo "[]"; else cat "$2"; fi\n',
  "fm-mail.sh":
    'if [ "$1" = "status" ]; then echo "mail-stub:status"; ' +
    'elif [ "$1" = "read" ]; then echo "mail-stub:read"; ' +
    'elif [ "$1" = "send" ]; then cat >/dev/null; echo "mail-stub:sent to $2 subj=$3"; ' +
    'else echo "stub: refused" >&2; exit 1; fi\n',
  "fm-mail-check.sh": 'echo "mail-check-stub:$1"\n',
  "fm_voice_records.py":
    'if [ "$1" = "status" ]; then echo "{\\"scope\\":\\"$3\\",\\"workers_on_deck\\":0,\\"in_flight\\":0,\\"queued\\":0}"; ' +
    'elif [ "$1" = "queue" ]; then echo "voice-stub:queued $2"; ' +
    'else echo "stub: refused" >&2; exit 1; fi\n',
  "fm-lint.sh": 'if [ "$1" = "--required-version" ]; then echo "0.11.0"; else exit 1; fi\n',
  "fm-lint-workflows.sh": 'if [ "$1" = "--required-version" ]; then echo "1.7.12"; else exit 1; fi\n',
  "fm-tool-update-check.sh": 'echo "tool-update-stub:check"\n',
  "fm-vendor-auth-probe.sh": 'echo "probe=$1 status=unauthenticated version=none versionVerified=none"\n',
  "fm-startup-memory-budget.sh": 'echo "memory-stub:$1"\n',
  "fm-pr-state.sh": 'echo "pr-stub:$1"\n',
  "fm-pr-poll.sh": 'echo "pr-poll-stub:$1 $2 $3"\n',
  "fm-x-poll.sh": 'echo "x-poll stub: empty"\n',
  "fm-public-followup.sh": 'echo "public-followup-stub:$1"\n',
  "fm-public-followup-collect.sh": 'echo "public-followup-collect-stub:$1 id=$2"\n',
  "fm-public-followup-emit.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-x-link.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-fleet-sync.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-inactive-reconcile.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-send.sh": "echo 'stub: no such crew' >&2\nexit 1\n",
  "fm-control.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-spawn.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-brief.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-decision-hold.sh":
    'if [ "$1" = "hold" ]; then echo "held: $2-decision-$3"; exit 0; ' +
    'elif [ "$1" = "resolve" ]; then echo "resolved: $2-decision-$3 -> $7"; exit 0; ' +
    'elif [ "$1" = "complete" ]; then echo "complete: $2"; exit 0; ' +
    'elif [ "$1" = "verify" ]; then echo "verified: $2"; exit 0; ' +
    'else echo "stub: refused" >&2; exit 1; fi\n',
  "fm-captain-hold.sh":
    'if [ "$1" = "answer" ]; then ' +
    'if [ "$4" = "--release" ] || [ "$5" = "--release" ]; then echo "released: $2"; exit 0; ' +
    'else echo "answered: $2"; exit 0; fi; ' +
    'elif [ "$1" = "complete" ]; then echo "complete: $2"; exit 0; ' +
    'elif [ "$1" = "verify" ]; then echo "verified: $2"; exit 0; ' +
    'elif [ "$1" = "open" ]; then ' +
    'if [ "$2" = "closed-task" ]; then exit 1; ' +
    'elif [ "$2" = "absent-task" ]; then exit 3; ' +
    'elif [ "$3" = "--identity" ]; then echo "2026-09-20T00:00:00Z 1"; exit 0; ' +
    'else exit 0; fi; ' +
    'elif [ "$1" = "diverged" ]; then echo "task-1\torigin-1\tk1\tDiverged title"; exit 0; ' +
    'else echo "stub: captain-hold $1 $2" >&2; exit 1; fi\n',
  "fm-tasks-axi.sh":
    'if [ "$1" = "show" ]; then ' +
    'if [ "$2" = "agent-hold" ]; then echo "  id: agent-hold\n  body: Origin: test-agent\n"; exit 0; ' +
    'elif [ "$2" = "captain-hold" ]; then echo "  id: captain-hold\n  body: No origin here\n"; exit 0; ' +
    'else echo "  id: $2\n"; exit 0; fi; ' +
    'elif [ "$1" = "unblock" ]; then echo "unblocked: $2 by $4"; exit 0; ' +
    'elif [ "$1" = "list" ]; then echo "tasks-axi-stub: list\n"; exit 0; ' +
    'elif [ "$1" = "ready" ]; then echo "tasks-axi-stub: ready\n"; exit 0; ' +
    'fi\n' +
    'echo "tasks-axi-stub: ok"\n',
  "fm-backlog-receive.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-x-reply.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-x-dismiss.sh": "echo 'stub: refused' >&2\nexit 1\n",
  "fm-x-followup.sh": "echo 'stub: refused' >&2\nexit 1\n",
};

// Emulates the real fleet-snapshot envelope: the first call takes >30s (the
// old server timeout) and every call emits >128KB (the old output ceiling)
// of valid snapshot JSON. A marker file short-circuits the sleep after the
// first call so the suite proves the raised envelope without paying 32s per
// tool call. Uses /bin/sleep absolutely (bare `sleep` may be a guard shim).
//
// The payload generator runs on the same runtime executing the suite
// (process.execPath: node under `node --test`, bun under `bun test` via
// `bun -e`), so the envelope proof holds on both runtimes with no node
// dependency in the bun path.
export function slowLargeSnapshot(): string {
  return `if [ ! -e "$FM_HOME/.envelope-slow-shown" ]; then
  : > "$FM_HOME/.envelope-slow-shown"
  /bin/sleep 32
fi
"${process.execPath}" -e '
const tasks = [];
for (let i = 0; i < 800; i++) {
  tasks.push({
    task_id: "task-" + String(i).padStart(4, "0"),
    current_state: { state: "running" },
    note: "envelope-fixture-" + "x".repeat(380),
  });
}
process.stdout.write(JSON.stringify({
  schema: "fm-fleet-snapshot.v1",
  generated: "envelope-slow-large",
  backlog: {},
  tasks,
}));
'
`;
}

function writeStub(home: string, name: string, body: string): void {
  const script = path.join(home, "bin", name);
  fs.writeFileSync(script, "#!/bin/sh\n" + body, "utf8");
  fs.chmodSync(script, 0o755);
}

export function makeStubHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fm-mcp-ts-stub-"));
  fs.mkdirSync(path.join(home, "bin"));
  for (const [name, body] of Object.entries(STUBS)) writeStub(home, name, body);
  fs.mkdirSync(path.join(home, "state"));
  return home;
}

export function makeEnvelopeStubHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fm-mcp-ts-envelope-"));
  fs.mkdirSync(path.join(home, "bin"));
  for (const [name, body] of Object.entries(STUBS)) writeStub(home, name, body);
  writeStub(home, "fm-fleet-snapshot.sh", slowLargeSnapshot());
  fs.mkdirSync(path.join(home, "state"));
  return home;
}

// Slow snapshot that also spawns a grandchild outliving the 30s budget: if
// the server kills only the child instead of the whole process group, the
// orphan touches the marker after the timeout and the kill proof fails.
export function makeOrphanStubHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fm-mcp-ts-orphan-"));
  fs.mkdirSync(path.join(home, "bin"));
  for (const [name, body] of Object.entries(STUBS)) writeStub(home, name, body);
  writeStub(
    home,
    "fm-fleet-snapshot.sh",
    `rm -f "$FM_HOME/orphan-marker"
( /bin/sleep 34; touch "$FM_HOME/orphan-marker" ) >/dev/null 2>&1 &
` + slowLargeSnapshot(),
  );
  fs.mkdirSync(path.join(home, "state"));
  return home;
}

export function makeReceiptStubHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fm-mcp-ts-receipt-"));
  fs.mkdirSync(path.join(home, "bin"));
  for (const [name, body] of Object.entries(STUBS)) writeStub(home, name, body);
  writeStub(home, "fm-fleet-snapshot.sh", slowLargeSnapshot());
  fs.mkdirSync(path.join(home, "state"));
  return home;
}

export function makeTasksStubHome(taskCount: number = 5): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fm-mcp-ts-tasks-"));
  fs.mkdirSync(path.join(home, "bin"));
  for (const [name, body] of Object.entries(STUBS)) writeStub(home, name, body);
  const tasks = [];
  for (let i = 0; i < taskCount; i++) {
    tasks.push({
      task_id: `task-${String(i).padStart(3, "0")}`,
      current_state: { state: i % 2 === 0 ? "in_flight" : "queued" },
      title: `Task ${i}`,
    });
  }
  const snapshotData = {
    schema: "fm-fleet-snapshot.v1",
    generated: "2026-09-21T12:00:00Z",
    rev: "rev-test-1",
    backlog: { path: "data/backlog.md", present: true, records: [] },
    tasks,
  };
  writeStub(
    home,
    "fm-fleet-snapshot.sh",
    `echo '${JSON.stringify(snapshotData)}'\n`,
  );
  fs.mkdirSync(path.join(home, "state"));
  return home;
}

/** Path to the built TS server under test (dist/, compiled from src/). */
export function serverEntry(): string {
  // testbuild/tests/helpers.js -> ts/testbuild/tests/helpers.js;
  // server lives at ts/dist/server.js.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "dist", "server.js");
}

export interface RpcResponse {
  jsonrpc: string;
  id?: number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export class Client {
  private proc: ChildProcess;
  private rl: readline.Interface;
  private seq = 0;
  private queue: Array<(line: string) => void> = [];
  private buffer: string[] = [];

  constructor(env: Record<string, string>) {
    this.proc = spawn(process.execPath, [serverEntry()], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    this.rl = readline.createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line) => {
      const next = this.queue.shift();
      if (next) next(line);
      else this.buffer.push(line);
    });
  }

  private nextLine(): Promise<string> {
    const ready = this.buffer.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise((resolve) => this.queue.push(resolve));
  }

  async request(method: string, params?: unknown): Promise<RpcResponse> {
    this.seq += 1;
    const msg: Record<string, unknown> = { jsonrpc: "2.0", id: this.seq, method };
    if (params !== undefined) msg["params"] = params;
    this.proc.stdin!.write(JSON.stringify(msg) + "\n");
    return JSON.parse(await this.nextLine()) as RpcResponse;
  }

  notify(method: string): void {
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }

  async call(name: string, args: Record<string, unknown>): Promise<RpcResponse> {
    return this.request("tools/call", { name, arguments: args });
  }

  async close(): Promise<void> {
    this.proc.stdin!.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.proc.kill("SIGKILL");
        } catch {
          /* gone */
        }
        resolve();
      }, 10000);
      this.proc.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.rl.close();
  }
}

export function payload(resp: RpcResponse): Record<string, unknown> {
  const content = (resp.result as Record<string, unknown>)["content"] as Array<{
    text: string;
  }>;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

export function isError(resp: RpcResponse): boolean {
  return (resp.result as Record<string, unknown>)?.["isError"] === true;
}

export function removeHome(home: string): void {
  fs.rmSync(home, { recursive: true, force: true });
}
