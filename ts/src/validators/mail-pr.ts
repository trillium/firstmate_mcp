/**
 * Merge, branch, title, body, base, run-mode, family, lane, ref, content validators. (slice 20 of the validators.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/validators.ts. Exported there, re-exported via
 * validators.ts so the `./validators.js` public surface is unchanged.
 */
import path from "node:path";
import { byteLength } from "../runner.js";
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

export function validMergeMethod(value: unknown): value is "squash" | "merge" | "rebase" {
  return value === "squash" || value === "merge" || value === "rebase";
}

/**
 * Extension binding id: the exact shape fm-extension.mjs owns.
 * Mirrors boundedString(<id>, 128, ID_RE) in bin/fm-extension.mjs, so the
 * handler refuses before spawning what the script would refuse after.
 */
const EXTENSION_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export function validExtensionId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || Buffer.byteLength(value, "utf8") > 128) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) return false;
  return EXTENSION_ID_RE.test(value);
}

export function validCommitMessage(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > 500) return false;
  if (/[\r\n]/.test(value)) return false;
  return true;
}

/** A git branch name for read-only queries (history, polls). Same
 * charset/traversal rules as validBranchName, but default branches are
 * allowed: reading main's history is the primary use case. */
export function validReadBranch(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > 100) return false;
  if (!/^[a-zA-Z0-9._/-]+$/.test(value)) return false;
  if (value.includes("..") || value.startsWith("/") || value.endsWith("/")) return false;
  return true;
}

export function validBranchName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > 100) return false;
  if (value === "main" || value === "master") return false;
  if (!/^[a-zA-Z0-9._/-]+$/.test(value)) return false;
  if (value.includes("..") || value.startsWith("/") || value.endsWith("/")) return false;
  return true;
}

/**
 * A PR title: one line, non-empty, bounded. Multi-line titles break the
 * one-line commit/PR convention this repo enforces by hook.
 */
export function validPrTitle(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > PR_TITLE_MAX_CHARS) return false;
  return !/[\r\n]/.test(value);
}

/**
 * A PR body: non-empty and bounded. The doorway never opens a bodyless PR —
 * the rationale is the artifact a reviewer actually reads — and passing a body
 * also keeps `gh pr create` from opening an editor.
 */
export function validPrBody(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1) return false;
  return byteLength(value) <= PR_BODY_MAX_BYTES;
}

/**
 * A PR base branch. Unlike validBranchName (which guards repo_push against
 * pushing to the default branch) the default branch is a legitimate target.
 */
export function validBaseBranch(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > 100) return false;
  if (!/^[a-zA-Z0-9._/-]+$/.test(value)) return false;
  if (value.includes("..") || value.startsWith("/") || value.endsWith("/")) return false;
  return true;
}

/**
 * A test-runner selection mode. Exactly one selects what runs; suite runs are
 * minutes-long, so callers reach for receipt_submit rather than a direct call.
 */
export function validTestRunMode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ["all", "family", "changed", "lane", "proven-isolated", "scripts"].includes(value)
  );
}

/** A test family name, as fm-test-run.sh --list-families reports them. */
export function validTestFamily(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
}

/**
 * A lane name: portable-parallel-1|2, portable-serial, or one CI serial shard
 * portable-serial-<k>of<n>. Anything else is refused rather than passed through.
 */
export function validTestLane(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^portable-(parallel-[12]|serial(-[1-9][0-9]*of[1-9][0-9]*)?)$/.test(value)
  );
}

/** A git ref used as --base for the changed selection; never a revision range. */
export function validGitRef(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > 100) return false;
  if (!/^[a-zA-Z0-9._/-]+$/.test(value)) return false;
  if (value.includes("..") || value.startsWith("/") || value.endsWith("/")) return false;
  return true;
}

/**
 * An explicit test script path: tests/<name>.test.sh only. Absolute paths and
 * traversal are refused, so the tool cannot be pointed at arbitrary files.
 */
export function validTestScriptPath(value: unknown): value is string {
  return typeof value === "string" && /^tests\/[A-Za-z0-9._-]{1,80}\.test\.sh$/.test(value);
}

export function validFileContent(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return byteLength(value) <= 256 * 1024;
}

