/**
 * Snapshot fetch + fleet_snapshot read. (slice 10b of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. Private as before; tools.ts imports them for the
 * TOOLS registry.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  MAX_OUTPUT_BYTES,
  SNAPSHOT_DEFAULT_LIMIT,
  SNAPSHOT_MAX_LIMIT,
  SNAPSHOT_MIN_LIMIT,
  SNAPSHOT_SCHEMA,
} from "../constants.js";
import { byteLength, isRunResult, truncate } from "../runner.js";
import {
  latestCachedSnapshotId,
  readCachedSnapshot,
  writeCachedSnapshot,
} from "./fleet-cache.js";
import { parseSnapshotCursor, validPageLimit } from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function getOrFetchSnapshot(
  ctx: ToolContext,
  snapshotId: string | null,
): Promise<
  | {
      snapshotId: string;
      snapshot: Record<string, unknown>;
      isError: false;
      fromCache: boolean;
      stale: boolean;
      ageS: number | null;
    }
  | { payload: Record<string, unknown>; isError: true }
> {
  if (snapshotId !== null) {
    const cached = readCachedSnapshot(ctx, snapshotId);
    if (cached.snapshot === null) {
      return { payload: cached.error ?? { error: "cannot read snapshot" }, isError: true };
    }
    return {
      snapshotId,
      snapshot: cached.snapshot,
      isError: false,
      fromCache: true,
      stale: cached.stale,
      ageS: cached.ageS,
    };
  }

  // No id requested: serve the newest warm snapshot instead of recomputing. An
  // explicitly requested id still fails loudly rather than silently serving a
  // different snapshot.
  const latest = latestCachedSnapshotId(ctx);
  if (latest !== null) {
    const cached = readCachedSnapshot(ctx, latest);
    if (cached.snapshot !== null) {
      return {
        snapshotId: latest,
        snapshot: cached.snapshot,
        isError: false,
        fromCache: true,
        stale: cached.stale,
        ageS: cached.ageS,
      };
    }
    if (cached.error !== null) {
      return { payload: cached.error, isError: true };
    }
  }

  const res = await ctx.run([path.join(ctx.binDir, "fm-fleet-snapshot.sh"), "--json"]);
  if (!isRunResult(res)) return { payload: res as Record<string, unknown>, isError: true };
  if (res.exitCode !== 0) {
    const [out] = truncate(res.stderr || res.stdout || "");
    return {
      payload: { error: "snapshot failed", exit: res.exitCode, output: out },
      isError: true,
    };
  }
  if (byteLength(res.stdout) > MAX_OUTPUT_BYTES) {
    return { payload: { error: "snapshot too large for PoC envelope" }, isError: true };
  }
  let snapshot: Record<string, unknown>;
  try {
    snapshot = JSON.parse(res.stdout) as Record<string, unknown>;
  } catch {
    const [out] = truncate(res.stdout);
    return { payload: { error: "snapshot was not JSON", output: out }, isError: true };
  }
  if (snapshot["schema"] !== SNAPSHOT_SCHEMA) {
    return {
      payload: { error: "unexpected snapshot schema", schema: snapshot["schema"] },
      isError: true,
    };
  }
  const newId = `snap-${randomBytes(8).toString("hex")}`;
  try {
    writeCachedSnapshot(ctx, newId, snapshot);
  } catch {
    /* caching failure is best effort */
  }
  return { snapshotId: newId, snapshot, isError: false, fromCache: false, stale: false, ageS: 0 };
}

// --- SUPPORTED: open reads + the single safe steer ---

export async function toolFleetSnapshot(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const isPaginated =
    args["cursor"] !== undefined ||
    args["limit"] !== undefined ||
    args["snapshot_id"] !== undefined;

  let limit = SNAPSHOT_DEFAULT_LIMIT;
  if (args["limit"] !== undefined) {
    const parsedLimit = validPageLimit(args["limit"]);
    if (parsedLimit === null) {
      return {
        payload: {
          error: "invalid limit",
          expect: `integer ${SNAPSHOT_MIN_LIMIT}..${SNAPSHOT_MAX_LIMIT}`,
        },
        isError: true,
      };
    }
    limit = parsedLimit;
  }

  const cursorResult = parseSnapshotCursor(args["cursor"], args["snapshot_id"]);
  if (!cursorResult.ok) {
    return {
      payload: { error: cursorResult.error, expect: cursorResult.expect },
      isError: true,
    };
  }

  const snapResult = await getOrFetchSnapshot(ctx, cursorResult.snapshotId);
  if (snapResult.isError) return { payload: snapResult.payload, isError: true };

  const { snapshotId, snapshot, fromCache, stale, ageS } = snapResult;
  const tasks = (snapshot["tasks"] as Array<Record<string, unknown>>) ?? [];

  if (!isPaginated) {
    return {
      payload: {
        ...snapshot,
        snapshot_id: snapshotId,
        from_cache: fromCache,
        stale,
        snapshot_age_s: ageS === null ? null : Math.round(ageS),
      },
      isError: false,
    };
  }

  const byState: Record<string, number> = {};
  for (const task of tasks) {
    const current = (task["current_state"] as Record<string, unknown> | undefined) ?? {};
    const state = (current["state"] as string) || "unknown";
    byState[state] = (byState[state] ?? 0) + 1;
  }

  const offset = cursorResult.offset;
  const page = tasks.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < tasks.length;
  const nextCursor = hasMore ? `${snapshotId}:${nextOffset}` : null;
  const truncated = hasMore;

  return {
    payload: {
      schema: SNAPSHOT_SCHEMA,
      snapshot_id: snapshotId,
      from_cache: fromCache,
      stale,
      snapshot_age_s: ageS === null ? null : Math.round(ageS),
      generated: snapshot["generated"],
      summary: {
        total: tasks.length,
        by_state: byState,
        generated: snapshot["generated"],
        rev: (snapshot["rev"] ?? snapshot["generation"] ?? null) as string | null,
      },
      page,
      next_cursor: nextCursor,
      truncated,
    },
    isError: false,
  };
}

