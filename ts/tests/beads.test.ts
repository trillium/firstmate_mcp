import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TOOLS, liveContext, type ToolContext } from "../src/tools.js";
import { makeStubHome } from "./helpers.js";

function ctx(home: string): ToolContext {
  return {
    ...liveContext(),
    binDir: path.join(home, "bin"),
    stateDir: path.join(home, "state"),
  };
}

function writeMirror(home: string, view: string, doc: unknown): void {
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "state", `.beads-mirror-${view}.json`),
    JSON.stringify(doc),
  );
}

function writeQueue(home: string, lines: string[]): void {
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  fs.writeFileSync(path.join(home, "state", ".beads-write-queue"), lines.join("\n"));
}

describe("beads durability reads", () => {
  test("mirror serves output with freshness age", async () => {
    const home = makeStubHome();
    const written = Math.floor(Date.now() / 1000) - 60;
    writeMirror(home, "ready", { written_at: written, output: "bead-1 open" });
    const res = await TOOLS["beads_mirror"].handler({ view: "ready" }, ctx(home));
    assert.equal(res.isError, false);
    const p = res.payload as Record<string, unknown>;
    assert.equal(p["present"], true);
    assert.equal(p["output"], "bead-1 open");
    assert.equal(p["written_at"], written);
    assert.ok((p["age_s"] as number) >= 60);
    assert.equal(p["stale"], false);
  });

  test("mirror rejects bad view names", async () => {
    const home = makeStubHome();
    for (const view of ["", "../x", "a,b", "UPPER"]) {
      const res = await TOOLS["beads_mirror"].handler({ view }, ctx(home));
      assert.equal(res.isError, true, view || "(empty)");
    }
  });

  test("mirror absent file is typed degraded state, not an error", async () => {
    const home = makeStubHome();
    const res = await TOOLS["beads_mirror"].handler({ view: "fleet" }, ctx(home));
    assert.equal(res.isError, false);
    assert.equal((res.payload as Record<string, unknown>)["present"], false);
  });

  test("mirror malformed document is typed degraded state", async () => {
    const home = makeStubHome();
    writeMirror(home, "ready", { written_at: "yesterday", output: 42 });
    const res = await TOOLS["beads_mirror"].handler({ view: "ready" }, ctx(home));
    assert.equal(res.isError, false);
    assert.equal((res.payload as Record<string, unknown>)["present"], false);
  });

  test("queue reports count plus oldest without argv", async () => {
    const home = makeStubHome();
    const now = Math.floor(Date.now() / 1000);
    writeQueue(home, [
      JSON.stringify({
        queued_at: now - 300,
        task_id: "task-abc",
        description: "dispatch=sent",
        argv: ["set-state", "task-abc", "dispatch=sent"],
      }),
      JSON.stringify({
        queued_at: now - 10,
        task_id: "task-def",
        description: "assign agent",
        argv: ["assign", "task-def", "agent"],
      }),
    ]);
    const res = await TOOLS["beads_queue"].handler({}, ctx(home));
    assert.equal(res.isError, false);
    const p = res.payload as Record<string, unknown>;
    assert.equal(p["pending"], 2);
    const oldest = p["oldest"] as Record<string, unknown>;
    assert.equal(oldest["task_id"], "task-abc");
    assert.equal(oldest["description"], "dispatch=sent");
    assert.ok((oldest["age_s"] as number) >= 300);
    assert.ok(!("argv" in oldest), "pending-write argv must not surface");
    assert.ok(!("argv" in p), "pending-write argv must not surface");
  });

  test("queue absent file is typed empty, not an error", async () => {
    const home = makeStubHome();
    const res = await TOOLS["beads_queue"].handler({}, ctx(home));
    assert.equal(res.isError, false);
    const p = res.payload as Record<string, unknown>;
    assert.equal(p["pending"], 0);
    assert.equal(p["present"], false);
  });

  test("queue malformed oldest is flagged, count preserved", async () => {
    const home = makeStubHome();
    writeQueue(home, ["{not json"]);
    const res = await TOOLS["beads_queue"].handler({}, ctx(home));
    assert.equal(res.isError, false);
    const p = res.payload as Record<string, unknown>;
    assert.equal(p["pending"], 1);
    assert.equal((p["oldest"] as Record<string, unknown>)["malformed"], true);
  });
});

