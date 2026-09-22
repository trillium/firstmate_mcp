/**
 * Unit tests for the warmed-snapshot path: fleet_snapshot / backlog serve the
 * newest cached snapshot when the caller does not name one.
 *
 * Why this exists: the whole-fleet computation measures 95-110s on a real home
 * against a 30s envelope, so a snapshot can only be cached by a call that
 * finishes — receipt_submit(fleet_snapshot). Before this lookup, a caller that
 * did not already hold the snapshot_id recomputed on every paginated read and
 * was killed by the envelope (measured 35s on a home whose cache was warm).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SNAPSHOT_DIRNAME, SNAPSHOT_SCHEMA, SNAPSHOT_TTL_S } from "../src/constants.js";
import { TOOLS, liveContext, type ToolContext } from "../src/tools.js";
import type { RunResult } from "../src/runner.js";
import { makeStubHome, removeHome } from "./helpers.js";

const cacheDir = (home: string): string => path.join(home, "state", SNAPSHOT_DIRNAME);

function snapshotDoc(rev: string): Record<string, unknown> {
  return {
    schema: SNAPSHOT_SCHEMA,
    generated: "2026-09-22T19:29:01Z",
    rev,
    backlog: {},
    tasks: [
      { id: "a", current_state: { state: "in_flight" } },
      { id: "b", current_state: { state: "queued" } },
    ],
  };
}

function cacheSnapshot(
  home: string,
  id: string,
  doc: Record<string, unknown>,
  ageS = 0,
  ttlS: number = SNAPSHOT_TTL_S,
): void {
  fs.mkdirSync(cacheDir(home), { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir(home), `${id}.json`),
    JSON.stringify({
      snapshot_id: id,
      created: "2026-09-22T19:29:01Z",
      created_epoch: Date.now() / 1000 - ageS,
      ttl_s: ttlS,
      snapshot: doc,
    }),
    "utf8",
  );
}

function ctxWithRun(home: string, run: ToolContext["run"]): ToolContext {
  return {
    ...liveContext(),
    binDir: path.join(home, "bin"),
    stateDir: path.join(home, "state"),
    run,
  };
}

const explode: ToolContext["run"] = async () => {
  throw new Error("a warm cache must not execute a script");
};

describe("warmed snapshot: read path", () => {
  let home: string;
  before(() => {
    home = makeStubHome();
    cacheSnapshot(home, "snap-warm0000000001", snapshotDoc("warm"));
  });
  after(() => {
    removeHome(home);
  });

  it("serves the newest cached snapshot when no id is named, without running anything", async () => {
    const res = await TOOLS.fleet_snapshot.handler({ limit: 1 }, ctxWithRun(home, explode));
    assert.equal(res.isError, false, JSON.stringify(res.payload));
    assert.equal(res.payload["snapshot_id"], "snap-warm0000000001");
    assert.equal(res.payload["from_cache"], true);
    assert.equal(res.payload["stale"], false);
    assert.equal((res.payload["summary"] as Record<string, unknown>)["total"], 2);
  });

  it("paginates the warmed snapshot and reports the cursor for the next page", async () => {
    const res = await TOOLS.fleet_snapshot.handler({ limit: 1 }, ctxWithRun(home, explode));
    assert.equal((res.payload["page"] as unknown[]).length, 1);
    assert.equal(res.payload["next_cursor"], "snap-warm0000000001:1");
    assert.equal(res.payload["truncated"], true);
  });

  it("serves backlog from the same warmed snapshot", async () => {
    const res = await TOOLS.backlog.handler({}, ctxWithRun(home, explode));
    assert.equal(res.isError, false, JSON.stringify(res.payload));
    assert.equal(res.payload["from_cache"], true);
    assert.deepEqual(res.payload["task_counts"], {
      total: 2,
      by_state: { in_flight: 1, queued: 1 },
    });
  });

  it("prefers the newest of several cached snapshots", async () => {
    cacheSnapshot(home, "snap-old00000000001", snapshotDoc("old"), 600);
    const res = await TOOLS.fleet_snapshot.handler({ limit: 1 }, ctxWithRun(home, explode));
    assert.equal(res.payload["snapshot_id"], "snap-warm0000000001");
  });

  it("recomputes and reports from_cache=false when the cache is empty", async () => {
    const bare = makeStubHome();
    try {
      let runs = 0;
      const run = async (): Promise<RunResult> => {
        runs += 1;
        return { stdout: JSON.stringify(snapshotDoc("fresh")), stderr: "", exitCode: 0 };
      };
      const res = await TOOLS.fleet_snapshot.handler({ limit: 1 }, ctxWithRun(bare, run));
      assert.equal(res.isError, false, JSON.stringify(res.payload));
      assert.equal(res.payload["from_cache"], false);
      assert.equal(runs, 1);
      assert.equal(fs.readdirSync(cacheDir(bare)).length, 1, "the fetch must warm the cache");
    } finally {
      removeHome(bare);
    }
  });

  it("serves an expired snapshot with a stale stamp instead of recomputing", async () => {
    const staleHome = makeStubHome();
    try {
      cacheSnapshot(staleHome, "snap-stale000000001", snapshotDoc("stale"), SNAPSHOT_TTL_S * 4);
      let runs = 0;
      const run = async (): Promise<RunResult> => {
        runs += 1;
        return { stdout: JSON.stringify(snapshotDoc("fresh")), stderr: "", exitCode: 0 };
      };
      const res = await TOOLS.fleet_snapshot.handler({ limit: 1 }, ctxWithRun(staleHome, run));
      assert.equal(res.isError, false, JSON.stringify(res.payload));
      assert.equal(res.payload["from_cache"], true);
      assert.equal(res.payload["stale"], true, "an expired cache must say so");
      assert.ok(
        Number(res.payload["snapshot_age_s"]) > SNAPSHOT_TTL_S,
        `age must be reported, saw ${res.payload["snapshot_age_s"]}`,
      );
      assert.equal(runs, 0, "an expired cache must be served, never recomputed into the envelope");
    } finally {
      removeHome(staleHome);
    }
  });

  it("still fails loudly for an explicitly named unknown id", async () => {
    const res = await TOOLS.fleet_snapshot.handler(
      { snapshot_id: "snap-nope0000000000" },
      ctxWithRun(home, explode),
    );
    assert.equal(res.isError, true);
    assert.equal(res.payload["error"], "unknown snapshot");
  });
});
