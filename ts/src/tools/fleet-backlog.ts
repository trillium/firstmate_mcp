/**
 * Backlog read (derived from the snapshot). (slice 10c of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. Private as before; tools.ts imports them for the
 * TOOLS registry.
 */
import {
  SNAPSHOT_DEFAULT_LIMIT,
  SNAPSHOT_MAX_LIMIT,
  SNAPSHOT_MIN_LIMIT,
} from "../constants.js";
import { truncate } from "../runner.js";
import { getOrFetchSnapshot } from "./fleet-snapshot.js";
import { parseSnapshotCursor, validPageLimit } from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolBacklog(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
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

  const byState: Record<string, number> = {};
  for (const task of tasks) {
    const current = (task["current_state"] as Record<string, unknown> | undefined) ?? {};
    const state = (current["state"] as string) || "unknown";
    byState[state] = (byState[state] ?? 0) + 1;
  }

  if (!isPaginated) {
    return {
      payload: {
        snapshot_id: snapshotId,
        from_cache: fromCache,
        stale,
        snapshot_age_s: ageS === null ? null : Math.round(ageS),
        generated: snapshot["generated"],
        backlog: (snapshot["backlog"] as unknown) ?? {},
        task_counts: { total: tasks.length, by_state: byState },
      },
      isError: false,
    };
  }

  const offset = cursorResult.offset;
  const page = tasks.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < tasks.length;
  const nextCursor = hasMore ? `${snapshotId}:${nextOffset}` : null;
  const truncated = hasMore;

  return {
    payload: {
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
      backlog: (snapshot["backlog"] as unknown) ?? {},
      task_counts: { total: tasks.length, by_state: byState },
      page,
      next_cursor: nextCursor,
      truncated,
    },
    isError: false,
  };
}
