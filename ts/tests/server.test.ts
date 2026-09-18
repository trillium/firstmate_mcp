/**
 * End-to-end proof for the TypeScript smarts-only server.
 *
 * Preserved-provenance suite: every check mirrors test_client.py (the
 * upstream 87-check proof for the Python path) against the TS server, so
 * the shared behavioral contract is the referee between the two
 * implementations. Self-contained: stub firstmate homes pinned via FM_HOME.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  APPROVAL,
  Client,
  isError,
  makeEnvelopeStubHome,
  makeOrphanStubHome,
  makeReceiptStubHome,
  makeStubHome,
  payload,
  removeHome,
} from "./helpers.js";

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("handshake and reads", () => {
  let client: Client;
  let home: string;
  before(() => {
    home = makeStubHome();
    client = new Client({ FM_HOME: home });
  });
  after(async () => {
    await client.close();
    removeHome(home);
  });

  it("handshake negotiates version", async () => {
    const resp = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "poc-test-client", version: "0.1.0" },
    });
    assert.equal((resp.result as Record<string, unknown>)["protocolVersion"], "2024-11-05");
  });

  it("server identifies itself", async () => {
    const resp = await client.request("initialize", { protocolVersion: "2024-11-05" });
    const info = (resp.result as Record<string, unknown>)["serverInfo"] as Record<string, string>;
    assert.equal(info["name"], "firstmate-mcp-poc");
    client.notify("notifications/initialized");
  });

  it("tools list keeps the 5 PoC tools", async () => {
    const resp = await client.request("tools/list");
    const names = new Set(
      ((resp.result as Record<string, unknown>)["tools"] as Array<{ name: string }>).map((t) => t.name),
    );
    for (const required of ["fleet_snapshot", "backlog", "crew_state", "status_tail", "send_message"]) {
      assert.ok(names.has(required), `missing ${required}`);
    }
  });

  it("tools carry input schemas", async () => {
    const resp = await client.request("tools/list");
    const tools = (resp.result as Record<string, unknown>)["tools"] as Array<Record<string, unknown>>;
    for (const tool of tools) assert.ok("inputSchema" in tool, JSON.stringify(tool).slice(0, 120));
  });

  it("fleet_snapshot returns canonical schema", async () => {
    const snap = payload(await client.call("fleet_snapshot", {}));
    assert.equal(snap["schema"], "fm-fleet-snapshot.v1");
  });

  it("fleet_snapshot has backlog plus tasks", async () => {
    const snap = payload(await client.call("fleet_snapshot", {}));
    assert.ok("backlog" in snap && "tasks" in snap);
  });

  it("backlog returns records plus counts", async () => {
    const back = payload(await client.call("backlog", {}));
    assert.ok("backlog" in back && "task_counts" in back);
  });

  it("crew_state answers unknown for missing id", async () => {
    const state = payload(await client.call("crew_state", { id: "no-such-id" }));
    assert.equal((state["current"] as Record<string, string>)["state"], "unknown");
  });

  it("crew_state rejects traversal", async () => {
    assert.equal(isError(await client.call("crew_state", { id: "../escape" })), true);
  });

  it("status_tail missing id is structured error", async () => {
    assert.equal(isError(await client.call("status_tail", { id: "no-such-id", lines: 5 })), true);
  });

  it("status_tail rejects traversal", async () => {
    assert.equal(isError(await client.call("status_tail", { id: "x/../../y" })), true);
  });

  it("send_message fail-closed stays structured", async () => {
    assert.equal(isError(await client.call("send_message", { target: "no-such-id", text: "hello" })), true);
  });

  it("send_message refuses slash", async () => {
    const err = payload(await client.call("send_message", { target: "x", text: "/merge now" }));
    assert.match(String(err["error"] ?? ""), /slash/);
  });

  it("send_message refuses multiline", async () => {
    assert.equal(isError(await client.call("send_message", { target: "x", text: "one\ntwo" })), true);
  });

  it("send_message enforces length cap", async () => {
    assert.equal(isError(await client.call("send_message", { target: "x", text: "z".repeat(501) })), true);
  });

  it("unknown tool is JSON-RPC error", async () => {
    const resp = await client.call("nope", {});
    assert.ok("error" in resp && resp.error!.code === -32602);
  });

  it("ping answers", async () => {
    const resp = await client.request("ping");
    assert.deepEqual(resp.result, {});
  });
});

describe("smarts surface: 46 tools, forbidden absent", () => {
  let boxed: Client;
  let sandbox: string;
  before(() => {
    sandbox = makeStubHome();
    boxed = new Client({ FM_HOME: sandbox });
    boxed.notify("notifications/initialized");
  });
  after(async () => {
    await boxed.close();
    removeHome(sandbox);
  });

  const REQUIRED = [
    "lifecycle_interrupt", "lifecycle_exit", "lifecycle_relaunch",
    "lifecycle_suspend", "lifecycle_resume", "spawn_crew", "scaffold_brief",
    "decision_hold", "decision_resolve", "review_decision", "relay_reply",
    "relay_dismiss", "relay_followup", "fleet_poll",
    "peek", "fleet_view", "review_diff",
    "bearings_snapshot", "wake_drain", "guard_check",
    "remote_doctor", "remote_file", "remote_delta", "handoff_status",
    "secondmate_nudge", "secondmate_restart", "secondmate_report",
    "remote_control", "handoff_move",
    "harness_detect", "project_mode", "lock_status", "lease_check",
    "bearings_board_path", "inbox_status", "inbox_list",
    "home_summary", "contributions_snapshot", "contributions_pending",
    "receipt_submit", "receipt_status",
  ];
  const FORBIDDEN = ["promote_scout", "teardown_crew", "arm_pr_check", "merge_pr", "merge_local"];

  it("smarts server lists 46 tools", async () => {
    const resp = await boxed.request("tools/list");
    const tools = (resp.result as Record<string, unknown>)["tools"] as Array<{ name: string }>;
    assert.equal(tools.length, 46);
  });

  for (const required of REQUIRED) {
    it(`tool present: ${required}`, async () => {
      const resp = await boxed.request("tools/list");
      const names = new Set(
        ((resp.result as Record<string, unknown>)["tools"] as Array<{ name: string }>).map((t) => t.name),
      );
      assert.ok(names.has(required));
    });
  }

  for (const forbidden of FORBIDDEN) {
    it(`code-forbidden absent: ${forbidden}`, async () => {
      const resp = await boxed.request("tools/list");
      const names = new Set(
        ((resp.result as Record<string, unknown>)["tools"] as Array<{ name: string }>).map((t) => t.name),
      );
      assert.ok(!names.has(forbidden));
    });
    it(`code-forbidden refused: ${forbidden}`, async () => {
      const resp = await boxed.call(forbidden, {});
      assert.ok("error" in resp && resp.error!.code === -32602);
    });
  }

  it("every authority tool schema requires approval", async () => {
    const resp = await boxed.request("tools/list");
    const tools = (resp.result as Record<string, unknown>)["tools"] as Array<{
      name: string;
      inputSchema: { required?: string[] };
    }>;
    const open = new Set([
      "fleet_snapshot", "backlog", "crew_state", "status_tail", "send_message", "fleet_poll",
      "peek", "fleet_view", "review_diff", "bearings_snapshot", "wake_drain", "guard_check",
      "remote_doctor", "remote_file", "remote_delta", "handoff_status",
      "harness_detect", "project_mode", "lock_status", "lease_check",
      "bearings_board_path", "inbox_status", "inbox_list",
      "home_summary", "contributions_snapshot", "contributions_pending",
      "receipt_submit", "receipt_status",
    ]);
    for (const tool of tools) {
      if (open.has(tool.name)) continue;
      assert.ok(
        (tool.inputSchema.required ?? []).includes("approval"),
        `${tool.name} schema must require approval`,
      );
    }
  });

  it("interrupt refuses without approval", async () => {
    const resp = await boxed.call("lifecycle_interrupt", { id: "no-such-id" });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("interrupt rejects traversal", async () => {
    assert.equal(isError(await boxed.call("lifecycle_interrupt", { id: "../escape", approval: APPROVAL })), true);
  });
  it("interrupt unknown id stays structured", async () => {
    assert.equal(
      isError(await boxed.call("lifecycle_interrupt", { id: "no-such-id", approval: APPROVAL })),
      true,
    );
  });
  it("exit refuses without approval", async () => {
    const resp = await boxed.call("lifecycle_exit", { id: "no-such-id" });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("exit unknown id stays structured", async () => {
    assert.equal(
      isError(await boxed.call("lifecycle_exit", { id: "no-such-id", approval: APPROVAL })),
      true,
    );
  });
  it("relaunch unknown id stays structured", async () => {
    assert.equal(
      isError(await boxed.call("lifecycle_relaunch", { id: "no-such-id", note: "retry", approval: APPROVAL })),
      true,
    );
  });
  it("relaunch requires note", async () => {
    assert.equal(
      isError(await boxed.call("lifecycle_relaunch", { id: "no-such-id", approval: APPROVAL })),
      true,
    );
  });
  it("suspend unknown id stays structured", async () => {
    assert.equal(
      isError(await boxed.call("lifecycle_suspend", { id: "no-such-id", note: "park", approval: APPROVAL })),
      true,
    );
  });
  it("resume unknown id stays structured", async () => {
    assert.equal(
      isError(await boxed.call("lifecycle_resume", { id: "no-such-id", note: "back", approval: APPROVAL })),
      true,
    );
  });
  it("spawn refuses without approval", async () => {
    const resp = await boxed.call("spawn_crew", {
      task_id: "no-such-id", project: "no-such-project", mode: "local-only", yolo: "off",
    });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("spawn rejects traversal id", async () => {
    assert.equal(
      isError(
        await boxed.call("spawn_crew", {
          task_id: "../x", project: "p", mode: "local-only", yolo: "off", approval: APPROVAL,
        }),
      ),
      true,
    );
  });
  it("spawn rejects absolute project", async () => {
    assert.equal(
      isError(
        await boxed.call("spawn_crew", {
          task_id: "no-such-id", project: "/abs/path", mode: "local-only", yolo: "off", approval: APPROVAL,
        }),
      ),
      true,
    );
  });
  it("spawn unknown target stays structured", async () => {
    assert.equal(
      isError(
        await boxed.call("spawn_crew", {
          task_id: "no-such-id", project: "no-such-project", mode: "local-only", yolo: "off", approval: APPROVAL,
        }),
      ),
      true,
    );
  });
  it("brief refuses without approval", async () => {
    const resp = await boxed.call("scaffold_brief", {
      task_id: "no-such-id", project: "no-such-project", mode: "scout",
    });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("brief rejects bad mode", async () => {
    assert.equal(
      isError(
        await boxed.call("scaffold_brief", {
          task_id: "no-such-id", project: "no-such-project", mode: "bogus", approval: APPROVAL,
        }),
      ),
      true,
    );
  });
  it("decision hold refuses without approval", async () => {
    const resp = await boxed.call("decision_hold", {
      origin_id: "no-such-id", decision_key: "k1", title: "t", reason: "r",
    });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("decision resolve refuses without approval", async () => {
    const resp = await boxed.call("decision_resolve", {
      origin_id: "x", decision_key: "k", routed_to: "y", decision_text: "d",
    });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("review refuses without approval", async () => {
    const resp = await boxed.call("review_decision", { id: "no-such-id", verdict: "approve" });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("review rejects bad verdict", async () => {
    assert.equal(
      isError(await boxed.call("review_decision", { id: "no-such-id", verdict: "bogus", approval: APPROVAL })),
      true,
    );
  });
  it("review comment verdict requires text", async () => {
    assert.equal(
      isError(await boxed.call("review_decision", { id: "no-such-id", verdict: "comment", approval: APPROVAL })),
      true,
    );
  });
  it("review valid call reaches captain-hold answer and stays structured", async () => {
    const resp = await boxed.call("review_decision", { id: "no-such-id", verdict: "approve", approval: APPROVAL });
    assert.equal(isError(resp), true);
    assert.ok(String((payload(resp)["stderr"] as string | undefined) ?? "").includes("answer"));
  });
  it("relay reply refuses without approval", async () => {
    const resp = await boxed.call("relay_reply", { request_id: "no-such-id", text: "hello" });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("relay reply rejects traversal", async () => {
    assert.equal(
      isError(await boxed.call("relay_reply", { request_id: "../x", text: "hello", approval: APPROVAL })),
      true,
    );
  });
  it("relay dismiss refuses without approval", async () => {
    const resp = await boxed.call("relay_dismiss", { request_id: "no-such-id" });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("relay followup refuses without approval", async () => {
    const resp = await boxed.call("relay_followup", { task_id: "no-such-id", text: "done" });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("fleet_poll returns poll summaries", async () => {
    const resp = await boxed.call("fleet_poll", { count: 2, interval_s: 0 });
    const polled = payload(resp);
    assert.equal(isError(resp), false);
    assert.equal(((polled["polls"] as unknown[]) ?? []).length, 2);
  });
  it("peek returns bounded tail with target echoed", async () => {
    const resp = await boxed.call("peek", { target: "no-such-id" });
    const peeked = payload(resp);
    assert.equal(isError(resp), false);
    assert.equal(peeked["target"], "no-such-id");
    assert.ok("stdout" in peeked);
  });
  it("peek rejects traversal", async () => {
    assert.equal(isError(await boxed.call("peek", { target: "../escape" })), true);
  });
  it("peek rejects bad lines", async () => {
    assert.equal(isError(await boxed.call("peek", { target: "x", lines: "many" })), true);
  });
  it("fleet_view returns human render", async () => {
    const resp = await boxed.call("fleet_view", {});
    assert.equal(isError(resp), false);
    assert.ok("stdout" in payload(resp));
  });
  it("review_diff unknown id stays structured", async () => {
    assert.equal(isError(await boxed.call("review_diff", { id: "no-such-id" })), false);
  });
  it("review_diff rejects traversal", async () => {
    assert.equal(isError(await boxed.call("review_diff", { id: "../escape" })), true);
  });
  it("review_diff rejects non-bool stat", async () => {
    assert.equal(isError(await boxed.call("review_diff", { id: "x", stat: "yes" })), true);
  });
  it("bearings_snapshot returns fm-bearings.v1", async () => {
    const resp = await boxed.call("bearings_snapshot", {});
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["schema"], "fm-bearings.v1");
  });
  it("wake_drain drains to structured text", async () => {
    const resp = await boxed.call("wake_drain", {});
    assert.equal(isError(resp), false);
    assert.ok("stdout" in payload(resp));
  });
  it("guard_check returns verdict text", async () => {
    const resp = await boxed.call("guard_check", {});
    assert.equal(isError(resp), false);
    assert.ok("stdout" in payload(resp));
  });
  it("remote_doctor returns check-mode diagnostic", async () => {
    const resp = await boxed.call("remote_doctor", {});
    assert.equal(isError(resp), false);
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("doctor-stub"));
  });
  it("remote_file returns bounded bytes with path echoed", async () => {
    const resp = await boxed.call("remote_file", { path: "data/probe.txt" });
    const filed = payload(resp);
    assert.equal(isError(resp), false);
    assert.equal(filed["path"], "data/probe.txt");
    assert.equal(filed["max_bytes"], 8192);
    assert.ok("stdout" in filed);
  });
  it("remote_file rejects traversal", async () => {
    assert.equal(isError(await boxed.call("remote_file", { path: "../escape" })), true);
  });
  it("remote_file rejects bad max_bytes", async () => {
    assert.equal(isError(await boxed.call("remote_file", { path: "x", max_bytes: "big" })), true);
  });
  it("remote_delta returns appended bytes with log echoed", async () => {
    const resp = await boxed.call("remote_delta", {
      log: "state/job.log", offset: 0, sha256: "e".repeat(64),
    });
    const delta = payload(resp);
    assert.equal(isError(resp), false);
    assert.equal(delta["log"], "state/job.log");
    assert.equal(delta["offset"], 0);
    assert.ok("stdout" in delta);
  });
  it("remote_delta rejects traversal", async () => {
    assert.equal(
      isError(await boxed.call("remote_delta", { log: "../x", offset: 0, sha256: "e".repeat(64) })),
      true,
    );
  });
  it("remote_delta rejects bad offset", async () => {
    assert.equal(
      isError(await boxed.call("remote_delta", { log: "x", offset: -1, sha256: "e".repeat(64) })),
      true,
    );
  });
  it("remote_delta rejects bad sha256", async () => {
    assert.equal(
      isError(await boxed.call("remote_delta", { log: "x", offset: 0, sha256: "short" })),
      true,
    );
  });
  it("remote_delta rejects bad wait", async () => {
    assert.equal(
      isError(
        await boxed.call("remote_delta", { log: "x", offset: 0, sha256: "e".repeat(64), wait: "long" }),
      ),
      true,
    );
  });
  it("handoff_status lists staged outboxes", async () => {
    const resp = await boxed.call("handoff_status", {});
    assert.equal(isError(resp), false);
    assert.deepEqual(payload(resp)["outboxes"], []);
  });
  it("handoff_status rejects traversal", async () => {
    assert.equal(isError(await boxed.call("handoff_status", { id: "../escape" })), true);
  });
  it("handoff_status missing id is structured error", async () => {
    assert.equal(isError(await boxed.call("handoff_status", { id: "ghost" })), true);
  });
  it("nudge refuses without approval", async () => {
    const resp = await boxed.call("secondmate_nudge", {});
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("nudge unknown home stays structured", async () => {
    assert.equal(isError(await boxed.call("secondmate_nudge", { approval: APPROVAL })), true);
  });
  it("restart refuses without approval", async () => {
    const resp = await boxed.call("secondmate_restart", { ids: ["m1"] });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("restart rejects traversal ids", async () => {
    assert.equal(
      isError(await boxed.call("secondmate_restart", { ids: ["../x"], approval: APPROVAL })),
      true,
    );
  });
  it("restart rejects empty ids", async () => {
    assert.equal(
      isError(await boxed.call("secondmate_restart", { ids: [], approval: APPROVAL })),
      true,
    );
  });
  it("restart unknown mate stays structured", async () => {
    assert.equal(
      isError(await boxed.call("secondmate_restart", { ids: ["m1"], approval: APPROVAL })),
      true,
    );
  });
  it("report refuses without approval", async () => {
    const resp = await boxed.call("secondmate_report", {
      verb: "done", corr: "a".repeat(16), note: "ok",
    });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("report rejects bad corr", async () => {
    assert.equal(
      isError(
        await boxed.call("secondmate_report", {
          verb: "done", corr: "short", note: "ok", approval: APPROVAL,
        }),
      ),
      true,
    );
  });
  it("report rejects bad verb", async () => {
    assert.equal(
      isError(
        await boxed.call("secondmate_report", {
          verb: "has space", corr: "a".repeat(16), note: "ok", approval: APPROVAL,
        }),
      ),
      true,
    );
  });
  it("report unknown home stays structured", async () => {
    assert.equal(
      isError(
        await boxed.call("secondmate_report", {
          verb: "done", corr: "a".repeat(16), note: "ok", approval: APPROVAL,
        }),
      ),
      true,
    );
  });
  it("remote control refuses without approval", async () => {
    const resp = await boxed.call("remote_control", { verb: "state", id: "m1" });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("remote control refuses launch verb", async () => {
    assert.equal(
      isError(await boxed.call("remote_control", { verb: "launch", id: "m1", approval: APPROVAL })),
      true,
    );
  });
  it("remote control refuses retire verb", async () => {
    assert.equal(
      isError(await boxed.call("remote_control", { verb: "retire", id: "m1", approval: APPROVAL })),
      true,
    );
  });
  it("remote control send refuses slash", async () => {
    assert.equal(
      isError(
        await boxed.call("remote_control", {
          verb: "send", id: "m1", text: "/raw key", approval: APPROVAL,
        }),
      ),
      true,
    );
  });
  it("remote control unknown mate stays structured", async () => {
    assert.equal(
      isError(await boxed.call("remote_control", { verb: "state", id: "m1", approval: APPROVAL })),
      true,
    );
  });
  it("handoff refuses without approval", async () => {
    const resp = await boxed.call("handoff_move", { id: "m1", keys: ["k1"] });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("handoff rejects empty keys", async () => {
    assert.equal(
      isError(await boxed.call("handoff_move", { id: "m1", keys: [], approval: APPROVAL })),
      true,
    );
  });
  it("handoff rejects non-bool resume", async () => {
    assert.equal(
      isError(await boxed.call("handoff_move", { id: "m1", resume: "yes", approval: APPROVAL })),
      true,
    );
  });
  it("handoff unknown mate stays structured", async () => {
    assert.equal(
      isError(await boxed.call("handoff_move", { id: "m1", keys: ["k1"], approval: APPROVAL })),
      true,
    );
  });
  it("handoff resume stays structured", async () => {
    assert.equal(
      isError(await boxed.call("handoff_move", { id: "m1", resume: true, approval: APPROVAL })),
      true,
    );
  });
  it("harness_detect defaults to own and echoes the harness", async () => {
    const resp = await boxed.call("harness_detect", {});
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["mode"], "own");
    assert.equal(payload(resp)["harness"], "harness-stub:");
  });
  it("harness_detect passes the crew mode through", async () => {
    const resp = await boxed.call("harness_detect", { mode: "crew" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["harness"], "harness-stub:crew");
  });
  it("harness_detect rejects unknown modes", async () => {
    assert.equal(isError(await boxed.call("harness_detect", { mode: "bogus" })), true);
  });
  it("project_mode returns the mapped mode+yolo pair", async () => {
    const resp = await boxed.call("project_mode", { project: "myproj" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["project"], "myproj");
    assert.equal(payload(resp)["mode"], "local-only");
    assert.equal(payload(resp)["yolo"], "off");
  });
  it("project_mode rejects traversal", async () => {
    assert.equal(isError(await boxed.call("project_mode", { project: "../escape" })), true);
  });
  it("lock_status reports the free projection", async () => {
    const resp = await boxed.call("lock_status", {});
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["status"], "free");
  });
  it("lease_check projects a held lease", async () => {
    const resp = await boxed.call("lease_check", { id: "leased-task" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["leased"], true);
    assert.equal(payload(resp)["actor"], "main");
    assert.equal(payload(resp)["live"], true);
    assert.equal(payload(resp)["pid"], 4242);
  });
  it("lease_check reports unleased without error", async () => {
    const resp = await boxed.call("lease_check", { id: "ghost-task" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["leased"], false);
  });
  it("lease_check rejects traversal", async () => {
    assert.equal(isError(await boxed.call("lease_check", { id: "../escape" })), true);
  });
  it("bearings_board_path returns the stable path", async () => {
    const resp = await boxed.call("bearings_board_path", {});
    assert.equal(isError(resp), false);
    assert.ok(
      ((payload(resp)["path"] as string) ?? "").endsWith("bearings-board.html"),
    );
  });
  it("inbox_status reads without sending a wake", async () => {
    const resp = await boxed.call("inbox_status", {});
    assert.equal(isError(resp), false);
    assert.ok(((payload(resp)["stdout"] as string) ?? "").includes("inbox-stub:status"));
  });
  it("inbox_list reads the queued notes", async () => {
    const resp = await boxed.call("inbox_list", {});
    assert.equal(isError(resp), false);
    assert.ok(((payload(resp)["stdout"] as string) ?? "").includes("inbox-stub:list"));
  });
  it("home_summary without a ledger is a structured error", async () => {
    const resp = await boxed.call("home_summary", {});
    assert.equal(isError(resp), true);
    assert.equal(payload(resp)["error"], "no home summary");
  });
  it("home_summary returns the published ledger", async () => {
    fs.writeFileSync(
      path.join(sandbox, "state", "home-summary.json"),
      JSON.stringify({ schema: "fm-secondmate-home-summary.v1", generated: "stub" }),
      "utf8",
    );
    const resp = await boxed.call("home_summary", {});
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["schema"], "fm-secondmate-home-summary.v1");
  });
  it("contributions_snapshot projects coverage without a forge", async () => {
    const resp = await boxed.call("contributions_snapshot", {});
    assert.equal(isError(resp), false);
    assert.ok("backlog" in payload(resp));
    assert.equal(payload(resp)["all"], false);
  });
  it("contributions_snapshot echoes the all flag", async () => {
    const resp = await boxed.call("contributions_snapshot", { all: true });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["all"], true);
  });
  it("contributions_snapshot rejects non-bool all", async () => {
    assert.equal(isError(await boxed.call("contributions_snapshot", { all: "yes" })), true);
  });
  it("contributions_pending returns the token list", async () => {
    const resp = await boxed.call("contributions_pending", {});
    assert.equal(isError(resp), false);
    assert.deepEqual(payload(resp)["pending"], []);
  });
});

describe("fail-closed budget: slow calls time out inside 30s", () => {
  let ebox: Client;
  let envelope: string;
  before(() => {
    envelope = makeEnvelopeStubHome();
    ebox = new Client({ FM_HOME: envelope });
  });
  after(async () => {
    await ebox.close();
    removeHome(envelope);
  });

  it("slow snapshot fails closed with a typed timeout", { timeout: 60000 }, async () => {
    const started = Date.now();
    const resp = await ebox.call("fleet_snapshot", {});
    const elapsedS = (Date.now() - started) / 1000;
    const snap = payload(resp);
    assert.equal(isError(resp), true);
    assert.equal(snap["error"], "timed out");
    assert.equal(snap["timeout_s"], 30);
    assert.ok(elapsedS >= 30 && elapsedS < 45, `no call blocks past 30s, took ${elapsedS.toFixed(1)}s`);
  });
  it("timed-out call is audited as allow with the failure in the payload", async () => {
    const lines = fs
      .readFileSync(path.join(envelope, "state", "mcp-audit.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.ok(
      lines.some((l) => l["tool"] === "fleet_snapshot" && l["decision"] === "allow"),
      "expected an allow audit line for the timed-out fleet_snapshot",
    );
  });
  it("backlog derives counts from a >128KB snapshot", async () => {
    const back = payload(await ebox.call("backlog", {}));
    assert.equal(
      ((back["task_counts"] as Record<string, unknown>)["total"] as number),
      800,
    );
  });
  it("fleet_poll bounds output from a >128KB snapshot", async () => {
    const resp = await ebox.call("fleet_poll", { count: 1, interval_s: 0 });
    const polled = payload(resp);
    assert.equal(isError(resp), false);
    assert.equal(((polled["polls"] as unknown[]) ?? []).length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(polled), "utf8") <= 8192);
  });
});

describe("timeout kills the whole process group", () => {
  let obox: Client;
  let orphanHome: string;
  before(() => {
    orphanHome = makeOrphanStubHome();
    obox = new Client({ FM_HOME: orphanHome });
  });
  after(async () => {
    await obox.close();
    removeHome(orphanHome);
  });

  it("timed-out group leaves no orphan compute", { timeout: 90000 }, async () => {
    const started = Date.now();
    const resp = await obox.call("fleet_snapshot", {});
    assert.equal(isError(resp), true);
    assert.equal(payload(resp)["error"], "timed out");
    while (Date.now() - started < 40000) await sleepMs(1000);
    assert.equal(fs.existsSync(path.join(orphanHome, "orphan-marker")), false);
  });
});

describe("async receipts: submit, lifecycle, isolation, expiry", () => {
  let rbox: Client;
  let receiptHome: string;
  let envelopeHome: string;
  let other: Client;
  before(() => {
    receiptHome = makeReceiptStubHome();
    rbox = new Client({ FM_HOME: receiptHome });
    envelopeHome = makeEnvelopeStubHome();
    other = new Client({ FM_HOME: envelopeHome });
  });
  after(async () => {
    await rbox.close();
    await other.close();
    removeHome(receiptHome);
    removeHome(envelopeHome);
  });

  let receiptId = "";
  it("receipt_submit detaches immediately with a pending receipt", { timeout: 30000 }, async () => {
    const started = Date.now();
    const resp = await rbox.call("receipt_submit", { tool: "fleet_snapshot", arguments: {} });
    const elapsedS = (Date.now() - started) / 1000;
    const sub = payload(resp);
    assert.equal(isError(resp), false);
    assert.equal(sub["status"], "pending");
    assert.ok(String(sub["receipt_id"]).startsWith("rcpt-"));
    assert.equal(sub["ttl_s"], 3600);
    assert.ok(elapsedS < 10, `submit must return far inside 30s, took ${elapsedS.toFixed(1)}s`);
    assert.deepEqual(sub["check"], {
      tool: "receipt_status",
      arguments: { receipt_id: sub["receipt_id"] },
    });
    receiptId = sub["receipt_id"] as string;
  });
  it("receipt reaches done with the >128KB result attached", { timeout: 150000 }, async () => {
    let done: Record<string, unknown> | null = null;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const state = payload(await rbox.call("receipt_status", { receipt_id: receiptId }));
      if (state["status"] !== "running") {
        done = state;
        break;
      }
      await sleepMs(2000);
    }
    assert.ok(done !== null, "receipt never left running");
    assert.equal(done["status"], "done");
    const result = done["result"] as Record<string, unknown>;
    assert.equal(result["generated"], "envelope-slow-large");
    assert.equal(((result["tasks"] as unknown[]) ?? []).length, 800);
  });
  it("failed receipt attaches its error record", { timeout: 60000 }, async () => {
    const sub = payload(
      await rbox.call("receipt_submit", { tool: "status_tail", arguments: { id: "../escape" } }),
    );
    let failed: Record<string, unknown> | null = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const state = payload(
        await rbox.call("receipt_status", { receipt_id: sub["receipt_id"] as string }),
      );
      if (state["status"] !== "running") {
        failed = state;
        break;
      }
      await sleepMs(500);
    }
    assert.ok(failed !== null, "receipt never left running");
    assert.equal(failed["status"], "failed");
    assert.ok(String(JSON.stringify(failed["error_record"])).includes("invalid id"));
  });
  it("submit refuses unknown tools and missing nested approval", async () => {
    assert.equal(isError(await rbox.call("receipt_submit", { tool: "nope", arguments: {} })), true);
    const resp = await rbox.call("receipt_submit", {
      tool: "lifecycle_interrupt",
      arguments: { id: "x" },
    });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("status rejects traversal receipt ids", async () => {
    assert.equal(isError(await rbox.call("receipt_status", { receipt_id: "../escape" })), true);
  });
  it("receipts never leak across homes", async () => {
    const resp = await other.call("receipt_status", { receipt_id: receiptId });
    assert.ok(isError(resp));
    assert.equal(payload(resp)["error"], "unknown receipt");
  });
  it("expired receipts report expired with their TTL and are removed", async () => {
    const expiredId = "rcpt-expired-proof";
    const dir = path.join(receiptHome, "state", "mcp-receipts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${expiredId}.json`),
      JSON.stringify({
        receipt_id: expiredId, tool: "fleet_snapshot", status: "done",
        created: "stub", created_epoch: Date.now() / 1000 - 7200,
        ttl_s: 3600, result: {},
      }),
    );
    const resp = await rbox.call("receipt_status", { receipt_id: expiredId });
    assert.ok(isError(resp));
    assert.equal(payload(resp)["error"], "receipt expired");
    assert.equal(payload(resp)["ttl_s"], 3600);
    assert.equal(fs.existsSync(path.join(dir, `${expiredId}.json`)), false);
  });
});
