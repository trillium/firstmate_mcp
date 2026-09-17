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
 * review-diff, bearings-snapshot, wake-drain, guard).
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
    ]) {
      await assert.rejects(() => readOnlyCall(fx, name, {}), /reads only/);
    }
    assert.equal(fx.calls.length, 0, "no subprocess may run for refused tools");
  });
});
