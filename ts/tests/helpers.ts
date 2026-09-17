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

export const STUBS: Record<string, string> = {
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

// Emulates the real fleet-snapshot envelope: the first call takes >30s (the
// old server timeout) and every call emits >128KB (the old output ceiling)
// of valid snapshot JSON. A marker file short-circuits the sleep after the
// first call so the suite proves the raised envelope without paying 32s per
// tool call. Uses /bin/sleep absolutely (bare `sleep` may be a guard shim).
export const SLOW_LARGE_SNAPSHOT = `if [ ! -e "$FM_HOME/.envelope-slow-shown" ]; then
  : > "$FM_HOME/.envelope-slow-shown"
  /bin/sleep 32
fi
node -e '
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
  writeStub(home, "fm-fleet-snapshot.sh", SLOW_LARGE_SNAPSHOT);
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
