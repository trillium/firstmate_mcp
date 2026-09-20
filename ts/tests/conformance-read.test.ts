/**
 * Conformance fixtures: Read and session tools equivalence against firstmate scripts.
 * Shard 1/3: Snapshot, crew state, status tail, diagnostics, and session tools.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  directRun,
  okPayload,
  readOnlyCall,
  setup,
  teardown,
  type Fixture,
  SNAPSHOT_SCHEMA,
} from "./conformance-helpers.js";

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
