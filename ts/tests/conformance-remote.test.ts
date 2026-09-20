/**
 * Conformance fixtures: Remote, digest, mail, and voice tools equivalence against firstmate scripts.
 * Shard 2/3: Secondmate remote reads, digests, mail, and voice records.
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
  HOME_SUMMARY_FIXTURE,
} from "./conformance-helpers.js";

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
