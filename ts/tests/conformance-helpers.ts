/**
 * Shared fixtures, stubs, and runner harness for conformance tests.
 *
 * Conformance proves the TS tools behave like firstmate: the same read inputs
 * through the TS tools and through firstmate's real bin/fm-*.sh scripts agree —
 * modulo the result wrap and the `generated` timestamp, which moves every run.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runScript, type RunnerOptions } from "../src/runner.js";
import { TOOLS, type ToolArgs, type ToolContext, type ToolResult } from "../src/tools.js";

export const SNAPSHOT_SCHEMA = "fm-fleet-snapshot.v1";

// Read-only boundary: the only tools this suite may run.
export const READ_TOOLS: ReadonlySet<string> = new Set([
  "fleet_snapshot",
  "backlog",
  "crew_state",
  "status_tail",
  "fleet_poll",
  "peek",
  "fleet_view",
  "review_diff",
  "bearings_snapshot",
  "wake_drain",
  "guard_check",
  "remote_doctor",
  "remote_file",
  "remote_delta",
  "handoff_status",
  "harness_detect",
  "project_mode",
  "lock_status",
  "lease_check",
  "bearings_board_path",
  "inbox_status",
  "inbox_list",
  "home_summary",
  "home_summary_refresh",
  "contributions_snapshot",
  "contributions_pending",
  "mail_status",
  "mail_read",
  "mail_check",
  "voice_status",
  "lint_versions",
  "tool_update_check",
  "vendor_auth_probe",
  "startup_memory",
  "pr_state",
  "relay_poll",
]);

// Scripts the suite may execute. Anything else fails closed at the runner.
export const READ_SCRIPTS: ReadonlySet<string> = new Set([
  "fm-fleet-snapshot.sh",
  "fm-crew-state.sh",
  "fm-peek.sh",
  "fm-fleet-view.sh",
  "fm-review-diff.sh",
  "fm-bearings-snapshot.sh",
  "fm-wake-drain.sh",
  "fm-guard.sh",
  "fm-remote-doctor.sh",
  "fm-remote-file.sh",
  "fm-remote-delta-read.sh",
  "fm-harness.sh",
  "fm-project-mode.sh",
  "fm-lock.sh",
  "fm-lease.sh",
  "fm-bearings-board.sh",
  "fm-inbox.sh",
  "fm-home-summary-refresh.sh",
  "fm-contributions.sh",
  "fm-mail.sh",
  "fm-mail-check.sh",
  "fm_voice_records.py",
  "fm-lint.sh",
  "fm-lint-workflows.sh",
  "fm-tool-update-check.sh",
  "fm-vendor-auth-probe.sh",
  "fm-startup-memory-budget.sh",
  "fm-pr-state.sh",
  "fm-x-poll.sh",
]);

export const SNAPSHOT_STUB = `node -e '
const home = process.env.FM_HOME || "";
process.stdout.write(JSON.stringify({
  schema: "fm-fleet-snapshot.v1",
  generated: "stub",
  fm_home: home,
  roots: { state: home + "/state" },
  backlog: { open: [] },
  tasks: [
    { id: "a", current_state: { state: "working" } },
    { id: "b", current_state: { state: "done" } },
    { id: "c" }
  ],
  main_inventory: null,
}));
'
`;

export const CREW_STATE_STUB = "echo 'state: unknown · source: none · stub: no such crew'\n";
export const PEEK_STUB = 'echo "peek-stub:$1 lines=$2"\n';
export const FLEET_VIEW_STUB = "echo '# Fleet View stub'\n";
export const REVIEW_DIFF_STUB = 'echo "diff-stub:$1 stat=$2"\n';
export const BEARINGS_STUB = `node -e '
process.stdout.write(JSON.stringify({
  schema: "fm-bearings.v1",
  generated: "stub",
  in_flight: [],
  decisions_open: [],
  landed: [],
  omitted: [],
}));
'
`;
export const WAKE_DRAIN_STUB = "echo 'wake-drain stub: empty'\n";
export const GUARD_STUB = "exit 0\n";
export const REMOTE_DOCTOR_STUB = "echo 'doctor-stub: mode=check'\n";
export const REMOTE_FILE_STUB = 'echo "file-stub:$2 max=$3"\n';
export const REMOTE_DELTA_STUB = 'echo "delta-stub:$1 off=$2 wait=$4"\n';
export const HARNESS_STUB = 'echo "harness-stub:$1"\n';
export const PROJECT_MODE_STUB = 'echo "local-only off"\n';
export const LOCK_STUB = "echo 'lock: free'\n";
export const LEASE_STUB =
  'if [ "$1" = "check" ]; then ' +
  'if [ "$2" = "leased-task" ]; then echo "main 4242 1700000000 live"; exit 0; else exit 1; fi; fi\n' +
  "exit 2\n";
export const BEARINGS_BOARD_STUB = 'echo "$FM_HOME/.lavish/bearings-board.html"\n';
export const INBOX_STUB = 'echo "inbox-stub:$1"\n';
export const HOME_SUMMARY_REFRESH_STUB = 'echo "home-summary-refresh-stub:$1"\n';
export const CONTRIBUTIONS_STUB = 'if [ "$1" = "pending" ]; then echo "[]"; else cat "$2"; fi\n';
export const MAIL_STUB =
  'if [ "$1" = "status" ]; then echo "mail-stub:status"; ' +
  'elif [ "$1" = "read" ]; then echo "mail-stub:read"; ' +
  'elif [ "$1" = "send" ]; then cat >/dev/null; echo "mail-stub:sent to $2 subj=$3"; ' +
  'else echo "stub: refused" >&2; exit 1; fi\n';
export const MAIL_CHECK_STUB = 'echo "mail-check-stub:$1"\n';
export const VOICE_RECORDS_STUB =
  'if [ "$1" = "status" ]; then echo "{\\"scope\\":\\"$3\\",\\"workers_on_deck\\":0,\\"in_flight\\":0,\\"queued\\":0}"; ' +
  'elif [ "$1" = "queue" ]; then echo "voice-stub:queued $2"; ' +
  'else echo "stub: refused" >&2; exit 1; fi\n';
export const LINT_STUB = 'if [ "$1" = "--required-version" ]; then echo "0.11.0"; else exit 1; fi\n';
export const LINT_WORKFLOWS_STUB = 'if [ "$1" = "--required-version" ]; then echo "1.7.12"; else exit 1; fi\n';
export const TOOL_UPDATE_STUB = 'echo "tool-update-stub:check"\n';
export const VENDOR_PROBE_STUB = 'echo "probe=$1 status=unauthenticated version=none versionVerified=none"\n';
export const STARTUP_MEMORY_STUB = 'echo "memory-stub:$1"\n';
export const PR_STATE_STUB = 'echo "pr-stub:$1"\n';
export const X_POLL_STUB = 'echo "x-poll stub: empty"\n';
export const HOME_SUMMARY_FIXTURE = {
  schema: "fm-secondmate-home-summary.v1",
  generated: "stub",
  generated_epoch: 1700000000,
  state: "idle",
  counts: {},
};

export interface Call {
  argv: string[];
  script: string;
  fm_home: string | undefined;
}

export interface Fixture {
  scratch: string;
  calls: Call[];
  ctx: ToolContext;
  savedFmHome: string | undefined;
  savedStateOverride: string | undefined;
}

export function writeStub(bin: string, name: string, body: string): void {
  const script = path.join(bin, name);
  fs.writeFileSync(script, "#!/bin/sh\n" + body, "utf8");
  fs.chmodSync(script, 0o755);
}

export function setup(): Fixture {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "fm-ts-conformance-"));
  fs.mkdirSync(path.join(scratch, "bin"));
  fs.mkdirSync(path.join(scratch, "state"));
  writeStub(path.join(scratch, "bin"), "fm-fleet-snapshot.sh", SNAPSHOT_STUB);
  writeStub(path.join(scratch, "bin"), "fm-crew-state.sh", CREW_STATE_STUB);
  writeStub(path.join(scratch, "bin"), "fm-peek.sh", PEEK_STUB);
  writeStub(path.join(scratch, "bin"), "fm-fleet-view.sh", FLEET_VIEW_STUB);
  writeStub(path.join(scratch, "bin"), "fm-review-diff.sh", REVIEW_DIFF_STUB);
  writeStub(path.join(scratch, "bin"), "fm-bearings-snapshot.sh", BEARINGS_STUB);
  writeStub(path.join(scratch, "bin"), "fm-wake-drain.sh", WAKE_DRAIN_STUB);
  writeStub(path.join(scratch, "bin"), "fm-guard.sh", GUARD_STUB);
  writeStub(path.join(scratch, "bin"), "fm-remote-doctor.sh", REMOTE_DOCTOR_STUB);
  writeStub(path.join(scratch, "bin"), "fm-remote-file.sh", REMOTE_FILE_STUB);
  writeStub(path.join(scratch, "bin"), "fm-remote-delta-read.sh", REMOTE_DELTA_STUB);
  writeStub(path.join(scratch, "bin"), "fm-harness.sh", HARNESS_STUB);
  writeStub(path.join(scratch, "bin"), "fm-project-mode.sh", PROJECT_MODE_STUB);
  writeStub(path.join(scratch, "bin"), "fm-lock.sh", LOCK_STUB);
  writeStub(path.join(scratch, "bin"), "fm-lease.sh", LEASE_STUB);
  writeStub(path.join(scratch, "bin"), "fm-bearings-board.sh", BEARINGS_BOARD_STUB);
  writeStub(path.join(scratch, "bin"), "fm-inbox.sh", INBOX_STUB);
  writeStub(path.join(scratch, "bin"), "fm-home-summary-refresh.sh", HOME_SUMMARY_REFRESH_STUB);
  writeStub(path.join(scratch, "bin"), "fm-contributions.sh", CONTRIBUTIONS_STUB);
  writeStub(path.join(scratch, "bin"), "fm-mail.sh", MAIL_STUB);
  writeStub(path.join(scratch, "bin"), "fm-mail-check.sh", MAIL_CHECK_STUB);
  writeStub(path.join(scratch, "bin"), "fm_voice_records.py", VOICE_RECORDS_STUB);
  writeStub(path.join(scratch, "bin"), "fm-lint.sh", LINT_STUB);
  writeStub(path.join(scratch, "bin"), "fm-lint-workflows.sh", LINT_WORKFLOWS_STUB);
  writeStub(path.join(scratch, "bin"), "fm-tool-update-check.sh", TOOL_UPDATE_STUB);
  writeStub(path.join(scratch, "bin"), "fm-vendor-auth-probe.sh", VENDOR_PROBE_STUB);
  writeStub(path.join(scratch, "bin"), "fm-startup-memory-budget.sh", STARTUP_MEMORY_STUB);
  writeStub(path.join(scratch, "bin"), "fm-pr-state.sh", PR_STATE_STUB);
  writeStub(path.join(scratch, "bin"), "fm-x-poll.sh", X_POLL_STUB);

  const savedFmHome = process.env.FM_HOME;
  const savedStateOverride = process.env.FM_STATE_OVERRIDE;
  process.env.FM_HOME = scratch;
  process.env.FM_STATE_OVERRIDE = path.join(scratch, "state");

  const calls: Call[] = [];
  const guardedRun = async (argv: string[], opts: RunnerOptions = {}) => {
    const script = path.basename(String(argv[0]));
    if (!READ_SCRIPTS.has(script)) {
      throw new Error(`conformance must stay read-only: ${script}`);
    }
    calls.push({ argv: argv.map(String), script, fm_home: process.env.FM_HOME });
    return runScript(argv, { ...opts, env: { ...process.env } });
  };
  const ctx: ToolContext = {
    binDir: path.join(scratch, "bin"),
    stateDir: path.join(scratch, "state"),
    dataDir: path.join(scratch, "data"),
    run: guardedRun,
  };
  return { scratch, calls, ctx, savedFmHome, savedStateOverride };
}

export function teardown(fx: Fixture): void {
  if (fx.savedFmHome === undefined) delete process.env.FM_HOME;
  else process.env.FM_HOME = fx.savedFmHome;
  if (fx.savedStateOverride === undefined) delete process.env.FM_STATE_OVERRIDE;
  else process.env.FM_STATE_OVERRIDE = fx.savedStateOverride;
  fs.rmSync(fx.scratch, { recursive: true, force: true });
}

export function directRun(
  fx: Fixture,
  script: string,
  args: string[],
): { stdout: string; status: number | null } {
  try {
    const stdout = execFileSync(path.join(fx.scratch, "bin", script), args, {
      env: { ...process.env },
      encoding: "utf8",
    });
    return { stdout, status: 0 };
  } catch (exc) {
    const err = exc as { stdout?: string; status?: number };
    return { stdout: String(err.stdout ?? ""), status: err.status ?? 1 };
  }
}

export async function readOnlyCall(fx: Fixture, name: string, args: ToolArgs): Promise<ToolResult> {
  if (!READ_TOOLS.has(name)) {
    throw new Error(`conformance dispatches reads only, refused: ${name}`);
  }
  const tool = TOOLS[name];
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return tool.handler(args, fx.ctx);
}

export function okPayload(result: ToolResult): Record<string, unknown> {
  assert.equal(result.isError, false, JSON.stringify(result.payload).slice(0, 300));
  return result.payload;
}
