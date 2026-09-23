/**
 * Snapshot cursor parsing. (slice 20 of the validators.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/validators.ts. Exported there, re-exported via
 * validators.ts so the `./validators.js` public surface is unchanged.
 */
import path from "node:path";
import {
  APPROVAL_PREFIX,
  CORR_RE,
  CURSOR_RE,
  DELTA_WAIT_MAX,
  DELTA_WAIT_MIN,
  HANDOFF_LINES_MAX,
  HANDOFF_LINES_MIN,
  ID_RE,
  ISOLATION_POOL_RE,
  MAIL_BODY_MAX_CHARS,
  MAIL_SUBJECT_MAX_CHARS,
  MAIL_TO_MAX_CHARS,
  PROJECT_RE,
  PR_URL_RE,
  POLICY_COMMAND_MAX_CHARS,
  PR_BODY_MAX_BYTES,
  PR_TITLE_MAX_CHARS,
  QUOTA_CANDIDATE_RE,
  QUOTA_CANDIDATES_MAX,
  QUOTA_SNAPSHOT_MAX_CHARS,
  REL_PATH_RE,
  REMOTE_FILE_BYTES_MAX,
  REMOTE_FILE_BYTES_MIN,
  SEND_TEXT_MAX_CHARS,
  SHA256_RE,
  SNAPSHOT_DEFAULT_LIMIT,
  SNAPSHOT_MAX_LIMIT,
  SNAPSHOT_MIN_LIMIT,
  STARTUP_MEMORY_MODES,
  SUBAGENT_TOOL_MAX_CHARS,
  SUPERVISION_AFK_MODES,
  SUPERVISION_INSTRUCTIONS_HARNESSES,
  TEST_ISOLATION_LIST_MODES,
  TEST_RUN_LIST_MODES,
  VENDOR_AUTH_PROBES,
  VOICE_QUEUE_MAX_CHARS,
  VOICE_SCOPES,
} from "../constants.js";
import { validId } from "./core.js";
import type { ParsedCursor } from "./paths.js";

export function parseSnapshotCursor(
  cursor: unknown,
  snapshotIdArg?: unknown,
): ParsedCursor {
  let explicitSnapId: string | null = null;
  if (snapshotIdArg !== undefined) {
    if (!validId(snapshotIdArg)) {
      return {
        ok: false,
        error: "invalid snapshot_id",
        expect: "short snapshot id, no slashes or traversal",
      };
    }
    explicitSnapId = snapshotIdArg;
  }

  if (cursor === undefined || cursor === null) {
    return { ok: true, snapshotId: explicitSnapId, offset: 0 };
  }

  if (typeof cursor === "boolean") {
    return {
      ok: false,
      error: "invalid cursor",
      expect: "cursor string in format <snapshot_id>:<offset> or integer offset",
    };
  }

  if (typeof cursor === "number") {
    if (!Number.isInteger(cursor) || cursor < 0) {
      return {
        ok: false,
        error: "invalid cursor",
        expect: "nonnegative integer cursor or <snapshot_id>:<offset>",
      };
    }
    if (cursor === 0) {
      return { ok: true, snapshotId: explicitSnapId, offset: 0 };
    }
    if (explicitSnapId === null) {
      return {
        ok: false,
        error: "invalid cursor",
        expect: "cursor must include snapshot_id (<snapshot_id>:<offset>) when offset > 0",
      };
    }
    return { ok: true, snapshotId: explicitSnapId, offset: cursor };
  }

  if (typeof cursor === "string") {
    const trimmed = cursor.trim();
    if (trimmed.length === 0) {
      return {
        ok: false,
        error: "invalid cursor",
        expect: "non-empty cursor string",
      };
    }

    const match = CURSOR_RE.exec(trimmed);
    if (match) {
      const snapId = match[1]!;
      const offset = parseInt(match[2]!, 10);
      if (explicitSnapId !== null && explicitSnapId !== snapId) {
        return {
          ok: false,
          error: "cursor snapshot_id mismatch",
          expect: "cursor snapshot_id must match snapshot_id argument",
        };
      }
      return { ok: true, snapshotId: snapId, offset };
    }

    if (/^\d+$/.test(trimmed)) {
      const offset = parseInt(trimmed, 10);
      if (offset === 0) {
        return { ok: true, snapshotId: explicitSnapId, offset: 0 };
      }
      if (explicitSnapId === null) {
        return {
          ok: false,
          error: "invalid cursor",
          expect: "cursor must include snapshot_id (<snapshot_id>:<offset>) when offset > 0",
        };
      }
      return { ok: true, snapshotId: explicitSnapId, offset };
    }

    return {
      ok: false,
      error: "invalid cursor",
      expect: "cursor in format <snapshot_id>:<offset> or integer offset",
    };
  }

  return {
    ok: false,
    error: "invalid cursor",
    expect: "cursor string in format <snapshot_id>:<offset> or integer offset",
  };
}

