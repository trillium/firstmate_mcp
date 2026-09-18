/**
 * Conformance fixtures: prove the TS tools behave like firstmate.
 *
 * Preserved-provenance suite: mirrors tests/conformance/test_conformance.py
 * (the upstream equivalence proof for the Python path). The same read inputs
 * through the TS tools and through firstmate's real bin/fm-*.sh scripts
 * agree — modulo the result wrap and the `generated` timestamp, which moves
 * every run.
 *
 * Hermetic: stub scripts stand in for the owning scripts (no live checkout
 * required), served from a scratch FM_HOME that is never the live fleet.
 * Stricter-is-conformant holds in the same direction: traversal ids are
 * refused before any process starts.
 *
 * Side-effect-free by construction: only read tools run, every subprocess
 * carries FM_HOME=<scratch>, and the guarded runner refuses any script
 * outside the read-script set (snapshot, crew-state, peek, fleet-view,
 * review-diff, bearings-snapshot, wake-drain, guard, remote-doctor,
 * remote-file, remote-delta, harness, project-mode, lock, lease,
 * bearings-board, inbox, contributions).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runScript, type RunnerOptions } from "../src/runner.js";
import { TOOLS, type ToolArgs, type ToolContext, type ToolResult } from "../src/tools.js";

const SNAPSHOT_SCHEMA = "fm-fleet-snapshot.v1";

// Read-only boundary: the only tools this suite may run.
const READ_TOOLS: ReadonlySet<string> = new Set([
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
  "contributions_snapshot",
  "contributions_pending",
  "mail_status",
  "mail_read",
  "voice_status",
  "lint_versions",
  "tool_update_check",
  "vendor_auth_probe",
  "startup_memory",
  "pr_state",
  "relay_poll",
]);

// Scripts the suite may execute. Anything else fails closed at the runner.
const READ_SCRIPTS: ReadonlySet<string> = new Set([
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
  "fm-contributions.sh",
  "fm-mail.sh",
  "fm_voice_records.py",
  "fm-lint.sh",
  "fm-lint-workflows.sh",
  "fm-tool-update-check.sh",
  "fm-vendor-auth-probe.sh",
  "fm-startup-memory-budget.sh",
  "fm-pr-state.sh",
  "fm-x-poll.sh",
]);

const SNAPSHOT_STUB = `node -e '
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

const CREW_STATE_STUB = "echo 'state: unknown · source: none · stub: no such crew'\n";

const PEEK_STUB = 'echo "peek-stub:$1 lines=$2"\n';
const FLEET_VIEW_STUB = "echo '# Fleet View stub'\n";
const REVIEW_DIFF_STUB = 'echo "diff-stub:$1 stat=$2"\n';
const BEARINGS_STUB = `node -e '
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
const WAKE_DRAIN_STUB = "echo 'wake-drain stub: empty'\n";
const GUARD_STUB = "exit 0\n";
const REMOTE_DOCTOR_STUB = "echo 'doctor-stub: mode=check'\n";
const REMOTE_FILE_STUB = 'echo "file-stub:$2 max=$3"\n';
const REMOTE_DELTA_STUB = 'echo "delta-stub:$1 off=$2 wait=$4"\n';
const HARNESS_STUB = 'echo "harness-stub:$1"\n';
const PROJECT_MODE_STUB = 'echo "local-only off"\n';
const LOCK_STUB = "echo 'lock: free'\n";
const LEASE_STUB =
  'if [ "$1" = "check" ]; then ' +
  'if [ "$2" = "leased-task" ]; then echo "main 4242 1700000000 live"; exit 0; else exit 1; fi; fi\n' +
  "exit 2\n";
const BEARINGS_BOARD_STUB = 'echo "$FM_HOME/.lavish/bearings-board.html"\n';
const INBOX_STUB = 'echo "inbox-stub:$1"\n';
const CONTRIBUTIONS_STUB = 'if [ "$1" = "pending" ]; then echo "[]"; else cat "$2"; fi\n';
const MAIL_STUB =
  'if [ "$1" = "status" ]; then echo "mail-stub:status"; ' +
  'elif [ "$1" = "read" ]; then echo "mail-stub:read"; ' +
  'elif [ "$1" = "send" ]; then cat >/dev/null; echo "mail-stub:sent to $2 subj=$3"; ' +
  'else echo "stub: refused" >&2; exit 1; fi\n';
const VOICE_RECORDS_STUB =
  'if [ "$1" = "status" ]; then echo "{\\"scope\\":\\"$3\\",\\"workers_on_deck\\":0,\\"in_flight\\":0,\\"queued\\":0}"; ' +
  'elif [ "$1" = "queue" ]; then echo "voice-stub:queued $2"; ' +
  'else echo "stub: refused" >&2; exit 1; fi\n';
const LINT_STUB = 'if [ "$1" = "--required-version" ]; then echo "0.11.0"; else exit 1; fi\n';
const LINT_WORKFLOWS_STUB = 'if [ "$1" = "--required-version" ]; then echo "1.7.12"; else exit 1; fi\n';
const TOOL_UPDATE_STUB = 'echo "tool-update-stub:check"\n';
const VENDOR_PROBE_STUB = 'echo "probe=$1 status=unauthenticated version=none versionVerified=none"\n';
const STARTUP_MEMORY_STUB = 'echo "memory-stub:$1"\n';
const PR_STATE_STUB = 'echo "pr-stub:$1"\n';
const X_POLL_STUB = 'echo "x-poll stub: empty"\n';
const HOME_SUMMARY_FIXTURE = {
  schema: "fm-secondmate-home-summary.v1",
  generated: "stub",
  generated_epoch: 1700000000,
  state: "idle",
  counts: {},
};

interface Call {
  argv: string[];
  script: string;
  fm_home: string | undefined;
}

interface Fixture {
  scratch: string;
  calls: Call[];
  ctx: ToolContext;
  savedFmHome: string | undefined;
  savedStateOverride: string | undefined;
}

function writeStub(bin: string, name: string, body: string): void {
  const script = path.join(bin, name);
  fs.writeFileSync(script, "#!/bin/sh\n" + body, "utf8");
  fs.chmodSync(script, 0o755);
}

function setup(): Fixture {
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
  writeStub(path.join(scratch, "bin"), "fm-contributions.sh", CONTRIBUTIONS_STUB);
  writeStub(path.join(scratch, "bin"), "fm-mail.sh", MAIL_STUB);
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

function teardown(fx: Fixture): void {
  if (fx.savedFmHome === undefined) delete process.env.FM_HOME;
  else process.env.FM_HOME = fx.savedFmHome;
  if (fx.savedStateOverride === undefined) delete process.env.FM_STATE_OVERRIDE;
  else process.env.FM_STATE_OVERRIDE = fx.savedStateOverride;
  fs.rmSync(fx.scratch, { recursive: true, force: true });
}

function directRun(fx: Fixture, script: string, args: string[]): { stdout: string; status: number | null } {
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

async function readOnlyCall(fx: Fixture, name: string, args: ToolArgs): Promise<ToolResult> {
  if (!READ_TOOLS.has(name)) {
    throw new Error(`conformance dispatches reads only, refused: ${name}`);
  }
  const tool = TOOLS[name];
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return tool.handler(args, fx.ctx);
}

function okPayload(result: ToolResult): Record<string, unknown> {
  assert.equal(result.isError, false, JSON.stringify(result.payload).slice(0, 300));
  return result.payload;
}

describe("snapshot equivalence", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setup();
  });
  afterEach(() => teardown(fx));

  it("fleet_snapshot matches direct", async () => {
    const direct = JSON.parse(directRun(fx, "fm-fleet-snapshot.sh", ["--json"]).stdout) as Record<
      string,
      unknown
    >;
    const snap = okPayload(await readOnlyCall(fx, "fleet_snapshot", {}));
    assert.equal(snap["schema"], SNAPSHOT_SCHEMA);
    assert.equal(snap["schema"], direct["schema"]);
    assert.deepEqual(snap["tasks"], direct["tasks"]);
    assert.deepEqual(snap["backlog"], direct["backlog"]);
    assert.deepEqual(snap["main_inventory"], direct["main_inventory"]);
  });

  it("backlog derives counts from the same snapshot", async () => {
    const direct = JSON.parse(directRun(fx, "fm-fleet-snapshot.sh", ["--json"]).stdout) as Record<
      string,
      unknown
    >;
    const result = okPayload(await readOnlyCall(fx, "backlog", {}));
    const byState: Record<string, number> = {};
    for (const task of (direct["tasks"] as Array<Record<string, unknown>>) ?? []) {
      const state =
        ((task["current_state"] as Record<string, unknown> | undefined)?.["state"] as string) ||
        "unknown";
      byState[state] = (byState[state] ?? 0) + 1;
    }
    assert.equal(
      ((result["task_counts"] as Record<string, unknown>)["total"] as number),
      ((direct["tasks"] as unknown[]) ?? []).length,
    );
    assert.deepEqual(
      (result["task_counts"] as Record<string, unknown>)["by_state"],
      byState,
    );
    assert.deepEqual(result["backlog"], direct["backlog"]);
  });

  it("fleet_poll agrees with snapshot", async () => {
    const direct = JSON.parse(directRun(fx, "fm-fleet-snapshot.sh", ["--json"]).stdout) as Record<
      string,
      unknown
    >;
    const result = okPayload(await readOnlyCall(fx, "fleet_poll", { count: 2, interval_s: 0 }));
    const polls = result["polls"] as Array<Record<string, unknown>>;
    assert.equal(polls.length, 2);
    for (const poll of polls) {
      assert.equal(poll["tasks"], ((direct["tasks"] as unknown[]) ?? []).length);
    }
  });
});

describe("crew-state equivalence", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setup();
  });
  afterEach(() => teardown(fx));

  it("crew_state unknown matches direct line", async () => {
    const directLine = directRun(fx, "fm-crew-state.sh", ["no-such-crew"]).stdout.trim().split("\n")[0];
    const result = okPayload(await readOnlyCall(fx, "crew_state", { id: "no-such-crew" }));
    assert.equal(result["raw"], directLine);
    assert.equal((result["current"] as Record<string, string>)["state"], "unknown");
    assert.ok(directLine.includes("unknown"));
  });

  it("adapter stricter than script on traversal", async () => {
    const before = fx.calls.length;
    const result = await readOnlyCall(fx, "crew_state", { id: "../escape" });
    assert.equal(result.isError, true);
    assert.equal((result.payload["error"] as string), "invalid id");
    assert.equal(fx.calls.length, before, "rejected input must not spawn a process");
  });
});

describe("status-tail equivalence", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setup();
  });
  afterEach(() => teardown(fx));

  it("status_tail matches file tail", async () => {
    const lines = [1, 2, 3, 4, 5, 6, 7].map((i) => `event-${i}: working`);
    fs.writeFileSync(path.join(fx.scratch, "state", "t1.status"), lines.join("\n") + "\n", "utf8");
    const result = okPayload(await readOnlyCall(fx, "status_tail", { id: "t1", lines: 3 }));
    assert.deepEqual(result["events"], lines.slice(-3));
    assert.ok("warning" in result);
  });

  it("status_tail missing id is a structured error", async () => {
    const result = await readOnlyCall(fx, "status_tail", { id: "ghost-crew" });
    assert.equal(result.isError, true);
    assert.equal((result.payload["error"] as string), "no status log for id");
  });

  it("status_tail rejects traversal without read", async () => {
    fs.writeFileSync(path.join(fx.scratch, "state", "t1.status"), "x\n", "utf8");
    const result = await readOnlyCall(fx, "status_tail", { id: "../escape" });
    assert.equal(result.isError, true);
    assert.equal(fx.calls.length, 0, "status_tail must never spawn a process");
  });
});

describe("diagnostic-read equivalence", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setup();
  });
  afterEach(() => teardown(fx));

  it("peek matches direct stub", async () => {
    const direct = directRun(fx, "fm-peek.sh", ["no-such-crew", "5"]);
    const result = okPayload(await readOnlyCall(fx, "peek", { target: "no-such-crew", lines: 5 }));
    assert.ok((result["stdout"] as string).includes("peek-stub:no-such-crew"));
    assert.equal(result["target"], "no-such-crew");
    assert.equal(result["lines"], 5);
    assert.equal(direct.status, 0);
  });

  it("peek refuses traversal without spawn", async () => {
    const before = fx.calls.length;
    const result = await readOnlyCall(fx, "peek", { target: "../escape" });
    assert.equal(result.isError, true);
    assert.equal(fx.calls.length, before);
  });

  it("fleet_view matches direct stub", async () => {
    const direct = directRun(fx, "fm-fleet-view.sh", []);
    const result = okPayload(await readOnlyCall(fx, "fleet_view", {}));
    assert.equal((result["stdout"] as string).trim(), direct.stdout.trim());
  });

  it("review_diff matches direct stub", async () => {
    const result = okPayload(await readOnlyCall(fx, "review_diff", { id: "no-such-crew" }));
    assert.equal(result["id"], "no-such-crew");
    assert.ok((result["stdout"] as string).includes("diff-stub:no-such-crew"));
  });

  it("review_diff refuses traversal without spawn", async () => {
    const before = fx.calls.length;
    const result = await readOnlyCall(fx, "review_diff", { id: "../escape" });
    assert.equal(result.isError, true);
    assert.equal(fx.calls.length, before);
  });

  it("bearings matches direct stub", async () => {
    const direct = JSON.parse(directRun(fx, "fm-bearings-snapshot.sh", ["--json"]).stdout) as Record<string, unknown>;
    const result = okPayload(await readOnlyCall(fx, "bearings_snapshot", {}));
    assert.equal(result["schema"], "fm-bearings.v1");
    assert.deepEqual(result["in_flight"], direct["in_flight"]);
    assert.deepEqual(result["omitted"], direct["omitted"]);
  });

  it("wake_drain matches direct stub", async () => {
    const direct = directRun(fx, "fm-wake-drain.sh", []);
    const result = okPayload(await readOnlyCall(fx, "wake_drain", {}));
    assert.equal((result["stdout"] as string).trim(), direct.stdout.trim());
  });

  it("guard_check matches direct stub read-only", async () => {
    const result = okPayload(await readOnlyCall(fx, "guard_check", {}));
    assert.ok("stdout" in result);
  });
});

describe("secondmate-remote-read equivalence", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setup();
  });
  afterEach(() => teardown(fx));

  it("remote_doctor matches direct stub", async () => {
    const direct = directRun(fx, "fm-remote-doctor.sh", []);
    const result = okPayload(await readOnlyCall(fx, "remote_doctor", {}));
    assert.equal((result["stdout"] as string).trim(), direct.stdout.trim());
    assert.equal(direct.status, 0);
  });

  it("remote_file get matches direct stub", async () => {
    const direct = directRun(fx, "fm-remote-file.sh", ["get", "data/probe.txt", "8192"]);
    const result = okPayload(await readOnlyCall(fx, "remote_file", { path: "data/probe.txt" }));
    assert.ok((result["stdout"] as string).includes("file-stub:data/probe.txt"));
    assert.equal(result["path"], "data/probe.txt");
    assert.equal(result["max_bytes"], 8192);
    assert.equal(direct.status, 0);
  });

  it("remote_file refuses traversal without spawn", async () => {
    const before = fx.calls.length;
    const result = await readOnlyCall(fx, "remote_file", { path: "../escape" });
    assert.equal(result.isError, true);
    assert.equal(fx.calls.length, before);
  });

  it("remote_delta matches direct stub", async () => {
    const sha = "e".repeat(64);
    const direct = directRun(fx, "fm-remote-delta-read.sh", ["state/job.log", "0", sha, "0"]);
    const result = okPayload(
      await readOnlyCall(fx, "remote_delta", { log: "state/job.log", offset: 0, sha256: sha }),
    );
    assert.ok((result["stdout"] as string).includes("delta-stub:state/job.log"));
    assert.equal(result["log"], "state/job.log");
    assert.equal(result["offset"], 0);
    assert.equal(direct.status, 0);
  });

  it("remote_delta refuses bad cursor without spawn", async () => {
    const before = fx.calls.length;
    const sha = "e".repeat(64);
    const good = { log: "state/job.log", offset: 0, sha256: sha };
    for (const [key, value] of [
      ["log", "../x"],
      ["offset", -1],
      ["sha256", "short"],
      ["wait", "long"],
    ] as Array<[string, unknown]>) {
      const result = await readOnlyCall(fx, "remote_delta", { ...good, [key]: value });
      assert.equal(result.isError, true, key);
    }
    assert.equal(fx.calls.length, before);
  });

  it("handoff_status lists staged outboxes", async () => {
    const handoff = path.join(fx.scratch, "data", "handoff");
    fs.mkdirSync(handoff, { recursive: true });
    fs.writeFileSync(path.join(handoff, "m1.outbox.md"), "- [ ] k1 first\n- [ ] k2 second\n", "utf8");
    fs.writeFileSync(path.join(handoff, "notes.txt"), "ignored\n", "utf8");
    const result = okPayload(await readOnlyCall(fx, "handoff_status", {}));
    assert.equal((result["outboxes"] as unknown[]).length, 1);
    assert.equal((result["outboxes"] as Array<Record<string, unknown>>)[0]["id"], "m1");
    assert.equal(fx.calls.length, 0, "handoff_status must never spawn a process");
  });

  it("handoff_status detail matches file tail", async () => {
    const handoff = path.join(fx.scratch, "data", "handoff");
    fs.mkdirSync(handoff, { recursive: true });
    const lines = ["- [ ] k1 first", "- [ ] k2 second", "- [ ] k3 third"];
    fs.writeFileSync(path.join(handoff, "m1.outbox.md"), lines.join("\n") + "\n", "utf8");
    const result = okPayload(await readOnlyCall(fx, "handoff_status", { id: "m1", lines: 2 }));
    assert.deepEqual(result["lines"], lines.slice(-2));
    assert.equal(result["total_lines"], 3);
  });

  it("handoff_status missing id is a structured error", async () => {
    fs.mkdirSync(path.join(fx.scratch, "data", "handoff"), { recursive: true });
    const result = await readOnlyCall(fx, "handoff_status", { id: "ghost" });
    assert.equal(result.isError, true);
    assert.equal(result.payload["error"], "no handoff for id");
  });

  it("handoff_status rejects traversal without read", async () => {
    const result = await readOnlyCall(fx, "handoff_status", { id: "../escape" });
    assert.equal(result.isError, true);
    assert.equal(fx.calls.length, 0, "handoff_status must never spawn a process");
  });
});

describe("session-read equivalence", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setup();
  });
  afterEach(() => teardown(fx));

  it("harness_detect echoes the mode and the script line", async () => {
    const direct = directRun(fx, "fm-harness.sh", []);
    const result = okPayload(await readOnlyCall(fx, "harness_detect", {}));
    assert.equal(result["mode"], "own");
    assert.equal(result["stdout"], direct.stdout);
    assert.equal(result["harness"], direct.stdout.trim().split("\n")[0]);
    const crewed = okPayload(await readOnlyCall(fx, "harness_detect", { mode: "crew" }));
    assert.equal(crewed["mode"], "crew");
    assert.ok((crewed["stdout"] as string).includes("harness-stub:crew"));
  });

  it("harness_detect refuses unknown modes without spawn", async () => {
    const before = fx.calls.length;
    const result = await readOnlyCall(fx, "harness_detect", { mode: "ancestry" });
    assert.equal(result.isError, true);
    assert.equal(result.payload["error"], "invalid mode");
    assert.equal(fx.calls.length, before);
  });

  it("project_mode matches direct stub", async () => {
    const direct = directRun(fx, "fm-project-mode.sh", ["myproj"]);
    assert.equal(direct.status, 0);
    const result = okPayload(await readOnlyCall(fx, "project_mode", { project: "myproj" }));
    assert.equal(result["project"], "myproj");
    assert.equal(result["stdout"], direct.stdout);
    assert.equal(result["mode"], "local-only");
    assert.equal(result["yolo"], "off");
  });

  it("project_mode refuses traversal without spawn", async () => {
    const before = fx.calls.length;
    const result = await readOnlyCall(fx, "project_mode", { project: "../escape" });
    assert.equal(result.isError, true);
    assert.equal(result.payload["error"], "invalid project");
    assert.equal(fx.calls.length, before);
  });

  it("lock_status matches direct stub", async () => {
    const direct = directRun(fx, "fm-lock.sh", ["status"]);
    assert.equal(direct.status, 0);
    const result = okPayload(await readOnlyCall(fx, "lock_status", {}));
    assert.equal(result["status"], "free");
    assert.equal(result["stdout"], direct.stdout);
  });

  it("lease_check projects held and unleased", async () => {
    const held = okPayload(await readOnlyCall(fx, "lease_check", { id: "leased-task" }));
    assert.equal(held["leased"], true);
    assert.equal(held["actor"], "main");
    assert.equal(held["pid"], 4242);
    assert.equal(held["live"], true);
    const free = okPayload(await readOnlyCall(fx, "lease_check", { id: "ghost-task" }));
    assert.equal(free["leased"], false);
  });

  it("lease_check refuses traversal without spawn", async () => {
    const before = fx.calls.length;
    const result = await readOnlyCall(fx, "lease_check", { id: "../escape" });
    assert.equal(result.isError, true);
    assert.equal(result.payload["error"], "invalid id");
    assert.equal(fx.calls.length, before);
  });
});

describe("digest-read equivalence", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setup();
  });
  afterEach(() => teardown(fx));

  it("bearings_board_path matches direct stub", async () => {
    const direct = directRun(fx, "fm-bearings-board.sh", ["path"]);
    assert.equal(direct.status, 0);
    const result = okPayload(await readOnlyCall(fx, "bearings_board_path", {}));
    assert.equal(result["path"], direct.stdout.trim());
    assert.ok((result["path"] as string).endsWith("bearings-board.html"));
  });

  it("inbox_status and inbox_list match direct stubs", async () => {
    const statusDirect = directRun(fx, "fm-inbox.sh", ["status"]);
    const status = okPayload(await readOnlyCall(fx, "inbox_status", {}));
    assert.equal(status["stdout"], statusDirect.stdout);
    const listDirect = directRun(fx, "fm-inbox.sh", ["list"]);
    const listed = okPayload(await readOnlyCall(fx, "inbox_list", {}));
    assert.equal(listed["stdout"], listDirect.stdout);
  });

  it("home_summary matches the ledger without spawning", async () => {
    fs.writeFileSync(
      path.join(fx.scratch, "state", "home-summary.json"),
      JSON.stringify(HOME_SUMMARY_FIXTURE),
      "utf8",
    );
    const before = fx.calls.length;
    const result = okPayload(await readOnlyCall(fx, "home_summary", {}));
    assert.deepEqual({ ...result }, { ...HOME_SUMMARY_FIXTURE });
    assert.equal(fx.calls.length, before, "home_summary must never spawn a process");
  });

  it("home_summary without a ledger is a structured error", async () => {
    const result = await readOnlyCall(fx, "home_summary", {});
    assert.equal(result.isError, true);
    assert.equal(result.payload["error"], "no home summary");
  });

  it("contributions_snapshot stages contribution-input", async () => {
    const result = okPayload(await readOnlyCall(fx, "contributions_snapshot", {}));
    assert.equal(result["all"], false);
    const staged = fx.calls.find((call) => call.argv.includes("--contribution-input"));
    assert.ok(staged, "snapshot input must come from --contribution-input");
    assert.ok(staged.script === "fm-fleet-snapshot.sh");
  });

  it("contributions_snapshot echoes the all flag", async () => {
    const result = okPayload(await readOnlyCall(fx, "contributions_snapshot", { all: true }));
    assert.equal(result["all"], true);
  });

  it("contributions_snapshot refuses non-bool all without spawn", async () => {
    const before = fx.calls.length;
    const result = await readOnlyCall(fx, "contributions_snapshot", { all: "yes" });
    assert.equal(result.isError, true);
    assert.equal(result.payload["error"], "invalid all");
    assert.equal(fx.calls.length, before);
  });

  it("contributions_pending matches direct stub", async () => {
    const direct = directRun(fx, "fm-contributions.sh", ["pending"]);
    assert.equal(direct.status, 0);
    const result = okPayload(await readOnlyCall(fx, "contributions_pending", {}));
    assert.deepEqual(result["pending"], JSON.parse(direct.stdout));
  });
});

describe("mail equivalence", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setup();
  });
  afterEach(() => teardown(fx));

  it("mail_status matches direct stub", async () => {
    const direct = directRun(fx, "fm-mail.sh", ["status"]);
    assert.equal(direct.status, 0);
    const result = okPayload(await readOnlyCall(fx, "mail_status", {}));
    assert.equal(result["stdout"], direct.stdout);
  });

  it("mail_read matches direct stub with a never-marks-seen warning", async () => {
    const direct = directRun(fx, "fm-mail.sh", ["read"]);
    assert.equal(direct.status, 0);
    const result = okPayload(await readOnlyCall(fx, "mail_read", {}));
    assert.equal(result["stdout"], direct.stdout);
    assert.ok(String(result["warning"] ?? "").includes("BODY.PEEK"));
  });
});

describe("voice equivalence", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setup();
  });
  afterEach(() => teardown(fx));

  it("voice_status defaults to counts", async () => {
    const result = okPayload(await readOnlyCall(fx, "voice_status", {}));
    assert.equal(result["scope"], "counts");
  });

  it("voice_status passes the full scope through", async () => {
    const result = okPayload(await readOnlyCall(fx, "voice_status", { scope: "full" }));
    assert.equal(result["scope"], "full");
  });

  it("voice_status refuses unknown scopes without spawn", async () => {
    const before = fx.calls.length;
    const result = await readOnlyCall(fx, "voice_status", { scope: "bogus" });
    assert.equal(result.isError, true);
    assert.equal(result.payload["error"], "invalid scope");
    assert.equal(fx.calls.length, before);
  });
});

describe("installs equivalence", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setup();
  });
  afterEach(() => teardown(fx));

  it("lint_versions returns both required pins", async () => {
    const result = okPayload(await readOnlyCall(fx, "lint_versions", {}));
    assert.equal(result["shellcheck"], "0.11.0");
    assert.equal(result["actionlint"], "1.7.12");
  });

  it("tool_update_check matches direct stub", async () => {
    const direct = directRun(fx, "fm-tool-update-check.sh", ["check"]);
    assert.equal(direct.status, 0);
    const result = okPayload(await readOnlyCall(fx, "tool_update_check", {}));
    assert.equal(result["stdout"], direct.stdout);
  });

  it("vendor_auth_probe matches direct stub with probe echoed", async () => {
    const direct = directRun(fx, "fm-vendor-auth-probe.sh", ["grok"]);
    assert.equal(direct.status, 0);
    const result = okPayload(await readOnlyCall(fx, "vendor_auth_probe", { probe: "grok" }));
    assert.equal(result["probe"], "grok");
    assert.equal(result["stdout"], direct.stdout);
  });

  it("vendor_auth_probe refuses probes outside the allowlist without spawn", async () => {
    const before = fx.calls.length;
    const result = await readOnlyCall(fx, "vendor_auth_probe", { probe: "bogus" });
    assert.equal(result.isError, true);
    assert.equal(result.payload["error"], "invalid probe");
    assert.equal(fx.calls.length, before);
  });

  it("startup_memory defaults to read with mode echoed", async () => {
    const direct = directRun(fx, "fm-startup-memory-budget.sh", ["read"]);
    assert.equal(direct.status, 0);
    const result = okPayload(await readOnlyCall(fx, "startup_memory", {}));
    assert.equal(result["mode"], "read");
    assert.equal(result["stdout"], direct.stdout);
  });

  it("startup_memory refuses unknown modes without spawn", async () => {
    const before = fx.calls.length;
    const result = await readOnlyCall(fx, "startup_memory", { mode: "bogus" });
    assert.equal(result.isError, true);
    assert.equal(result.payload["error"], "invalid mode");
    assert.equal(fx.calls.length, before);
  });
});

describe("small-gaps equivalence", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setup();
  });
  afterEach(() => teardown(fx));

  it("pr_state matches direct stub with url echoed", async () => {
    const url = "https://github.com/octo/repo/pull/42";
    const direct = directRun(fx, "fm-pr-state.sh", [url]);
    assert.equal(direct.status, 0);
    const result = okPayload(await readOnlyCall(fx, "pr_state", { url }));
    assert.equal(result["url"], url);
    assert.equal(result["stdout"], direct.stdout);
  });

  it("pr_state refuses non-GitHub urls without spawn", async () => {
    const before = fx.calls.length;
    for (const url of ["not a url", "https://example.com/o/r/pull/1"]) {
      const result = await readOnlyCall(fx, "pr_state", { url });
      assert.equal(result.isError, true);
      assert.equal(result.payload["error"], "invalid url");
    }
    assert.equal(fx.calls.length, before);
  });

  it("relay_poll matches direct stub", async () => {
    const direct = directRun(fx, "fm-x-poll.sh", []);
    assert.equal(direct.status, 0);
    const result = okPayload(await readOnlyCall(fx, "relay_poll", {}));
    assert.equal(result["stdout"], direct.stdout);
  });
});

describe("side-effect-free", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setup();
  });
  afterEach(() => teardown(fx));

  it("snapshot served from scratch home", async () => {
    const snap = okPayload(await readOnlyCall(fx, "fleet_snapshot", {}));
    assert.equal(snap["fm_home"], fx.scratch);
    const stateRoot = ((snap["roots"] as Record<string, string>)["state"] as string) ?? "";
    assert.ok(stateRoot.startsWith(fx.scratch), `state root escaped scratch: ${stateRoot}`);
  });

  it("only read scripts ever execute", async () => {
    directRun(fx, "fm-fleet-snapshot.sh", ["--json"]);
    await readOnlyCall(fx, "fleet_snapshot", {});
    await readOnlyCall(fx, "backlog", {});
    await readOnlyCall(fx, "crew_state", { id: "no-such-crew" });
    await readOnlyCall(fx, "fleet_poll", { count: 1, interval_s: 0 });
    fs.writeFileSync(path.join(fx.scratch, "state", "t1.status"), "a\n", "utf8");
    await readOnlyCall(fx, "status_tail", { id: "t1" });
    await readOnlyCall(fx, "peek", { target: "no-such-crew", lines: 1 });
    await readOnlyCall(fx, "fleet_view", {});
    await readOnlyCall(fx, "review_diff", { id: "no-such-crew" });
    await readOnlyCall(fx, "bearings_snapshot", {});
    await readOnlyCall(fx, "wake_drain", {});
    await readOnlyCall(fx, "guard_check", {});
    await readOnlyCall(fx, "remote_doctor", {});
    await readOnlyCall(fx, "remote_file", { path: "data/probe.txt" });
    await readOnlyCall(fx, "remote_delta", {
      log: "state/job.log",
      offset: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    await readOnlyCall(fx, "handoff_status", {});
    await readOnlyCall(fx, "harness_detect", {});
    await readOnlyCall(fx, "project_mode", { project: "probe" });
    await readOnlyCall(fx, "lock_status", {});
    await readOnlyCall(fx, "lease_check", { id: "ghost-task" });
    await readOnlyCall(fx, "bearings_board_path", {});
    await readOnlyCall(fx, "inbox_status", {});
    await readOnlyCall(fx, "inbox_list", {});
    fs.writeFileSync(
      path.join(fx.scratch, "state", "home-summary.json"),
      JSON.stringify({ schema: "fm-secondmate-home-summary.v1", generated: "stub" }),
      "utf8",
    );
    await readOnlyCall(fx, "home_summary", {});
    await readOnlyCall(fx, "contributions_snapshot", {});
    await readOnlyCall(fx, "contributions_pending", {});
    await readOnlyCall(fx, "mail_status", {});
    await readOnlyCall(fx, "mail_read", {});
    await readOnlyCall(fx, "voice_status", { scope: "counts" });
    await readOnlyCall(fx, "lint_versions", {});
    await readOnlyCall(fx, "tool_update_check", {});
    await readOnlyCall(fx, "vendor_auth_probe", { probe: "grok" });
    await readOnlyCall(fx, "startup_memory", { mode: "read" });
    await readOnlyCall(fx, "pr_state", { url: "https://github.com/octocat/Hello-World/pull/42" });
    await readOnlyCall(fx, "relay_poll", {});
    for (const call of fx.calls) {
      assert.ok(READ_SCRIPTS.has(call.script), `non-read script ran: ${call.script}`);
    }
  });

  it("every subprocess ran under scratch home", async () => {
    directRun(fx, "fm-fleet-snapshot.sh", ["--json"]);
    await readOnlyCall(fx, "fleet_snapshot", {});
    await readOnlyCall(fx, "crew_state", { id: "no-such-crew" });
    assert.ok(fx.calls.length >= 2);
    for (const call of fx.calls) {
      assert.equal(call.fm_home, fx.scratch, JSON.stringify(call));
    }
  });

  it("write tools never dispatch", async () => {
    for (const name of [
      "send_message",
      "lifecycle_interrupt",
      "spawn_crew",
      "scaffold_brief",
      "decision_hold",
      "relay_reply",
      "secondmate_nudge",
      "secondmate_restart",
      "secondmate_report",
      "remote_control",
      "handoff_move",
      "voice_queue",
      "mail_send",
    ]) {
      await assert.rejects(() => readOnlyCall(fx, name, {}), /reads only/);
    }
    assert.equal(fx.calls.length, 0, "no subprocess may run for refused tools");
  });
});