describe("ledger list read", () => {
  const stubRun = (stdout: string) => async (): Promise<RunResult> => ({
    stdout,
    stderr: "",
    exitCode: 0,
  });
  type RunResult = import("../src/runner.js").RunResult;

  function ledgerCtx(home: string, stdout: string): ToolContext {
    return {
      ...liveContext(),
      binDir: path.join(home, "bin"),
      stateDir: path.join(home, "state"),
      run: stubRun(stdout),
    };
  }

  test("lists likely-dropped beads through the owning script", async () => {
    const home = makeStubHome();
    const scriptOut = JSON.stringify([
      { id: "task-1", title: "old work", status: "open", updated_at: "2026-09-01", likely_dropped: true },
    ]);
    const res = await TOOLS["ledger_list"].handler({}, ledgerCtx(home, scriptOut));
    assert.equal(res.isError, false);
    assert.ok(JSON.stringify(res.payload).includes("task-1"));
  });

  test("stale_days outside 1..30 is refused", async () => {
    const home = makeStubHome();
    for (const stale of [0, 31, -1, 1.5, "x"]) {
      const res = await TOOLS["ledger_list"].handler(
        { stale_days: stale },
        ledgerCtx(home, "[]"),
      );
      assert.equal(res.isError, true, String(stale));
    }
  });

  test("close verbs are refused", async () => {
    const home = makeStubHome();
    for (const args of [{ close: ["task-1"] }, { close_all: true }]) {
      const res = await TOOLS["ledger_list"].handler(args, ledgerCtx(home, "[]"));
      assert.equal(res.isError, true);
      assert.ok(JSON.stringify(res.payload).includes("not exposed"));
    }
  });
});

describe("ledger envelope", () => {
  test("oversized store output truncates with flags, never errors", async () => {
    const home = makeStubHome();
    const big = JSON.stringify([{ id: "x".repeat(100), title: "y".repeat(1000) }]).repeat(200);
    const run = async (): Promise<RunResult> => ({ stdout: big, stderr: "", exitCode: 0 });
    type RunResult = import("../src/runner.js").RunResult;
    const res = await TOOLS["ledger_list"].handler(
      {},
      {
        ...liveContext(),
        binDir: `${home}/bin`,
        stateDir: `${home}/state`,
        run,
      },
    );
    assert.equal(res.isError, false);
    assert.equal(
      (res.payload as Record<string, unknown>)["stdout_truncated"],
      true,
    );
  });
});

describe("reap triage + forge reads", () => {
  type RunResult = import("../src/runner.js").RunResult;
  const stubRun =
    (stdout: string) =>
    async (): Promise<RunResult> => ({ stdout, stderr: "", exitCode: 0 });

  function reapCtx(home: string, stdout: string): ToolContext {
    return {
      ...liveContext(),
      binDir: `${home}/bin`,
      stateDir: `${home}/state`,
      run: stubRun(stdout),
    };
  }

  test("reap triage passes through the owning script JSON", async () => {
    const home = makeStubHome();
    const scriptOut = JSON.stringify({ panes: [], classifications: [] });
    const res = await TOOLS["reap_triage"].handler({}, reapCtx(home, scriptOut));
    assert.equal(res.isError, false);
    assert.ok(JSON.stringify(res.payload).includes("classifications"));
  });

  test("coderabbit state validates owner, repo, and pr", async () => {
    const home = makeStubHome();
    const ok = await TOOLS["coderabbit_state"].handler(
      { owner: "trillium", repo: "firstmate", pr: 67 },
      reapCtx(home, "reviewed"),
    );
    assert.equal(ok.isError, false);
    for (const args of [
      { owner: "../x", repo: "firstmate", pr: 67 },
      { owner: "trillium", repo: "firstmate", pr: 0 },
      { owner: "trillium", repo: "firstmate", pr: -3 },
      { owner: "trillium", repo: "firstmate", pr: "x" },
    ]) {
      const res = await TOOLS["coderabbit_state"].handler(args, reapCtx(home, "reviewed"));
      assert.equal(res.isError, true, JSON.stringify(args));
    }
  });
});

describe("archaeology reads", () => {
  type RunResult = import("../src/runner.js").RunResult;
  const stubRun =
    (stdout: string) =>
    async (_argv: string[], _opts?: unknown): Promise<RunResult> => ({
      stdout,
      stderr: "",
      exitCode: 0,
    });

  function archCtx(home: string, stdout: string): ToolContext {
    return {
      ...liveContext(),
      binDir: `${home}/bin`,
      stateDir: `${home}/state`,
      run: stubRun(stdout) as ToolContext["run"],
    };
  }

  test("git history passes through bounded log output", async () => {
    const home = makeStubHome();
    fs.mkdirSync(path.join(home, ".git"));
    const res = await TOOLS["git_history"].handler(
      { repo: home, limit: 5 },
      archCtx(home, "abc1234 subject\n"),
    );
    assert.equal(res.isError, false);
    assert.ok(JSON.stringify(res.payload).includes("abc1234"));
  });

  test("repo confinement refuses escapes", async () => {
    const home = makeStubHome();
    fs.mkdirSync(path.join(home, ".git"));
    for (const repo of ["/etc", "/tmp/../etc", ""] ) {
      void repo;
    }
    for (const args of [
      { repo: "/etc" },
      { repo: `${home}/../escape` },
      { limit: 500 },
      { repo: home, paths: [`../escape`] },
      { repo: home, paths: [] },
    ]) {
      const res = await TOOLS["git_history"].handler(args, archCtx(home, ""));
      assert.equal(res.isError, true, JSON.stringify(args));
    }
  });

  test("blame validates file and range", async () => {
    const home = makeStubHome();
    fs.mkdirSync(path.join(home, ".git"));
    const ok = await TOOLS["git_blame"].handler(
      { repo: home, file: "a.ts", start: 1, end: 10 },
      archCtx(home, "blame"),
    );
    assert.equal(ok.isError, false);
    for (const args of [
      { repo: home, file: "../x", start: 1, end: 2 },
      { repo: home, file: "a.ts", start: 0, end: 2 },
      { repo: home, file: "a.ts", start: 5, end: 2 },
      { repo: home, file: "a.ts", start: 1, end: 500 },
    ]) {
      const res = await TOOLS["git_blame"].handler(args, archCtx(home, ""));
      assert.equal(res.isError, true, JSON.stringify(args));
    }
  });

  test("ci history validates branch and parses runs", async () => {
    const home = makeStubHome();
    fs.mkdirSync(path.join(home, ".git"));
    const runs = JSON.stringify([{ conclusion: "success", headBranch: "main" }]);
    const ok = await TOOLS["ci_history"].handler(
      { repo: home, branch: "main" },
      archCtx(home, runs),
    );
    assert.equal(ok.isError, false);
    assert.equal(
      ((ok.payload as Record<string, unknown>)["runs"] as unknown[]).length,
      1,
    );
    const bad = await TOOLS["ci_history"].handler(
      { repo: home, branch: "../x" },
      archCtx(home, runs),
    );
    assert.equal(bad.isError, true);
  });
});

