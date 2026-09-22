/**
 * Unit tests for the ledger-backed orientation path (home_summary /
 * home_summary_refresh).
 *
 * Context: the served fork line does not ship bin/fm-home-summary-refresh.sh
 * (the same fork-vs-upstream shape gap that leaves 24 doorway scripts
 * upstream-only), so state/home-summary.json was never published and every
 * orienting read fell back to an O(tasks) walk that measured 110s against a
 * 30s envelope. The doorway now publishes the ledger itself from the bounded
 * snapshot the served line does ship.
 *
 * These tests pin the declared contract rules (schema/contracts.yaml):
 * schema-checked output, atomic publish, O(1) read, and a read that never
 * triggers a refresh.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { HOME_SUMMARY_SCHEMA, TAIL_CAP_BYTES } from "../src/constants.js";
import { TOOLS, liveContext, type ToolContext } from "../src/tools.js";
import type { RunResult } from "../src/runner.js";
import { makeStubHome, removeHome } from "./helpers.js";

const ledgerPath = (home: string): string =>
  path.join(home, "state", "home-summary.json");

function summaryDoc(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: HOME_SUMMARY_SCHEMA,
    generated: "2026-09-22T19:18:00Z",
    generated_epoch: 1790095080,
    state: { in_flight: [] },
    counts: { tasks: 48 },
    ...extra,
  };
}

function ctxWithRun(home: string, run: ToolContext["run"]): ToolContext {
  return {
    ...liveContext(),
    binDir: path.join(home, "bin"),
    stateDir: path.join(home, "state"),
    run,
  };
}

/**
 * A stub home modelling the SERVED fork line: the shared stub set ships a
 * publisher for every tool, but the real fork line does not ship
 * fm-home-summary-refresh.sh, which is the whole reason the fallback exists.
 */
function servedLineHome(): string {
  const home = makeStubHome();
  fs.rmSync(path.join(home, "bin", "fm-home-summary-refresh.sh"), { force: true });
  return home;
}

const okRun =
  (stdout: string) =>
  async (): Promise<RunResult> => ({ stdout, stderr: "", exitCode: 0 });

