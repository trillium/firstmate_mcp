/**
 * Fleet snapshot cache primitives. (slice 10a of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. Cache helpers are shared (doctor freshness, snapshot reads); all are exported. tools.ts imports them for the
 * TOOLS registry.
 */
import fs from "node:fs";
import path from "node:path";
import { SNAPSHOT_DIRNAME, SNAPSHOT_TTL_S } from "../constants.js";
import { utcNow } from "./receipts.js";
import { validId } from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export function snapshotDir(ctx: ToolContext): string {
  return path.join(ctx.stateDir, SNAPSHOT_DIRNAME);
}

export function writeCachedSnapshot(
  ctx: ToolContext,
  snapshotId: string,
  snapshot: Record<string, unknown>,
): boolean {
  const dir = snapshotDir(ctx);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.resolve(dir, `${snapshotId}.json`);
  if (path.dirname(file) !== path.resolve(dir)) return false;
  const record: Record<string, unknown> = {
    snapshot_id: snapshotId,
    created: utcNow(),
    created_epoch: Date.now() / 1000,
    ttl_s: SNAPSHOT_TTL_S,
    snapshot,
  };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record), "utf8");
  fs.renameSync(tmp, file);
  return true;
}

export function readCachedSnapshot(
  ctx: ToolContext,
  snapshotId: unknown,
): {
  snapshot: Record<string, unknown> | null;
  ageS: number | null;
  stale: boolean;
  error: Record<string, unknown> | null;
} {
  if (!validId(snapshotId)) {
    return {
      snapshot: null,
      ageS: null,
      stale: false,
      error: {
        error: "invalid snapshot_id",
        expect: "short snapshot id, no slashes or traversal",
      },
    };
  }
  const dir = path.resolve(snapshotDir(ctx));
  const file = path.resolve(dir, `${snapshotId}.json`);
  if (path.dirname(file) !== dir) {
    return {
      snapshot: null,
      ageS: null,
      stale: false,
      error: {
        error: "invalid snapshot_id",
        expect: "short snapshot id, no slashes or traversal",
      },
    };
  }
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (exc) {
    const nodeErr = exc as NodeJS.ErrnoException;
    if (nodeErr?.code === "ENOENT") {
      return {
        snapshot: null,
        ageS: null,
        stale: false,
        error: { error: "unknown snapshot", snapshot_id: snapshotId },
      };
    }
    return {
      snapshot: null,
      ageS: null,
      stale: false,
      error: { error: "cannot read snapshot", detail: String(exc) },
    };
  }
  if (typeof record !== "object" || record === null || record["snapshot_id"] !== snapshotId) {
    return {
      snapshot: null,
      ageS: null,
      stale: false,
      error: { error: "unknown snapshot", snapshot_id: snapshotId },
    };
  }
  const createdEpoch = typeof record["created_epoch"] === "number" ? record["created_epoch"] : NaN;
  const age = Date.now() / 1000 - createdEpoch;
  const ttl = typeof record["ttl_s"] === "number" ? record["ttl_s"] : SNAPSHOT_TTL_S;
  const snap = record["snapshot"];
  if (typeof snap !== "object" || snap === null) {
    return {
      snapshot: null,
      ageS: null,
      stale: false,
      error: { error: "corrupt snapshot record", snapshot_id: snapshotId },
    };
  }
  // An expired record is SERVED, not deleted. Recomputing is what costs 110s and
  // gets killed by the 30s envelope on a real home, so a stale answer carrying
  // its own age is strictly more useful than a timeout; freshness stays the
  // caller's decision because it is reported rather than hidden.
  return {
    snapshot: snap as Record<string, unknown>,
    ageS: Number.isFinite(age) ? age : null,
    stale: !(age <= ttl),
    error: null,
  };
}

/**
 * Newest unexpired cached snapshot id, or null when there is none.
 *
 * Pagination needs a snapshot_id, but a snapshot is only cached by a call that
 * can finish — and on a real home the whole-fleet computation (measured 95-110s)
 * exceeds the 30s envelope, so the only way to warm the cache is
 * receipt_submit(fleet_snapshot). Without this lookup the warmed cache was
 * unreachable to any caller that did not already hold the id, so every
 * paginated read recomputed and was killed by the envelope (measured 35s on a
 * home whose cache was already warm).
 */
export function latestCachedSnapshotId(ctx: ToolContext): string | null {
  const dir = path.resolve(snapshotDir(ctx));
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const suffix = ".json";
  let freshId: string | null = null;
  let freshEpoch = -Infinity;
  let anyId: string | null = null;
  let anyEpoch = -Infinity;
  for (const name of names) {
    if (!name.startsWith("snap-") || !name.endsWith(suffix)) continue;
    const id = name.slice(0, -suffix.length);
    if (!validId(id)) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      continue;
    }
    const epoch = typeof record["created_epoch"] === "number" ? record["created_epoch"] : NaN;
    if (!Number.isFinite(epoch)) continue;
    const ttl = typeof record["ttl_s"] === "number" ? record["ttl_s"] : SNAPSHOT_TTL_S;
    if (epoch > anyEpoch) {
      anyEpoch = epoch;
      anyId = id;
    }
    if (Date.now() / 1000 - epoch <= ttl && epoch > freshEpoch) {
      freshEpoch = epoch;
      freshId = id;
    }
  }
  // A fresh snapshot is preferred, but an expired one is still returned: the
  // caller gets an answer carrying its own age instead of a 35s envelope timeout.
  return freshId ?? anyId;
}