describe("fleet activity ledger + devin config", () => {
  type RunResult = import("../src/runner.js").RunResult;
  const stubRun =
    (stdout: string) =>
    async (): Promise<RunResult> => ({ stdout, stderr: "", exitCode: 0 });

  function actCtx(home: string, stdout = ""): ToolContext {
    return {
      ...liveContext(),
      binDir: `${home}/bin`,
      stateDir: `${home}/state`,
      run: stubRun(stdout),
    };
  }

  function writeLedger(home: string, lines: string[]): void {
    fs.mkdirSync(path.join(home, "state"), { recursive: true });
    fs.writeFileSync(path.join(home, "state", "fleet-ledger.jsonl"), lines.join("\n"));
  }

  test("ledger tails records with counts", async () => {
    const home = makeStubHome();
    writeLedger(home, [
      JSON.stringify({ v: 1, ts: 100, event: "dispatched", task: "a" }),
      JSON.stringify({ v: 1, ts: 200, event: "merged", task: "b" }),
      "{broken",
    ]);
    const res = await TOOLS["fleet_ledger"].handler({ limit: 10 }, actCtx(home));
    assert.equal(res.isError, false);
    const p = res.payload as Record<string, unknown>;
    assert.equal(p["present"], true);
    assert.equal(p["total_lines"], 3);
    assert.equal((p["records"] as unknown[]).length, 2);
    assert.equal(p["dropped_malformed"], 1);
  });

  test("ledger absent file is typed degraded state", async () => {
    const home = makeStubHome();
    const res = await TOOLS["fleet_ledger"].handler({}, actCtx(home));
    assert.equal(res.isError, false);
    assert.equal((res.payload as Record<string, unknown>)["present"], false);
  });

  test("ledger rejects bad limits", async () => {
    const home = makeStubHome();
    for (const limit of [0, 101, -1, "x"]) {
      const res = await TOOLS["fleet_ledger"].handler({ limit }, actCtx(home));
      assert.equal(res.isError, true, String(limit));
    }
  });

  test("devin config validates identifiers", async () => {
    const home = makeStubHome();
    const ok = await TOOLS["devin_config"].handler(
      { task_id: "task-1", busy_gen: "g7", approval: "I authorize" },
      actCtx(home, "ok"),
    );
    assert.equal(ok.isError, false);
    for (const args of [
      { task_id: "../x", busy_gen: "g7", approval: "I authorize" },
      { task_id: "task-1", busy_gen: "", approval: "I authorize" },
      { task_id: "task-1", busy_gen: "g 7", approval: "I authorize" },
    ]) {
      const res = await TOOLS["devin_config"].handler(args, actCtx(home, "ok"));
      assert.equal(res.isError, true, JSON.stringify(args));
    }
  });
});

describe("fork advisory reads", () => {
  type RunResult = import("../src/runner.js").RunResult;

  test("fork origin check passes through the owning script", async () => {
    const home = makeStubHome();
    const scriptOut = "MISCONFIGURED: demo - origin (git@github.com:other/demo) is not trillium\n";
    const run = async (): Promise<RunResult> => ({ stdout: scriptOut, stderr: "", exitCode: 0 });
    const res = await TOOLS["fork_origin_check"].handler(
      {},
      {
        ...liveContext(),
        binDir: `${home}/bin`,
        stateDir: `${home}/state`,
        run,
      },
    );
    assert.equal(res.isError, false);
    assert.ok(JSON.stringify(res.payload).includes("MISCONFIGURED"));
  });
});
