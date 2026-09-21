/**
 * Conformance fixtures: Installs, small-gaps, and side-effect-free safety proof.
 * Shard 3/3: System installs, small gap tools, and side-effect-free invariants.
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
} from "./conformance-helpers.js";

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

  it("pr_poll matches direct stub with url echoed", async () => {
    const url = "https://github.com/octo/repo/pull/42";
    const direct = directRun(fx, "fm-pr-poll.sh", [
      "--validated",
      "github",
      url,
      "github.com",
      "octo/repo",
      "42",
    ]);
    assert.equal(direct.status, 0);
    const result = okPayload(await readOnlyCall(fx, "pr_poll", { url }));
    assert.equal(result["url"], url);
    assert.equal(result["stdout"], direct.stdout);
  });

  it("pr_poll refuses non-GitHub urls without spawn", async () => {
    const before = fx.calls.length;
    for (const url of ["not a url", "https://example.com/o/r/pull/1"]) {
      const result = await readOnlyCall(fx, "pr_poll", { url });
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

  it("public_followup_pending matches direct stub", async () => {
    const direct = directRun(fx, "fm-public-followup.sh", ["pending"]);
    assert.equal(direct.status, 0);
    const result = okPayload(await readOnlyCall(fx, "public_followup_pending", {}));
    assert.equal(result["stdout"], direct.stdout);
  });

  it("public_followup_collect matches direct stub with obligation echoed", async () => {
    const direct = directRun(fx, "fm-public-followup-collect.sh", ["drain", "ob-1"]);
    assert.equal(direct.status, 0);
    const result = okPayload(await readOnlyCall(fx, "public_followup_collect", { obligation_id: "ob-1" }));
    assert.equal(result["stdout"], direct.stdout);
    assert.equal(result["obligation_id"], "ob-1");
  });

  it("public_followup_collect refuses traversal without spawn", async () => {
    const before = fx.calls.length;
    const result = await readOnlyCall(fx, "public_followup_collect", { obligation_id: "../x" });
    assert.equal(result.isError, true);
    assert.equal(fx.calls.length, before);
  });

  it("tasks_list matches direct stub", async () => {
    const direct = directRun(fx, "fm-tasks-axi.sh", ["list"]);
    assert.equal(direct.status, 0);
    const result = okPayload(await readOnlyCall(fx, "tasks_list", {}));
    assert.equal(result["stdout"], direct.stdout);
  });

  it("tasks_list refuses invalid state without spawn", async () => {
    const before = fx.calls.length;
    const result = await readOnlyCall(fx, "tasks_list", { state: "invalid_state" });
    assert.equal(result.isError, true);
    assert.equal(result.payload["error"], "invalid state");
    assert.equal(fx.calls.length, before);
  });

  it("tasks_show matches direct stub", async () => {
    const direct = directRun(fx, "fm-tasks-axi.sh", ["show", "task-1"]);
    assert.equal(direct.status, 0);
    const result = okPayload(await readOnlyCall(fx, "tasks_show", { id: "task-1" }));
    assert.equal(result["stdout"], direct.stdout);
  });

  it("tasks_show refuses invalid id without spawn", async () => {
    const before = fx.calls.length;
    const result = await readOnlyCall(fx, "tasks_show", { id: "../escape" });
    assert.equal(result.isError, true);
    assert.equal(result.payload["error"], "invalid id");
    assert.equal(fx.calls.length, before);
  });

  it("tasks_ready matches direct stub", async () => {
    const direct = directRun(fx, "fm-tasks-axi.sh", ["ready"]);
    assert.equal(direct.status, 0);
    const result = okPayload(await readOnlyCall(fx, "tasks_ready", {}));
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

  it("only read scripts ever execute", { timeout: 30000 }, async () => {
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
    await readOnlyCall(fx, "voice_status", {});
    await readOnlyCall(fx, "lint_versions", {});
    await readOnlyCall(fx, "tool_update_check", {});
    await readOnlyCall(fx, "vendor_auth_probe", { probe: "codex" });
    await readOnlyCall(fx, "startup_memory", {});
    await readOnlyCall(fx, "pr_state", { url: "https://github.com/octo/repo/pull/1" });
    await readOnlyCall(fx, "pr_poll", { url: "https://github.com/octo/repo/pull/1" });
    await readOnlyCall(fx, "relay_poll", {});
    await readOnlyCall(fx, "public_followup_pending", {});
    await readOnlyCall(fx, "public_followup_collect", { obligation_id: "ob-1" });
    await readOnlyCall(fx, "tasks_list", {});
    await readOnlyCall(fx, "tasks_show", { id: "probe-task" });
    await readOnlyCall(fx, "tasks_ready", {});

    assert.ok(fx.calls.length >= 20);
    const nonRead = fx.calls.filter(
      (call) =>
        call.script.includes("send") ||
        call.script.includes("control") ||
        call.script.includes("spawn") ||
        call.script.includes("brief") ||
        call.script.includes("decision") ||
        call.script.includes("captain-hold") ||
        call.script.includes("reconcile") ||
        call.script.includes("restart") ||
        call.script.includes("reply") ||
        call.script.includes("dismiss") ||
        call.script.includes("x-followup"),
    );
    assert.deepEqual(nonRead, [], `conformance executed write scripts: ${JSON.stringify(nonRead)}`);
  });

  it("every subprocess ran under scratch home", async () => {
    await readOnlyCall(fx, "fleet_snapshot", {});
    await readOnlyCall(fx, "crew_state", { id: "probe" });
    for (const call of fx.calls) {
      assert.equal(
        call.fm_home,
        fx.scratch,
        `subprocess ${call.script} ran under non-scratch home: ${call.fm_home}`,
      );
    }
  });

  it("write tools never dispatch", async () => {
    for (const name of [
      "send_message",
      "lifecycle_interrupt",
      "lifecycle_exit",
      "spawn_crew",
      "scaffold_brief",
      "decision_hold",
      "decision_resolve",
      "review_decision",
      "relay_reply",
      "relay_dismiss",
      "relay_followup",
      "secondmate_nudge",
      "secondmate_restart",
      "secondmate_report",
      "remote_control",
      "handoff_move",
      "mail_send",
      "voice_queue",
      "receipt_submit",
    ]) {
      await assert.rejects(
        () => readOnlyCall(fx, name, {}),
        (err: Error) => err.message.includes("dispatches reads only"),
      );
    }
  });
});
