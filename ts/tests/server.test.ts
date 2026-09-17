/**
 * End-to-end proof for the TypeScript smarts-only server.
 *
 * Preserved-provenance suite: every check mirrors test_client.py (the
 * upstream 67-check proof for the Python path) against the TS server, so
 * the shared behavioral contract is the referee between the two
 * implementations. Self-contained: stub firstmate homes pinned via FM_HOME.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL,
  Client,
  isError,
  makeEnvelopeStubHome,
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

describe("smarts surface: 19 tools, forbidden absent", () => {
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
  ];
  const FORBIDDEN = ["promote_scout", "teardown_crew", "arm_pr_check", "merge_pr", "merge_local"];

  it("smarts server lists 19 tools", async () => {
    const resp = await boxed.request("tools/list");
    const tools = (resp.result as Record<string, unknown>)["tools"] as Array<{ name: string }>;
    assert.equal(tools.length, 19);
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
});

describe("subprocess envelope", () => {
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

  it("fleet_snapshot survives a >30s slow snapshot", { timeout: 120000 }, async () => {
    const started = Date.now();
    const resp = await ebox.call("fleet_snapshot", {});
    const elapsedS = (Date.now() - started) / 1000;
    const snap = payload(resp);
    assert.equal(isError(resp), false);
    assert.equal(snap["generated"], "envelope-slow-large");
    assert.ok(elapsedS >= 30, `raised timeout must cover the slow path, took ${elapsedS.toFixed(1)}s`);
  });
  it("fleet_snapshot accepts >128KB output", async () => {
    const snap = payload(await ebox.call("fleet_snapshot", {}));
    assert.equal(((snap["tasks"] as unknown[]) ?? []).length, 800);
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
