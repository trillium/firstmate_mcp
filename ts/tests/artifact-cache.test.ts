/**
 * Tests for the cached whole-home reads (fleet_view, bearings_snapshot).
 *
 * Both scripts re-run the 110s `fm-fleet-snapshot.sh` walk internally and were
 * measured at 35s timeouts while four sibling reads answered in 20-180ms.
 * `fm-fleet-snapshot.sh` has no cache-reuse flag, so the doorway caches the
 * projection: one successful run warms it, later reads serve it with an explicit
 * age, and a cold read still runs the script rather than fabricating output.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ARTIFACT_DIRNAME, ARTIFACT_TTL_S, BEARINGS_SCHEMA } from "../src/constants.js";
import { TOOLS, type ToolContext } from "../src/tools.js";
import type { RunResult } from "../src/runner.js";
import { makeStubHome, removeHome } from "./helpers.js";

type RunOutcome = RunResult | Record<string, unknown>;
type Seen = { calls: string[][]; result: RunOutcome };

const homes: string[] = [];
after(() => {
  for (const home of homes) removeHome(home);
});

/** One stub home per context, whose run outcome is the seen.result by default. */
function makeCtx(seen: Seen, result?: RunOutcome): ToolContext {
  const home = makeStubHome();
  homes.push(home);
  const outcome = result ?? seen.result;
  const run = (async (argv: string[]) => {
    seen.calls.push(argv);
    return outcome;
  }) as ToolContext["run"];
  return {
    binDir: path.join(home, "bin"),
    stateDir: path.join(home, "state"),
    dataDir: path.join(home, "data"),
    run,
  };
}

const artifactDir = (ctx: ToolContext): string => path.join(ctx.stateDir, ARTIFACT_DIRNAME);

const rewriteArtifacts = (ctx: ToolContext, mutate: (record: Record<string, unknown>) => void): void => {
  const dir = artifactDir(ctx);
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    mutate(record);
    fs.writeFileSync(file, JSON.stringify(record));
  }
};

const bearingsDoc = (generated: string): string =>
  JSON.stringify({ schema: BEARINGS_SCHEMA, generated, in_flight: [] });

describe("fleet_view caching", () => {
  it("runs the script on a cold cache and warms it", async () => {
    const seen: Seen = { calls: [], result: { stdout: "fleet view text", stderr: "", exitCode: 0 } };
    const ctx = makeCtx(seen);
    const res = await TOOLS["fleet_view"].handler({}, ctx);
    assert.equal(res.isError, false, JSON.stringify(res.payload));
    assert.equal(res.payload["from_cache"], false);
    assert.equal(res.payload["stdout"], "fleet view text");
    assert.equal(seen.calls.length, 1);
    assert.equal(fs.readdirSync(artifactDir(ctx)).length, 1, "a successful run must warm the artifact");
  });

  it("serves a warm artifact without running anything, with its age", async () => {
    const seen: Seen = { calls: [], result: { stdout: "fleet view text", stderr: "", exitCode: 0 } };
    const ctx = makeCtx(seen);
    await TOOLS["fleet_view"].handler({}, ctx);
    seen.calls = [];
    const second = await TOOLS["fleet_view"].handler({}, ctx);
    assert.equal(second.payload["from_cache"], true);
    assert.equal(second.payload["stale"], false);
    assert.ok(Number(second.payload["snapshot_age_s"]) >= 0);
    assert.deepEqual(seen.calls, [], "a warm read must not re-run the walk");
  });

  it("marks an expired artifact stale instead of serving it as fresh", async () => {
    const seen: Seen = { calls: [], result: { stdout: "fleet view text", stderr: "", exitCode: 0 } };
    const ctx = makeCtx(seen);
    await TOOLS["fleet_view"].handler({}, ctx);
    rewriteArtifacts(ctx, (record) => {
      record["created_epoch"] = Date.now() / 1000 - ARTIFACT_TTL_S * 3;
    });
    seen.calls = [];
    const res = await TOOLS["fleet_view"].handler({}, ctx);
    assert.equal(res.payload["from_cache"], true);
    assert.equal(res.payload["stale"], true);
    assert.ok(Number(res.payload["snapshot_age_s"]) > ARTIFACT_TTL_S);
    assert.deepEqual(seen.calls, [], "a stale artifact beats the envelope");
  });

  it("keeps separate artifacts per argument set", async () => {
    const seen: Seen = { calls: [], result: { stdout: "text", stderr: "", exitCode: 0 } };
    const ctx = makeCtx(seen);
    await TOOLS["fleet_view"].handler({}, ctx);
    assert.equal(fs.readdirSync(artifactDir(ctx)).length, 1);
  });

  it("points a timed-out cold read at the receipt path", async () => {
    const seen: Seen = { calls: [], result: { error: "timed out", timeout_s: 30 } };
    const res = await TOOLS["fleet_view"].handler({}, makeCtx(seen));
    assert.equal(res.isError, true);
    assert.equal(res.payload["long_running"], true);
    assert.match(String(res.payload["hint"]), /receipt_submit/);
  });
});

describe("bearings_snapshot caching", () => {
  it("caches a schema-valid projection and serves it warm", async () => {
    const seen: Seen = {
      calls: [],
      result: { stdout: bearingsDoc("2026-09-22T00:00:00Z"), stderr: "", exitCode: 0 },
    };
    const ctx = makeCtx(seen);
    const first = await TOOLS["bearings_snapshot"].handler({}, ctx);
    assert.equal(first.isError, false, JSON.stringify(first.payload));
    assert.equal(first.payload["from_cache"], false);
    seen.calls = [];
    const second = await TOOLS["bearings_snapshot"].handler({}, ctx);
    assert.equal(second.isError, false);
    assert.equal(second.payload["from_cache"], true);
    assert.equal(second.payload["schema"], BEARINGS_SCHEMA);
    assert.deepEqual(seen.calls, []);
  });

  it("ignores an off-schema cached record rather than serving it", async () => {
    const seen: Seen = { calls: [], result: { stdout: bearingsDoc("fresh"), stderr: "", exitCode: 0 } };
    const ctx = makeCtx(seen);
    await TOOLS["bearings_snapshot"].handler({}, ctx);
    rewriteArtifacts(ctx, (record) => {
      record["stdout"] = JSON.stringify({ schema: "wrong.v1" });
    });
    seen.calls = [];
    const res = await TOOLS["bearings_snapshot"].handler({}, ctx);
    assert.equal(seen.calls.length, 1, "an off-schema cache must fall through to the script");
    assert.equal(res.payload["from_cache"], false);
  });

  it("does not cache a failed run", async () => {
    const seen: Seen = { calls: [], result: { stdout: "", stderr: "boom", exitCode: 1 } };
    const ctx = makeCtx(seen);
    const res = await TOOLS["bearings_snapshot"].handler({}, ctx);
    assert.equal(res.isError, true);
    assert.equal(fs.existsSync(artifactDir(ctx)) && fs.readdirSync(artifactDir(ctx)).length > 0, false);
  });
});
