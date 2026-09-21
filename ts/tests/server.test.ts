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
  makeStubHome,
  payload,
  removeHome,
} from "./helpers.js";

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

describe("expanded surface: 66 tools", () => {
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
    "decision_hold", "decision_resolve", "decision_release", "decision_complete",
    "decision_verify", "decision_open", "decision_diverged",
    "review_decision", "relay_reply",
    "relay_dismiss", "relay_followup", "fleet_poll",
    "peek", "fleet_view", "review_diff",
    "bearings_snapshot", "wake_drain", "guard_check",
    "remote_doctor", "remote_file", "remote_delta", "handoff_status",
    "secondmate_nudge", "secondmate_restart", "secondmate_report",
    "remote_control", "handoff_move",
    "harness_detect", "project_mode", "lock_status", "lease_check",
    "bearings_board_path", "inbox_status", "inbox_list",
    "home_summary", "home_summary_refresh", "contributions_snapshot", "contributions_pending",
    "mail_status", "mail_read", "mail_check", "voice_status",
    "lint_versions", "tool_update_check", "vendor_auth_probe",
    "startup_memory", "pr_state", "relay_poll",
    "voice_queue", "mail_send",
    "receipt_submit", "receipt_status",
    "promote_scout", "teardown_crew", "arm_pr_check", "merge_pr", "merge_local",
    "repo_edit", "repo_commit", "repo_push", "repo_merge",
    "daemon_start", "daemon_stop", "daemon_restart", "daemon_status",
    "watch_start", "watch_stop",
    "task_intake", "worktree_allocate", "lifecycle_drive", "review_gate", "reconcile_upstream",
    "grant_mint", "grant_revoke", "grant_status",
  ];

  it("server lists 87 tools", async () => {
    const resp = await boxed.request("tools/list");
    const tools = (resp.result as Record<string, unknown>)["tools"] as Array<{ name: string }>;
    assert.equal(tools.length, 87);
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
      "home_summary", "home_summary_refresh", "contributions_snapshot", "contributions_pending",
      "mail_status", "mail_read", "mail_check", "voice_status",
      "lint_versions", "tool_update_check", "vendor_auth_probe",
      "startup_memory", "pr_state", "relay_poll",
      "receipt_submit", "receipt_status", "daemon_status", "grant_status",
      "decision_verify", "decision_open", "decision_diverged",
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
  it("decision resolve rejects empty decision_text", async () => {
    const resp = await boxed.call("decision_resolve", {
      origin_id: "x", decision_key: "k", routed_to: "y", decision_text: "   ", approval: APPROVAL,
    });
    assert.ok(isError(resp));
    assert.equal(payload(resp)["error"], "invalid decision_text");
  });
  it("decision release refuses without approval", async () => {
    const resp = await boxed.call("decision_release", {
      id: "agent-1-decision-key1", decision_text: "approved",
    });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("decision release rejects empty decision_text", async () => {
    const resp = await boxed.call("decision_release", {
      id: "agent-1-decision-key1", decision_text: "", approval: APPROVAL,
    });
    assert.ok(isError(resp));
    assert.equal(payload(resp)["error"], "invalid decision_text");
  });
  it("decision release refuses captain-opened hold without grant (SAFETY CORE)", async () => {
    const resp = await boxed.call("decision_release", {
      id: "captain-hold", decision_text: "approved release", approval: APPROVAL,
    });
    assert.ok(isError(resp));
    assert.equal(payload(resp)["error"], "release unauthorized");
    assert.ok(String(payload(resp)["detail"] ?? "").includes("captain-opened hold"));
  });
  it("decision release allows captain-opened hold when FM_RELEASE_GRANT is enabled", async () => {
    const grantClient = new Client({ FM_HOME: sandbox, FM_RELEASE_GRANT: "1" });
    try {
      const resp = await grantClient.call("decision_release", {
        id: "captain-hold", decision_text: "approved release", approval: APPROVAL,
      });
      assert.equal(isError(resp), false);
      assert.equal(payload(resp)["id"], "captain-hold");
      assert.ok(typeof payload(resp)["decision_digest"] === "string");
      assert.equal((payload(resp)["decision_digest"] as string).length, 64);
    } finally {
      await grantClient.close();
    }
  });
  it("decision release allows self-opened hold (matching FM_ACTOR)", async () => {
    const workerClient = new Client({ FM_HOME: sandbox, FM_ACTOR: "worker-1" });
    try {
      const resp = await workerClient.call("decision_release", {
        origin_id: "worker-1", decision_key: "auth-gate", routed_to: "task-2", decision_text: "approved release", approval: APPROVAL,
      });
      assert.equal(isError(resp), false);
      assert.equal(payload(resp)["origin_id"], "worker-1");
      assert.equal(payload(resp)["decision_key"], "auth-gate");
      assert.ok(typeof payload(resp)["decision_digest"] === "string");
    } finally {
      await workerClient.close();
    }
  });
  it("decision release refuses hold opened by different actor without grant", async () => {
    const workerClient = new Client({ FM_HOME: sandbox, FM_ACTOR: "worker-2" });
    try {
      const resp = await workerClient.call("decision_release", {
        origin_id: "worker-1", decision_key: "auth-gate", routed_to: "task-2", decision_text: "approved release", approval: APPROVAL,
      });
      assert.ok(isError(resp));
      assert.equal(payload(resp)["error"], "release unauthorized");
    } finally {
      await workerClient.close();
    }
  });
  it("decision complete refuses without approval", async () => {
    const resp = await boxed.call("decision_complete", { origin_id: "t1", none: true });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("decision complete rejects combining none with task_ids", async () => {
    const resp = await boxed.call("decision_complete", {
      origin_id: "t1", none: true, task_ids: ["t2"], approval: APPROVAL,
    });
    assert.ok(isError(resp));
    assert.equal(payload(resp)["error"], "invalid task_ids");
  });
  it("decision complete with none succeeds", async () => {
    const resp = await boxed.call("decision_complete", {
      origin_id: "t1", none: true, approval: APPROVAL,
    });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["origin_id"], "t1");
    assert.equal(payload(resp)["none"], true);
  });
  it("decision complete with task_ids succeeds", async () => {
    const resp = await boxed.call("decision_complete", {
      origin_id: "t1", task_ids: ["t2", "t3"], approval: APPROVAL,
    });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["origin_id"], "t1");
    assert.deepEqual(payload(resp)["task_ids"], ["t2", "t3"]);
  });
  it("decision verify succeeds without approval (open read)", async () => {
    const resp = await boxed.call("decision_verify", { origin_id: "t1" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["origin_id"], "t1");
    assert.equal(payload(resp)["verified"], true);
  });
  it("decision open succeeds without approval (open read)", async () => {
    const resp = await boxed.call("decision_open", { id: "open-task", identity: true });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["id"], "open-task");
    assert.equal(payload(resp)["open"], true);
    assert.equal(payload(resp)["identity"], "2026-09-20T00:00:00Z 1");
  });
  it("decision diverged succeeds without approval (open read)", async () => {
    const resp = await boxed.call("decision_diverged", {});
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["diverged"], true);
    assert.equal(payload(resp)["count"], 1);
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
  it("review with release refuses captain-opened hold without grant", async () => {
    const resp = await boxed.call("review_decision", {
      id: "captain-hold", verdict: "approve", release: true, approval: APPROVAL,
    });
    assert.ok(isError(resp));
    assert.equal(payload(resp)["error"], "release unauthorized");
  });
  it("review with release allows captain-opened hold when FM_RELEASE_GRANT is enabled", async () => {
    const grantClient = new Client({ FM_HOME: sandbox, FM_RELEASE_GRANT: "1" });
    try {
      const resp = await grantClient.call("review_decision", {
        id: "captain-hold", verdict: "approve", release: true, approval: APPROVAL,
      });
      assert.equal(isError(resp), false);
      assert.equal(payload(resp)["id"], "captain-hold");
      assert.equal(payload(resp)["verdict"], "approve");
      assert.equal(payload(resp)["release"], true);
      assert.ok(typeof payload(resp)["decision_digest"] === "string");
    } finally {
      await grantClient.close();
    }
  });
  it("review valid call reaches captain-hold answer and stays structured", async () => {
    const resp = await boxed.call("review_decision", { id: "t1", verdict: "approve", approval: APPROVAL });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["id"], "t1");
    assert.equal(payload(resp)["verdict"], "approve");
    assert.ok(typeof payload(resp)["decision_digest"] === "string");
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
  it("home_summary_refresh runs the refresh stub", async () => {
    const resp = await boxed.call("home_summary_refresh", {});
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["best_effort"], false);
    assert.ok(((payload(resp)["stdout"] as string) ?? "").includes("home-summary-refresh-stub"));
  });
  it("home_summary_refresh echoes the best_effort flag", async () => {
    const resp = await boxed.call("home_summary_refresh", { best_effort: true });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["best_effort"], true);
    assert.ok(((payload(resp)["stdout"] as string) ?? "").includes("--best-effort"));
  });
  it("home_summary_refresh rejects non-bool best_effort", async () => {
    assert.equal(isError(await boxed.call("home_summary_refresh", { best_effort: "yes" })), true);
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
  it("mail_status reads config without network", async () => {
    const resp = await boxed.call("mail_status", {});
    assert.equal(isError(resp), false);
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("mail-stub:status"));
  });
  it("mail_read returns a never-marks-seen digest", async () => {
    const resp = await boxed.call("mail_read", {});
    assert.equal(isError(resp), false);
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("mail-stub:read"));
    assert.ok(String(payload(resp)["warning"] ?? "").includes("BODY.PEEK"));
  });
  it("mail_check runs the bounded inbound check", async () => {
    const resp = await boxed.call("mail_check", {});
    assert.equal(isError(resp), false);
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("mail-check-stub:check"));
  });
  it("mail_send refuses without approval", async () => {
    const resp = await boxed.call("mail_send", { to: "a@example.com", subject: "hi", body: "hello" });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("mail_send rejects bad recipient", async () => {
    assert.equal(
      isError(await boxed.call("mail_send", { to: "not-an-address", subject: "hi", body: "hello", approval: APPROVAL })),
      true,
    );
  });
  it("mail_send rejects multiline subject", async () => {
    assert.equal(
      isError(await boxed.call("mail_send", { to: "a@example.com", subject: "hi\nthere", body: "hello", approval: APPROVAL })),
      true,
    );
  });
  it("mail_send rejects empty body", async () => {
    assert.equal(
      isError(await boxed.call("mail_send", { to: "a@example.com", subject: "hi", body: "", approval: APPROVAL })),
      true,
    );
  });
  it("mail_send pipes the body via stdin with to echoed", async () => {
    const resp = await boxed.call("mail_send", {
      to: "a@example.com", subject: "hi", body: "hello via stdin", approval: APPROVAL,
    });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["to"], "a@example.com");
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("mail-stub:sent"));
  });
  it("voice_status defaults to counts without mic or model", async () => {
    const resp = await boxed.call("voice_status", {});
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["scope"], "counts");
  });
  it("voice_status passes the full scope through", async () => {
    const resp = await boxed.call("voice_status", { scope: "full" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["scope"], "full");
  });
  it("voice_status rejects unknown scopes", async () => {
    assert.equal(isError(await boxed.call("voice_status", { scope: "bogus" })), true);
  });
  it("voice_queue refuses without approval", async () => {
    const resp = await boxed.call("voice_queue", { text: "check the fleet" });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("voice_queue rejects multiline text", async () => {
    assert.equal(
      isError(await boxed.call("voice_queue", { text: "one\ntwo", approval: APPROVAL })),
      true,
    );
  });
  it("voice_queue hands the request over without audio", async () => {
    const resp = await boxed.call("voice_queue", { text: "check the fleet", approval: APPROVAL });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["queued"], true);
  });
  it("lint_versions returns both required pins", async () => {
    const resp = await boxed.call("lint_versions", {});
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["shellcheck"], "0.11.0");
    assert.equal(payload(resp)["actionlint"], "1.7.12");
  });
  it("tool_update_check reports without repairing", async () => {
    const resp = await boxed.call("tool_update_check", {});
    assert.equal(isError(resp), false);
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("tool-update-stub"));
  });
  it("vendor_auth_probe returns one sanitized line with probe echoed", async () => {
    const resp = await boxed.call("vendor_auth_probe", { probe: "grok" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["probe"], "grok");
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("status="));
  });
  it("vendor_auth_probe rejects probes outside the allowlist", async () => {
    assert.equal(isError(await boxed.call("vendor_auth_probe", { probe: "bogus" })), true);
  });
  it("startup_memory defaults to read with mode echoed", async () => {
    const resp = await boxed.call("startup_memory", {});
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["mode"], "read");
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("memory-stub:read"));
  });
  it("startup_memory passes the report mode through", async () => {
    const resp = await boxed.call("startup_memory", { mode: "report" });
    assert.equal(isError(resp), false);
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("memory-stub:report"));
  });
  it("startup_memory rejects unknown modes", async () => {
    assert.equal(isError(await boxed.call("startup_memory", { mode: "bogus" })), true);
  });
  it("pr_state reads blockers with url echoed", async () => {
    const resp = await boxed.call("pr_state", { url: "https://github.com/octo/repo/pull/42" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["url"], "https://github.com/octo/repo/pull/42");
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("pr-stub"));
  });
  it("pr_state rejects non-GitHub urls", async () => {
    assert.equal(
      isError(await boxed.call("pr_state", { url: "https://example.com/o/r/pull/1" })),
      true,
    );
  });
  it("pr_state rejects malformed urls", async () => {
    assert.equal(isError(await boxed.call("pr_state", { url: "not a url" })), true);
  });
  it("relay_poll short-polls without error", async () => {
    const resp = await boxed.call("relay_poll", {});
    assert.equal(isError(resp), false);
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("x-poll stub"));
  });
  it("decision_release records decision_digest in audit log", async () => {
    const auditFile = path.join(sandbox, "state", "mcp-audit.jsonl");
    const client = new Client({ FM_HOME: sandbox, FM_ACTOR: "audit-tester", FM_AUDIT_LOG: auditFile });
    try {
      const resp = await client.call("decision_release", {
        origin_id: "audit-tester",
        decision_key: "audit-key",
        routed_to: "task-99",
        decision_text: "decision text for audit test",
        approval: APPROVAL,
      });
      assert.equal(isError(resp), false);
      const digest = payload(resp)["decision_digest"] as string;
      assert.ok(typeof digest === "string" && digest.length === 64);
      assert.ok(fs.existsSync(auditFile));
      const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const matching = lines.find((l) => l.tool === "decision_release" && l.actor === "audit-tester");
      assert.ok(matching, "audit line for decision_release must exist");
      assert.equal(matching.decision_digest, digest);
    } finally {
      await client.close();
    }
  });
});