describe("home summary ledger: publish path", () => {
  let home: string;
  before(() => {
    home = servedLineHome();
  });
  after(() => {
    removeHome(home);
  });

  it("publishes the ledger from the bounded snapshot when the publisher script is absent", async () => {
    assert.equal(
      fs.existsSync(path.join(home, "bin", "fm-home-summary-refresh.sh")),
      false,
      "stub home must not ship the publisher, or this is not the served-line case",
    );
    const ctx = ctxWithRun(home, okRun(JSON.stringify(summaryDoc())));
    const res = await TOOLS.home_summary_refresh.handler({}, ctx);
    assert.equal(res.isError, false, JSON.stringify(res.payload));
    assert.equal(res.payload["schema"], HOME_SUMMARY_SCHEMA);
    assert.equal(res.payload["generated_epoch"], 1790095080);
    assert.equal(fs.existsSync(ledgerPath(home)), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(ledgerPath(home), "utf8")), summaryDoc());
  });

  it("publishes mode-0600 on the state filesystem, never a shared-mode temp", async () => {
    const ctx = ctxWithRun(home, okRun(JSON.stringify(summaryDoc())));
    await TOOLS.home_summary_refresh.handler({}, ctx);
    const mode = fs.statSync(ledgerPath(home)).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`);
  });

  it("publishes a document larger than the 8 KiB tail cap intact", async () => {
    // Regression guard: routing this through ownedCall() would truncate stdout
    // at TAIL_CAP_BYTES and publish unparseable JSON.
    const filler = "x".repeat(TAIL_CAP_BYTES * 4);
    const doc = summaryDoc({ reason: filler });
    const text = JSON.stringify(doc);
    assert.ok(text.length > TAIL_CAP_BYTES, "fixture must exceed the tail cap");
    const ctx = ctxWithRun(home, okRun(text));
    const res = await TOOLS.home_summary_refresh.handler({}, ctx);
    assert.equal(res.isError, false, JSON.stringify(res.payload));
    assert.deepEqual(JSON.parse(fs.readFileSync(ledgerPath(home), "utf8")), doc);
  });

  it("refuses off-schema output and publishes nothing", async () => {
    const before = fs.readFileSync(ledgerPath(home), "utf8");
    const ctx = ctxWithRun(home, okRun(JSON.stringify({ schema: "fm-not-this.v1" })));
    const res = await TOOLS.home_summary_refresh.handler({}, ctx);
    assert.equal(res.isError, true);
    assert.equal(res.payload["error"], "home summary refresh produced off-schema output");
    assert.equal(res.payload["expect"], HOME_SUMMARY_SCHEMA);
    assert.equal(
      fs.readFileSync(ledgerPath(home), "utf8"),
      before,
      "a refused publish must leave the prior complete document",
    );
  });

  it("keeps the prior ledger when the snapshot fails", async () => {
    const before = fs.readFileSync(ledgerPath(home), "utf8");
    const ctx = ctxWithRun(home, async () => ({ stdout: "", stderr: "boom", exitCode: 1 }));
    const res = await TOOLS.home_summary_refresh.handler({}, ctx);
    assert.equal(res.isError, true);
    assert.equal(res.payload["error"], "home summary refresh failed");
    assert.equal(fs.readFileSync(ledgerPath(home), "utf8"), before);
  });

  it("points a too-slow publish at the receipt path", async () => {
    const ctx = ctxWithRun(home, async () => ({
      error: "timed out",
      timeout_s: 30,
    }));
    const res = await TOOLS.home_summary_refresh.handler({}, ctx);
    assert.equal(res.isError, true);
    assert.match(String(res.payload["hint"]), /receipt_submit/);
  });

  it("prefers the firstmate-owned publisher when the line ships it", async () => {
    const other = makeStubHome();
    try {
      fs.writeFileSync(path.join(other, "bin", "fm-home-summary-refresh.sh"), "#!/bin/sh\n", {
        mode: 0o755,
      });
      let seen: string[] = [];
      const ctx = ctxWithRun(other, async (argv) => {
        seen = argv;
        return { stdout: "refreshed", stderr: "", exitCode: 0 };
      });
      const res = await TOOLS.home_summary_refresh.handler({ best_effort: true }, ctx);
      assert.equal(res.isError, false, JSON.stringify(res.payload));
      assert.equal(seen[0], path.join(other, "bin", "fm-home-summary-refresh.sh"));
      assert.equal(seen[1], "--best-effort");
      assert.equal(res.payload["best_effort"], true);
    } finally {
      removeHome(other);
    }
  });
});

describe("home summary ledger: read path", () => {
  let home: string;
  before(async () => {
    home = servedLineHome();
    const ctx = ctxWithRun(home, okRun(JSON.stringify(summaryDoc())));
    const res = await TOOLS.home_summary_refresh.handler({}, ctx);
    assert.equal(res.isError, false);
  });
  after(() => {
    removeHome(home);
  });

  it("reads the ledger without running anything (O(1), never a refresh)", async () => {
    const ctx = ctxWithRun(home, async () => {
      throw new Error("the read path must not execute a script");
    });
    const res = await TOOLS.home_summary.handler({}, ctx);
    assert.equal(res.isError, false, JSON.stringify(res.payload));
    assert.equal(res.payload["schema"], HOME_SUMMARY_SCHEMA);
    assert.equal(res.payload["generated_epoch"], 1790095080);
  });

  it("names the reason when the ledger is unpublished", async () => {
    const bare = servedLineHome();
    try {
      const ctx = ctxWithRun(bare, okRun(""));
      const res = await TOOLS.home_summary.handler({}, ctx);
      assert.equal(res.isError, true);
      assert.equal(res.payload["error"], "no home summary");
      assert.match(String(res.payload["expect"]), /state\/home-summary\.json/);
    } finally {
      removeHome(bare);
    }
  });

  it("refuses an off-schema ledger rather than serving it", async () => {
    fs.writeFileSync(ledgerPath(home), JSON.stringify({ schema: "fm-wrong.v1" }), "utf8");
    try {
      const res = await TOOLS.home_summary.handler({}, ctxWithRun(home, okRun("")));
      assert.equal(res.isError, true);
    } finally {
      fs.writeFileSync(ledgerPath(home), JSON.stringify(summaryDoc()), "utf8");
    }
  });
});
