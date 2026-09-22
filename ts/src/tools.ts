/**
 * The 63 smarts-only tools, in feature-manifest order.
 *
 * SUPPORTED (no approval): fleet_snapshot, backlog, crew_state,
 * status_tail, send_message (+ fleet_poll, the read-only poller, peek,
 * fleet_view, review_diff, bearings_snapshot, wake_drain, guard_check,
 * remote_doctor, remote_file, remote_delta, extension_list,
 * extension_inspect, handoff_status,
 * harness_detect, project_mode, lock_status, lease_check,
 * bearings_board_path, inbox_status, inbox_list, home_summary,
 * home_summary_refresh, contributions_snapshot, contributions_pending,
 * mail_status, mail_read, mail_check, dispatch_resolve, sessionstart_nudge,
 * voice_status, lint_versions, tool_update_check, vendor_auth_probe,
 * startup_memory, startup_network_report, doc_audience_check,
 * home_seed_validate, stow_cascade, test_isolation_list, test_run_list,
 * pr_state, pr_poll, pr_reviewers, arm_policy_check, cd_policy_check,
 * subagent_policy_check, supervision_instructions, quota_choose, relay_poll,
 * plus receipt_submit/receipt_status, the fail-closed async receipts).
 * CHANGED (approval-gated): decision_hold, decision_resolve,
 * lifecycle_interrupt/exit/relaunch/suspend/resume, relay_reply/dismiss/
 * followup, review_decision, scaffold_brief, spawn_crew,
 * secondmate_nudge/restart/report, remote_control, handoff_move,
 * voice_queue, mail_send, session_start, sessionstart_run/cursor,
 * herdr_lab, herdr_ci_cleanup, session_cleanup, claude_trust,
 * agy_trust, claude_stop_autoarm, herdr_eventwait/workspace_move.
 *
 * Refused by the deny-list (no tool, answered unknown): promote_scout,
 * teardown_crew, arm_pr_check, merge_pr, merge_local, daemon_start/stop/
 * restart, watch_start/stop, repo_edit/commit/push/merge, backend_select
 * (the sourced backend-provider library and its backends/*.sh adapters),
 * on_execute, config_push, remote_entrypoint, remote_herdr_guard,
 * remote_provision, remote_seed, inherit_push, remote_inherit,
 * reap_orphans, remote_worker, bootstrap, check_register,
 * check_unregister, agents_md_ensure, install_actionlint, install_herdr,
 * install_shellcheck, install_treehouse, update, workflow_lint,
 * afk_contract, afk_launch, afk_return, afk_start, branch_outcome,
 * branch_prompt, busy_event, kimi_turnend_hook, operational_input,
 * procevent_run, procevent_lavish, procevent_quota, procevent_remote_reply,
 * procevent_when, turnend_guard, turnend_guard_cursor, turnend_guard_grok,
 * wake_grant, watch_checkpoint.
 *
 * Every tool shells to its owning bin/fm-*.sh script and never reimplements
 * firstmate behavior. Wire payloads match the Python server exactly so the
 * shared conformance checks are the referee between the two paths.
 */
import { randomBytes, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import {
  APPROVAL_PREFIX,
  BEARINGS_SCHEMA,
  BRIEF_MODES,
  HANDOFF_DEFAULT_LINES,
  HANDOFF_KEYS_MAX,
  HARNESS_MODES,
  HOME_SUMMARY_SCHEMA,
  MAX_OUTPUT_BYTES,
  MODES,
  DEFAULT_PR_BASE,
  PR_BODY_MAX_BYTES,
  PR_TITLE_MAX_CHARS,
  PR_URL_RE,
  resolveGhBin,
  RECEIPT_DIRNAME,
  RECEIPT_TIMEOUT_S,
  RECEIPT_TTL_S,
  REMOTE_CONTROL_VERBS,
  REMOTE_FILE_DEFAULT_MAX_BYTES,
  RESTART_IDS_MAX,
  SEND_TEXT_MAX_CHARS,
  SNAPSHOT_DEFAULT_LIMIT,
  SNAPSHOT_DIRNAME,
  SNAPSHOT_MAX_LIMIT,
  SNAPSHOT_MIN_LIMIT,
  SNAPSHOT_SCHEMA,
  SNAPSHOT_TTL_S,
  VERDICTS,
  YOLO,
  binDir as defaultBinDir,
  dataDir as defaultDataDir,
  stateDir as defaultStateDir,
} from "./constants.js";
import { ownedCall, runScript, truncate, byteLength, isRunResult } from "./runner.js";
import {
  tierOf,
  requiresApproval,
  TIER_FORBIDDEN,
  FORBIDDEN_TOOLS,
  type Tier,
} from "./auth.js";
import {
  checkAuthorization,
  mintGrant,
  revokeGrant,
  getGrantStatus,
  type MintGrantParams,
  type GrantTier,
} from "./grants.js";
import {
  confineHandoffPath,
  confineStatePath,
  validApproval,
  validBranchName,
  validCommitMessage,
  validCorr,
  validDeltaWait,
  validExtensionId,
  validFileContent,
  validHandoffLines,
  validId,
  validIdList,
  validMailBody,
  validMailSubject,
  validMailTo,
  validMergeMethod,
  validNonnegInt,
  validNote,
  validPageLimit,
  parseSnapshotCursor,
  validPeekLines,
  validProbe,
  validProject,
  validPrUrl,
  validPolicyCommand,
  validQuotaCandidates,
  validQuotaSnapshot,
  validRelpath,
  validBaseBranch,
  validGitRef,
  validPrBody,
  validPrTitle,
  validSubagentTool,
  validTestFamily,
  validTestLane,
  validTestRunMode,
  validTestScriptPath,
  validSupervisionAfkMode,
  validSupervisionHarness,
  validRemoteMaxBytes,
  validSha256,
  validStartupMode,
  validStatusLines,
  validTestIsolationMode,
  validTestRunListMode,
  validIsolationPool,
  validVoiceQueueText,
  validVoiceScope,
} from "./validators.js";
import { DeniedFlagError } from "./errors.js";
import { ConfigService } from "./config.js";

export type ToolArgs = Record<string, unknown>;

export interface ToolResult {
  payload: Record<string, unknown>;
  isError: boolean;
}

export type ToolHandler = (args: ToolArgs, ctx: ToolContext) => Promise<ToolResult>;

export interface ToolContext {
  binDir: string;
  stateDir: string;
  dataDir: string;
  run: typeof runScript;
}

export function liveContext(): ToolContext {
  return {
    binDir: defaultBinDir(),
    stateDir: defaultStateDir(),
    dataDir: defaultDataDir(),
    run: runScript,
  };
}

// --- Fail-closed async receipts ---
//
// Every tool call returns within SUBPROCESS_TIMEOUT_S (30s): a script that
// cannot finish in time is killed as a whole process group and answered
// with a typed timeout error. Calls that need longer work go through
// receipt_submit, which detaches the run (RECEIPT_TIMEOUT_S budget) and
// returns a pending receipt immediately; receipt_status reports
// running/done/failed with the result attached on completion. Receipt
// records live under the serving home's state dir with RECEIPT_TTL_S expiry,
// so they never leak across homes.

/** Tools whose schemas carry a required per-call approval string. */
function receiptDir(ctx: ToolContext): string {
  return path.join(ctx.stateDir, RECEIPT_DIRNAME);
}

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function writeReceipt(ctx: ToolContext, record: Record<string, unknown>): boolean {
  const dir = receiptDir(ctx);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.resolve(dir, `${record["receipt_id"]}.json`);
  if (path.dirname(file) !== path.resolve(dir)) return false;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record), "utf8");
  fs.renameSync(tmp, file);
  return true;
}

function readReceipt(
  ctx: ToolContext,
  receiptId: unknown,
): { record: Record<string, unknown> | null; error: Record<string, unknown> | null } {
  if (!validId(receiptId)) {
    return {
      record: null,
      error: {
        error: "invalid receipt_id",
        expect: "receipt id from a receipt_submit pending response",
      },
    };
  }
  const dir = path.resolve(receiptDir(ctx));
  const file = path.resolve(dir, `${receiptId}.json`);
  if (path.dirname(file) !== dir) {
    return {
      record: null,
      error: {
        error: "invalid receipt_id",
        expect: "receipt id from a receipt_submit pending response",
      },
    };
  }
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (exc) {
    const nodeErr = exc as NodeJS.ErrnoException;
    if (nodeErr?.code === "ENOENT") {
      return { record: null, error: { error: "unknown receipt", receipt_id: receiptId } };
    }
    return { record: null, error: { error: "cannot read receipt", detail: String(exc) } };
  }
  if (typeof record !== "object" || record === null || record["receipt_id"] !== receiptId) {
    return { record: null, error: { error: "unknown receipt", receipt_id: receiptId } };
  }
  return { record, error: null };
}

async function receiptWorker(
  ctx: ToolContext,
  receiptId: string,
  tool: string,
  args: ToolArgs,
): Promise<void> {
  // Detached continuation: the receipt background budget applies to every
  // script this run executes, while sync callers keep the 30s budget.
  const bg: ToolContext = {
    ...ctx,
    run: (argv, opts = {}) => ctx.run(argv, { timeoutS: RECEIPT_TIMEOUT_S, ...opts }),
  };
  let payload: Record<string, unknown>;
  let isError: boolean;
  try {
    ({ payload, isError } = await TOOLS[tool].handler(args, bg));
  } catch (exc) {
    payload = { error: "tool crashed", detail: String(exc) };
    isError = true;
  }
  const { record } = readReceipt(ctx, receiptId);
  if (record === null) return;
  record["status"] = isError ? "failed" : "done";
  record["finished"] = utcNow();
  record[isError ? "error_record" : "result"] = payload;
  try {
    writeReceipt(ctx, record);
  } catch {
    /* a lost terminal write leaves the receipt running; status re-reads */
  }
}

async function toolReceiptSubmit(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const target = args["tool"];
  const nested = args["arguments"];
  if (typeof target !== "string" || target === "") {
    return {
      payload: { error: "invalid tool", expect: "name of a known tool" },
      isError: true,
    };
  }
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) {
    return {
      payload: { error: "invalid arguments", expect: "object of arguments for the named tool" },
      isError: true,
    };
  }
  if (!(target in TOOLS) || target === "receipt_submit") {
    return { payload: { error: "unknown tool", tool: target }, isError: true };
  }
  // Derived from the tier table, never a hand-maintained list: this set used to
  // hold 35 entries and miss 25 of the 60 live tier-3/4 tools, so
  // receipt_submit(repo_push | merge_pr | promote_scout | pr_open | ...) ran the
  // detached call with no approval at all — on the very path an autonomous loop
  // uses. requiresApproval() reads TOOL_TIERS, so a new tool is gated by
  // construction.
  if (requiresApproval(target)) {
    const auth = await requireAuth(target, nested as ToolArgs, ctx);
    if (!auth.ok) return auth.result;
  }
  const receiptId = `rcpt-${randomBytes(8).toString("hex")}`;
  const createdEpoch = Date.now() / 1000;
  const record: Record<string, unknown> = {
    receipt_id: receiptId,
    tool: target,
    status: "running",
    created: utcNow(),
    created_epoch: createdEpoch,
    ttl_s: RECEIPT_TTL_S,
    note: "long call detached; poll receipt_status for running/done/failed",
  };
  try {
    if (!writeReceipt(ctx, record)) {
      return { payload: { error: "cannot record receipt" }, isError: true };
    }
  } catch (exc) {
    return { payload: { error: "cannot record receipt", detail: String(exc) }, isError: true };
  }
  void receiptWorker(ctx, receiptId, target, nested as ToolArgs);
  return {
    payload: {
      status: "pending",
      receipt_id: receiptId,
      tool: target,
      check: { tool: "receipt_status", arguments: { receipt_id: receiptId } },
      ttl_s: RECEIPT_TTL_S,
      note: "call detached past the 30s budget; check receipt_status for the result",
    },
    isError: false,
  };
}

async function toolReceiptStatus(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const { record, error } = readReceipt(ctx, args["receipt_id"]);
  if (record === null) return { payload: error as Record<string, unknown>, isError: true };
  const createdEpoch = typeof record["created_epoch"] === "number" ? record["created_epoch"] : NaN;
  const age = Date.now() / 1000 - createdEpoch;
  const ttl = typeof record["ttl_s"] === "number" ? record["ttl_s"] : RECEIPT_TTL_S;
  if (!(age <= ttl)) {
    try {
      fs.rmSync(path.resolve(receiptDir(ctx), `${record["receipt_id"]}.json`), { force: true });
    } catch {
      /* expiry unlink is best-effort */
    }
    return {
      payload: { error: "receipt expired", receipt_id: record["receipt_id"], ttl_s: ttl },
      isError: true,
    };
  }
  return { payload: record, isError: false };
}

/** Effect core: resolve the live tool context from the ConfigService. */
export function liveContextEffect(): Effect.Effect<ToolContext, never, ConfigService> {
  return Effect.gen(function* () {
    const config = yield* ConfigService;
    return {
      binDir: config.binDir,
      stateDir: config.stateDir,
      dataDir: config.dataDir,
      run: runScript,
    };
  });
}

// --- Deny-list: empty (all surfaces admitted) ---

export const DENY_LIST: ReadonlySet<string> = new Set([]);

/** Flags no argv builder may ever emit. */
export const DENIED_FLAGS: ReadonlySet<string> = new Set([
  "--key",
  "--raw",
  "--force",
  "--yes",
  "--force-with-lease",
]);

export function argv(...parts: string[]): string[] {
  for (const flag of parts) {
    if (DENIED_FLAGS.has(flag)) throw new Error(`denied flag: ${flag}`);
  }
  return [...parts];
}

/**
 * Effect core for argv: fails with a typed DeniedFlagError instead of
 * throwing. Legacy argv() above delegates to the same check so the
 * thrown message stays byte-identical for existing callers.
 */
export function argvEffect(
  ...parts: string[]
): Effect.Effect<string[], DeniedFlagError> {
  for (const flag of parts) {
    if (DENIED_FLAGS.has(flag)) {
      return Effect.fail(new DeniedFlagError({ flag }));
    }
  }
  return Effect.succeed([...parts]);
}

function approvalError(): Record<string, unknown> {
  return {
    error: "approval required",
    expect: "explicit approval string starting with 'I authorize'",
  };
}

async function requireAuth(
  tool: string,
  args: ToolArgs,
  ctx: ToolContext,
): Promise<{ ok: true } | { ok: false; result: ToolResult }> {
  const auth = await checkAuthorization(tool, args, ctx);
  if (!auth.ok) {
    return {
      ok: false,
      result: {
        payload: auth.payload ?? approvalError(),
        isError: true,
      },
    };
  }
  return { ok: true };
}

function sleepSyncMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snapshotDir(ctx: ToolContext): string {
  return path.join(ctx.stateDir, SNAPSHOT_DIRNAME);
}

function writeCachedSnapshot(
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

function readCachedSnapshot(
  ctx: ToolContext,
  snapshotId: unknown,
): { snapshot: Record<string, unknown> | null; error: Record<string, unknown> | null } {
  if (!validId(snapshotId)) {
    return {
      snapshot: null,
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
      return { snapshot: null, error: { error: "unknown snapshot", snapshot_id: snapshotId } };
    }
    return { snapshot: null, error: { error: "cannot read snapshot", detail: String(exc) } };
  }
  if (typeof record !== "object" || record === null || record["snapshot_id"] !== snapshotId) {
    return { snapshot: null, error: { error: "unknown snapshot", snapshot_id: snapshotId } };
  }
  const createdEpoch = typeof record["created_epoch"] === "number" ? record["created_epoch"] : NaN;
  const age = Date.now() / 1000 - createdEpoch;
  const ttl = typeof record["ttl_s"] === "number" ? record["ttl_s"] : SNAPSHOT_TTL_S;
  if (!(age <= ttl)) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* expiry unlink is best-effort */
    }
    return {
      snapshot: null,
      error: { error: "snapshot expired", snapshot_id: snapshotId, ttl_s: ttl },
    };
  }
  const snap = record["snapshot"];
  if (typeof snap !== "object" || snap === null) {
    return { snapshot: null, error: { error: "corrupt snapshot record", snapshot_id: snapshotId } };
  }
  return { snapshot: snap as Record<string, unknown>, error: null };
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
function latestCachedSnapshotId(ctx: ToolContext): string | null {
  const dir = path.resolve(snapshotDir(ctx));
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const suffix = ".json";
  let bestId: string | null = null;
  let bestEpoch = -Infinity;
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
    if (!(Date.now() / 1000 - epoch <= ttl)) continue;
    if (epoch > bestEpoch) {
      bestEpoch = epoch;
      bestId = id;
    }
  }
  return bestId;
}

async function getOrFetchSnapshot(
  ctx: ToolContext,
  snapshotId: string | null,
): Promise<
  | { snapshotId: string; snapshot: Record<string, unknown>; isError: false; fromCache: boolean }
  | { payload: Record<string, unknown>; isError: true }
> {
  if (snapshotId !== null) {
    const { snapshot, error } = readCachedSnapshot(ctx, snapshotId);
    if (snapshot === null) {
      return { payload: error ?? { error: "cannot read snapshot" }, isError: true };
    }
    return { snapshotId, snapshot, isError: false, fromCache: true };
  }

  // No id requested: serve the newest warm snapshot instead of recomputing. An
  // explicitly requested id still fails loudly rather than silently serving a
  // different snapshot, and an expired cache is skipped so the caller recomputes.
  const latest = latestCachedSnapshotId(ctx);
  if (latest !== null) {
    const { snapshot, error } = readCachedSnapshot(ctx, latest);
    if (snapshot !== null) {
      return { snapshotId: latest, snapshot, isError: false, fromCache: true };
    }
    if (error !== null && error["error"] !== "snapshot expired") {
      return { payload: error, isError: true };
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
  return { snapshotId: newId, snapshot, isError: false, fromCache: false };
}

// --- SUPPORTED: open reads + the single safe steer ---

async function toolFleetSnapshot(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
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

  const { snapshotId, snapshot, fromCache } = snapResult;
  const tasks = (snapshot["tasks"] as Array<Record<string, unknown>>) ?? [];

  if (!isPaginated) {
    return {
      payload: {
        ...snapshot,
        snapshot_id: snapshotId,
        from_cache: fromCache,
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

async function toolBacklog(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
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

  const { snapshotId, snapshot, fromCache } = snapResult;
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

const CREW_STATE_RE = /state:\s*(\S+)\s+·\s*source:\s*(\S+)\s+·\s*(.*)/;

async function toolCrewState(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["id"];
  if (!validId(taskId)) {
    return {
      payload: { error: "invalid id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  const res = await ctx.run([path.join(ctx.binDir, "fm-crew-state.sh"), taskId]);
  if (!isRunResult(res)) return { payload: res as Record<string, unknown>, isError: true };
  const rawLines = (res.stdout || "").trim().split("\n");
  const line = rawLines[0] ?? "";
  let parsed: Record<string, unknown> = { state: "unknown", source: "none", detail: line };
  const match = CREW_STATE_RE.exec(line);
  if (match) {
    parsed = { state: match[1], source: match[2], detail: match[3] };
  }
  return { payload: { id: taskId, current: parsed, raw: line }, isError: false };
}

async function toolStatusTail(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["id"];
  if (!validId(taskId)) {
    return {
      payload: { error: "invalid id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  let lines: number;
  const rawLines = args["lines"] ?? 10;
  if (typeof rawLines === "number" && Number.isInteger(rawLines)) {
    lines = rawLines;
  } else if (typeof rawLines === "string" && rawLines.trim() !== "" && Number.isInteger(Number(rawLines))) {
    lines = Number(rawLines);
  } else {
    return { payload: { error: "invalid lines", expect: "integer 1..50" }, isError: true };
  }
  lines = Math.max(1, Math.min(50, lines));
  void validStatusLines;
  let stateResolved: string;
  try {
    stateResolved = fs.realpathSync(ctx.stateDir);
  } catch {
    return { payload: { error: "no status log for id", id: taskId }, isError: true };
  }
  void stateResolved;
  const confined = confineStatePath(ctx.stateDir, taskId);
  if (confined === null) {
    return {
      payload: { error: "invalid id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  let content: string[];
  try {
    content = fs.readFileSync(confined, "utf8").split("\n");
    // Drop the trailing empty element from a final newline, matching
    // Python's str.splitlines() semantics.
    if (content.length > 0 && content[content.length - 1] === "") content.pop();
  } catch (exc) {
    const nodeErr = exc as NodeJS.ErrnoException;
    if (nodeErr?.code === "ENOENT") {
      return { payload: { error: "no status log for id", id: taskId }, isError: true };
    }
    return {
      payload: { error: "cannot read status log", detail: String(exc) },
      isError: true,
    };
  }
  return {
    payload: {
      id: taskId,
      events: content.slice(-lines),
      warning:
        "wake-event history only, never current state; use crew_state for current state",
    },
    isError: false,
  };
}

async function toolSendMessage(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const target = args["target"];
  const text = args["text"];
  if (!validId(target)) {
    return {
      payload: { error: "invalid target", expect: "exact task id, no slashes or traversal" },
      isError: true,
    };
  }
  if (typeof text !== "string" || text.length < 1 || text.length > SEND_TEXT_MAX_CHARS) {
    return {
      payload: {
        error: "invalid text",
        expect: `single line, 1..${SEND_TEXT_MAX_CHARS} chars`,
      },
      isError: true,
    };
  }
  if (text.includes("\n") || text.includes("\r")) {
    return {
      payload: { error: "invalid text", expect: "single line, no newlines" },
      isError: true,
    };
  }
  if (text.trimStart().startsWith("/")) {
    return {
      payload: { error: "slash commands refused", expect: "plain prose steer only" },
      isError: true,
    };
  }
  const res = await ctx.run([path.join(ctx.binDir, "fm-send.sh"), target as string, text]);
  if (!isRunResult(res)) return { payload: res as Record<string, unknown>, isError: true };
  const [out, outTrunc] = truncate(res.stdout || "");
  const [errOut, errTrunc] = truncate(res.stderr || "");
  if (res.exitCode !== 0) {
    return {
      payload: {
        error: "steer refused or failed",
        target,
        exit: res.exitCode,
        stdout: out,
        stderr: errOut,
      },
      isError: true,
    };
  }
  return {
    payload: {
      delivered: true,
      target,
      note: "verified submit per fm-send contract; delivery is not reply",
      stdout: out,
      stdout_truncated: outTrunc,
      stderr_truncated: errTrunc,
    },
    isError: false,
  };
}

// --- SUPPORTED: diagnostic reads (Tier 1, no approval) ---

async function toolPeek(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const target = args["target"];
  if (!validId(target)) {
    return {
      payload: { error: "invalid target", expect: "exact task id, no slashes or traversal" },
      isError: true,
    };
  }
  const lines = validPeekLines(args["lines"] ?? 40);
  if (lines === null) {
    return {
      payload: { error: "invalid lines", expect: "integer 1..100" },
      isError: true,
    };
  }
  void validStatusLines;
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-peek.sh"), target as string, String(lines)),
    "peek failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, target, lines }, isError: false };
  return { payload, isError: true };
}

async function toolFleetView(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  return ownedCall(argv(path.join(ctx.binDir, "fm-fleet-view.sh")), "fleet view failed", ctx.run);
}

async function toolReviewDiff(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["id"];
  if (!validId(taskId)) {
    return {
      payload: { error: "invalid id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  const stat = args["stat"] ?? false;
  if (typeof stat !== "boolean") {
    return { payload: { error: "invalid stat", expect: "boolean" }, isError: true };
  }
  const cmd = argv(path.join(ctx.binDir, "fm-review-diff.sh"), taskId as string);
  if (stat) cmd.push("--stat");
  const { payload, isError } = await ownedCall(cmd, "review diff failed", ctx.run);
  if (!isError) return { payload: { ...payload, id: taskId, stat }, isError: false };
  return { payload, isError: true };
}

async function toolBearingsSnapshot(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const res = await ctx.run([path.join(ctx.binDir, "fm-bearings-snapshot.sh"), "--json"]);
  if (!isRunResult(res)) return { payload: res as Record<string, unknown>, isError: true };
  if (res.exitCode !== 0) {
    const [out] = truncate(res.stderr || res.stdout || "");
    return {
      payload: { error: "bearings failed", exit: res.exitCode, output: out },
      isError: true,
    };
  }
  if (byteLength(res.stdout) > MAX_OUTPUT_BYTES) {
    return { payload: { error: "bearings too large for envelope" }, isError: true };
  }
  let projection: Record<string, unknown>;
  try {
    projection = JSON.parse(res.stdout) as Record<string, unknown>;
  } catch {
    const [out] = truncate(res.stdout);
    return { payload: { error: "bearings was not JSON", output: out }, isError: true };
  }
  if (projection["schema"] !== BEARINGS_SCHEMA) {
    return {
      payload: { error: "unexpected bearings schema", schema: projection["schema"] },
      isError: true,
    };
  }
  return { payload: projection, isError: false };
}

async function toolWakeDrain(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  return ownedCall(argv(path.join(ctx.binDir, "fm-wake-drain.sh")), "wake drain failed", ctx.run);
}

async function toolGuardCheck(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const guardRun: typeof ctx.run = (argvIn, opts = {}) =>
    ctx.run(argvIn, { ...opts, env: { ...process.env, FM_GUARD_READ_ONLY: "1" } });
  return ownedCall(argv(path.join(ctx.binDir, "fm-guard.sh")), "guard check failed", guardRun);
}

// --- SUPPORTED: secondmate / remote reads (Tier 1, no approval) ---

async function toolRemoteDoctor(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Check mode only: the --fix repair path stays out of scope.
  return ownedCall(argv(path.join(ctx.binDir, "fm-remote-doctor.sh")), "doctor failed", ctx.run);
}

async function toolRemoteFile(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const relpath = args["path"];
  if (!validRelpath(relpath)) {
    return {
      payload: { error: "invalid path", expect: "relative path under the home, no traversal" },
      isError: true,
    };
  }
  const maxBytes = validRemoteMaxBytes(args["max_bytes"] ?? REMOTE_FILE_DEFAULT_MAX_BYTES);
  if (maxBytes === null) {
    return {
      payload: { error: "invalid max_bytes", expect: "integer 1..262144" },
      isError: true,
    };
  }
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-remote-file.sh"), "get", relpath, String(maxBytes)),
    "remote file read failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, path: relpath, max_bytes: maxBytes }, isError: false };
  return { payload, isError: true };
}

async function toolRemoteDelta(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const relLog = args["log"];
  if (!validRelpath(relLog)) {
    return {
      payload: { error: "invalid path", expect: "relative log path under the home, no traversal" },
      isError: true,
    };
  }
  const offset = validNonnegInt(args["offset"] ?? 0);
  if (offset === null) {
    return {
      payload: { error: "invalid offset", expect: "nonnegative integer byte cursor" },
      isError: true,
    };
  }
  const sha = args["sha256"];
  if (!validSha256(sha)) {
    return {
      payload: { error: "invalid sha256", expect: "64 hex chars of the exact prefix" },
      isError: true,
    };
  }
  const wait = validDeltaWait(args["wait"] ?? 0);
  if (wait === null) {
    return {
      payload: { error: "invalid wait", expect: "integer 0..10 seconds" },
      isError: true,
    };
  }
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-remote-delta-read.sh"), relLog, String(offset), sha, String(wait)),
    "remote delta read failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, log: relLog, offset }, isError: false };
  return { payload, isError: true };
}

async function toolExtensionList(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // List only: binding, retirement, verify, process-event, and remote-bind
  // facets stay out of scope (see extension_inspect divergence).
  return ownedCall(argv(path.join(ctx.binDir, "fm-extension.sh"), "list"), "extension list failed", ctx.run);
}

async function toolExtensionInspect(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const id = args["id"];
  if (!validExtensionId(id)) {
    return {
      payload: { error: "invalid id", expect: "extension id [a-z0-9]+([.-][a-z0-9]+)*, max 128 bytes" },
      isError: true,
    };
  }
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-extension.sh"), "inspect", id),
    "extension inspect failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, id }, isError: false };
  return { payload, isError: true };
}

async function toolHandoffStatus(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["id"];
  if (taskId !== undefined && !validId(taskId)) {
    return {
      payload: { error: "invalid id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  const lines = validHandoffLines(args["lines"] ?? HANDOFF_DEFAULT_LINES);
  if (lines === null) {
    return { payload: { error: "invalid lines", expect: "integer 1..20" }, isError: true };
  }
  const handoffDir = path.join(ctx.dataDir, "handoff");
  if (taskId === undefined) {
    let names: string[];
    try {
      names = fs.readdirSync(handoffDir)
        .filter((name) => {
          if (!name.endsWith(".outbox.md")) return false;
          try {
            const st = fs.lstatSync(path.join(handoffDir, name));
            return st.isFile() && !st.isSymbolicLink();
          } catch {
            return false;
          }
        })
        .sort();
    } catch (exc) {
      const nodeErr = exc as NodeJS.ErrnoException;
      if (nodeErr?.code === "ENOENT") return { payload: { outboxes: [] }, isError: false };
      return { payload: { error: "cannot read handoff", detail: String(exc) }, isError: true };
    }
    const outboxes: Array<Record<string, unknown>> = [];
    for (const name of names) {
      try {
        const raw = fs.readFileSync(path.join(handoffDir, name), "utf8");
        const text = raw.split("\n");
        if (text.length > 0 && text[text.length - 1] === "") text.pop();
        const size = fs.statSync(path.join(handoffDir, name)).size;
        outboxes.push({
          id: name.slice(0, -".outbox.md".length),
          bytes: size,
          total_lines: text.length,
        });
      } catch (exc) {
        return { payload: { error: "cannot read handoff", detail: String(exc) }, isError: true };
      }
    }
    return { payload: { outboxes }, isError: false };
  }
  const confined = confineHandoffPath(ctx.dataDir, taskId);
  if (confined === null) {
    return {
      payload: { error: "invalid id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  let content: string[];
  let size: number;
  try {
    const raw = fs.readFileSync(confined, "utf8");
    content = raw.split("\n");
    if (content.length > 0 && content[content.length - 1] === "") content.pop();
    size = fs.statSync(confined).size;
  } catch (exc) {
    const nodeErr = exc as NodeJS.ErrnoException;
    if (nodeErr?.code === "ENOENT") {
      return { payload: { error: "no handoff for id", id: taskId }, isError: true };
    }
    return { payload: { error: "cannot read handoff", detail: String(exc) }, isError: true };
  }
  return {
    payload: { id: taskId, bytes: size, total_lines: content.length, lines: content.slice(-lines) },
    isError: false,
  };
}

// --- Wave 3: session + digest reads (Tier 1, no approval) ---
//
// Pure status projections only. Session-start orchestration
// (fm-session-start.sh, fm-sessionstart-run.sh and its transports),
// Herdr lifecycle (fm-herdr-lab.sh, *-cleanup.sh), spawn trust
// preregistration (fm-claude-trust.sh, fm-agy-trust.sh), the networked
// dispatch resolver, watcher checkpoint runs, and lock/lease acquisition
// all stay out; the owning scripts still fail closed on anything refused.

async function toolHarnessDetect(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Default only when the key is absent: an explicit null is invalid,
  // exactly as the Python server's args.get("mode", "own") treats it.
  const rawMode = args["mode"];
  const mode = rawMode === undefined ? "own" : rawMode;
  if (!(HARNESS_MODES as readonly unknown[]).includes(mode)) {
    return {
      payload: {
        error: "invalid mode",
        expect: "one of own, crew, secondmate, secondmate-model, secondmate-effort",
      },
      isError: true,
    };
  }
  const cmd =
    mode === "own"
      ? argv(path.join(ctx.binDir, "fm-harness.sh"))
      : argv(path.join(ctx.binDir, "fm-harness.sh"), mode as string);
  const { payload, isError } = await ownedCall(cmd, "harness detection failed", ctx.run);
  if (isError) return { payload, isError: true };
  const first = ((payload["stdout"] as string) || "").trim().split("\n");
  return { payload: { ...payload, mode, harness: first[0] ?? "" }, isError: false };
}

async function toolProjectMode(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const project = args["project"];
  if (!validProject(project)) {
    return {
      payload: {
        error: "invalid project",
        expect: "bare name or projects/<name>, no absolute paths or traversal",
      },
      isError: true,
    };
  }
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-project-mode.sh"), project as string),
    "project mode refused or failed",
    ctx.run,
  );
  if (isError) return { payload, isError: true };
  // Mirror the Python projection exactly: exactly two tokens map to
  // mode/yolo, anything else maps to null/null.
  const tokens = ((payload["stdout"] as string) || "").trim().split(/\s+/).filter(Boolean);
  const mode = tokens.length === 2 ? tokens[0] : null;
  const yolo = tokens.length === 2 ? tokens[1] : null;
  return { payload: { ...payload, project, mode, yolo }, isError: false };
}

async function toolLockStatus(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-lock.sh"), "status"),
    "lock status failed",
    ctx.run,
  );
  if (isError) return { payload, isError: true };
  const lines = ((payload["stdout"] as string) || "").trim().split("\n");
  const line = lines[0] ?? "";
  let status = "unknown";
  if (line === "lock: free") status = "free";
  else if (line.startsWith("lock: held")) status = "held";
  else if (line.startsWith("lock: stale")) status = "stale";
  else if (line.startsWith("lock: unreadable")) status = "unreadable";
  return { payload: { ...payload, status, raw: line }, isError: false };
}

async function toolLeaseCheck(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["id"];
  if (!validId(taskId)) {
    return {
      payload: { error: "invalid id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  const res = await ctx.run([
    path.join(ctx.binDir, "fm-lease.sh"),
    "check",
    taskId as string,
  ]);
  if (!isRunResult(res)) return { payload: res as Record<string, unknown>, isError: true };
  const [out, outTrunc] = truncate(res.stdout || "");
  const [, errTrunc] = truncate(res.stderr || "");
  if (res.exitCode === 0) {
    const holderLines = out.trim().split("\n");
    const holder = holderLines[0] ?? "";
    const record: Record<string, unknown> = {
      task_id: taskId,
      leased: true,
      holder,
      stdout_truncated: outTrunc,
      stderr_truncated: errTrunc,
    };
    const parts = holder.split(/\s+/).filter(Boolean);
    if (parts.length === 4) {
      const [actor, pid, epoch, live] = parts;
      const pidNum = /^\d+$/.test(pid) ? Number(pid) : null;
      const epochNum = /^\d+$/.test(epoch) ? Number(epoch) : null;
      record["actor"] = actor;
      record["pid"] = pidNum;
      record["epoch"] = epochNum;
      record["live"] = live === "live";
    }
    return { payload: record, isError: false };
  }
  if (res.exitCode === 1 && out.trim() === "") {
    return { payload: { task_id: taskId, leased: false }, isError: false };
  }
  const [errOut] = truncate(res.stderr || "");
  return {
    payload: {
      error: "lease check failed",
      exit: res.exitCode,
      stdout: out,
      stderr: errOut,
    },
    isError: true,
  };
}

async function toolBearingsBoardPath(
  _args: ToolArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-bearings-board.sh"), "path"),
    "bearings board path failed",
    ctx.run,
  );
  if (isError) return { payload, isError: true };
  return {
    payload: { ...payload, path: ((payload["stdout"] as string) || "").trim() },
    isError: false,
  };
}

async function toolInboxStatus(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  return ownedCall(
    argv(path.join(ctx.binDir, "fm-inbox.sh"), "status"),
    "inbox status failed",
    ctx.run,
  );
}

async function toolInboxList(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  return ownedCall(
    argv(path.join(ctx.binDir, "fm-inbox.sh"), "list"),
    "inbox list failed",
    ctx.run,
  );
}

async function toolHomeSummary(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const root = path.resolve(ctx.stateDir);
  const file = path.resolve(root, "home-summary.json");
  if (path.dirname(file) !== root) {
    return {
      payload: {
        error: "no home summary",
        expect: "published state/home-summary.json in the served home",
      },
      isError: true,
    };
  }
  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch (exc) {
    const nodeErr = exc as NodeJS.ErrnoException;
    if (nodeErr?.code === "ENOENT") {
      return {
        payload: {
          error: "no home summary",
          expect: "published state/home-summary.json in the served home",
        },
        isError: true,
      };
    }
    return {
      payload: { error: "cannot read home summary", detail: String(exc) },
      isError: true,
    };
  }
  if (raw.length > MAX_OUTPUT_BYTES) {
    return { payload: { error: "home summary too large for envelope" }, isError: true };
  }
  let summary: Record<string, unknown>;
  try {
    summary = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  } catch {
    const [out] = truncate(raw.toString("utf8"));
    return { payload: { error: "home summary was not JSON", output: out }, isError: true };
  }
  if (typeof summary !== "object" || summary === null || summary["schema"] !== HOME_SUMMARY_SCHEMA) {
    const schema =
      typeof summary === "object" && summary !== null
        ? (summary["schema"] as unknown)
        : null;
    return {
      payload: { error: "unexpected home summary schema", schema },
      isError: true,
    };
  }
  return { payload: summary, isError: false };
}

const PUBLISH_HINT =
  "publishing walks live child state and can exceed the 30s envelope on a large home; " +
  "submit home_summary_refresh through receipt_submit (180s budget), then read home_summary";

/**
 * Publish state/home-summary.json without the publisher script.
 *
 * The declared command for home_summary_refresh is bin/fm-home-summary-refresh.sh,
 * which the served fork line does not ship (the same fork-vs-upstream shape gap
 * that leaves 24 doorway scripts upstream-only). The bounded snapshot that
 * script wraps *does* exist on the served line, so the doorway publishes from
 * it, keeping the declared rules: schema-checked, mode-0600 temp on the state
 * filesystem, renamed over the ledger, so torn output is impossible.
 *
 * Deliberately not ownedCall(): that tails stdout at TAIL_CAP_BYTES (8 KiB)
 * while the summary document measures ~32 KiB on a live home, which would
 * truncate the JSON mid-document and publish nothing parseable.
 */
async function publishHomeSummary(ctx: ToolContext, bestEffort: boolean): Promise<ToolResult> {
  const snapshot = path.join(ctx.binDir, "fm-fleet-snapshot.sh");
  if (!fs.existsSync(snapshot)) {
    return {
      payload: {
        error: "home summary refresh unavailable",
        expect:
          "bin/fm-home-summary-refresh.sh, or bin/fm-fleet-snapshot.sh --secondmate-home-summary, in the served home",
      },
      isError: true,
    };
  }
  const started = Date.now();
  const res = await ctx.run(argv(snapshot, "--secondmate-home-summary"));
  if (!isRunResult(res)) {
    return { payload: { ...res, hint: PUBLISH_HINT }, isError: true };
  }
  if (res.exitCode !== 0) {
    return {
      payload: {
        error: "home summary refresh failed",
        exit: res.exitCode,
        stderr: truncate(res.stderr ?? "")[0],
        hint: PUBLISH_HINT,
      },
      isError: true,
    };
  }
  const text = res.stdout ?? "";
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {
      payload: { error: "home summary refresh produced non-JSON", stdout: truncate(text)[0] },
      isError: true,
    };
  }
  if (doc["schema"] !== HOME_SUMMARY_SCHEMA) {
    return {
      payload: {
        error: "home summary refresh produced off-schema output",
        schema: doc["schema"] ?? null,
        expect: HOME_SUMMARY_SCHEMA,
      },
      isError: true,
    };
  }
  const root = path.resolve(ctx.stateDir);
  const file = path.resolve(root, "home-summary.json");
  if (path.dirname(file) !== root) {
    return { payload: { error: "no home summary" }, isError: true };
  }
  const tmp = path.join(root, `.home-summary.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  return {
    payload: {
      ok: true,
      published: file,
      schema: doc["schema"],
      generated_epoch: doc["generated_epoch"] ?? null,
      bytes: byteLength(text),
      duration_ms: Date.now() - started,
      best_effort: bestEffort,
      source: "in-repo fallback (publisher script absent from the served line)",
    },
    isError: false,
  };
}

async function toolHomeSummaryRefresh(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const bestEffort = args["best_effort"] ?? false;
  if (typeof bestEffort !== "boolean") {
    return { payload: { error: "invalid best_effort", expect: "boolean" }, isError: true };
  }
  const publisher = path.join(ctx.binDir, "fm-home-summary-refresh.sh");
  // Prefer the firstmate-owned publisher wherever the line ships it: it stays
  // authoritative, and the fallback is only for lines that do not.
  if (!fs.existsSync(publisher)) {
    return publishHomeSummary(ctx, bestEffort);
  }
  const cmd = argv(publisher);
  if (bestEffort) cmd.push("--best-effort");
  const { payload, isError } = await ownedCall(cmd, "home summary refresh failed", ctx.run);
  if (!isError) return { payload: { ...payload, best_effort: bestEffort }, isError: false };
  return { payload, isError: true };
}

async function contributionInput(
  ctx: ToolContext,
): Promise<{ staged: string | null; error: Record<string, unknown> | null }> {
  const res = await ctx.run([
    path.join(ctx.binDir, "fm-fleet-snapshot.sh"),
    "--contribution-input",
  ]);
  if (!isRunResult(res)) return { staged: null, error: res as Record<string, unknown> };
  if (res.exitCode !== 0) {
    const [out] = truncate(res.stderr || res.stdout || "");
    return {
      staged: null,
      error: { error: "contribution input failed", exit: res.exitCode, output: out },
    };
  }
  if (byteLength(res.stdout) > MAX_OUTPUT_BYTES) {
    return {
      staged: null,
      error: {
        error: "contribution input failed",
        detail: "contribution input too large for envelope",
      },
    };
  }
  return { staged: res.stdout, error: null };
}

async function toolContributionsSnapshot(
  args: ToolArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  // Default only when the key is absent: an explicit null is invalid,
  // exactly as the Python server's args.get("all", False) treats it.
  const rawAll = args["all"];
  const wantAll = rawAll === undefined ? false : rawAll;
  if (typeof wantAll !== "boolean") {
    return { payload: { error: "invalid all", expect: "boolean" }, isError: true };
  }
  const { staged, error } = await contributionInput(ctx);
  if (error !== null || staged === null) {
    return { payload: error as Record<string, unknown>, isError: true };
  }
  const tmp = writeTempFile(staged);
  try {
    const cmd = argv(path.join(ctx.binDir, "fm-contributions.sh"), "snapshot", tmp);
    if (wantAll) cmd.push("--all");
    const res = await ctx.run(cmd);
    if (!isRunResult(res)) return { payload: res as Record<string, unknown>, isError: true };
    if (res.exitCode !== 0) {
      const [out] = truncate(res.stderr || res.stdout || "");
      return {
        payload: { error: "contributions snapshot failed", exit: res.exitCode, output: out },
        isError: true,
      };
    }
    if (byteLength(res.stdout) > MAX_OUTPUT_BYTES) {
      return { payload: { error: "contributions too large for envelope" }, isError: true };
    }
    let projection: Record<string, unknown>;
    try {
      projection = JSON.parse(res.stdout) as Record<string, unknown>;
    } catch {
      const [out] = truncate(res.stdout);
      return { payload: { error: "contributions was not JSON", output: out }, isError: true };
    }
    if (typeof projection !== "object" || projection === null || Array.isArray(projection)) {
      const [out] = truncate(res.stdout);
      return { payload: { error: "contributions was not JSON", output: out }, isError: true };
    }
    return { payload: { ...projection, all: wantAll }, isError: false };
  } finally {
    removeTempFile(tmp);
  }
}

async function toolContributionsPending(
  _args: ToolArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const res = await ctx.run([path.join(ctx.binDir, "fm-contributions.sh"), "pending"]);
  if (!isRunResult(res)) return { payload: res as Record<string, unknown>, isError: true };
  if (res.exitCode !== 0) {
    const [out] = truncate(res.stderr || res.stdout || "");
    return {
      payload: { error: "contributions pending failed", exit: res.exitCode, output: out },
      isError: true,
    };
  }
  if (byteLength(res.stdout) > MAX_OUTPUT_BYTES) {
    return { payload: { error: "contributions too large for envelope" }, isError: true };
  }
  let pending: unknown;
  try {
    pending = JSON.parse(res.stdout) as unknown;
  } catch {
    const [out] = truncate(res.stdout);
    return {
      payload: { error: "contributions pending was not JSON", output: out },
      isError: true,
    };
  }
  if (!Array.isArray(pending)) {
    const [out] = truncate(res.stdout);
    return {
      payload: { error: "contributions pending was not JSON", output: out },
      isError: true,
    };
  }
  return { payload: { pending }, isError: false };
}

// --- CHANGED: approval-gated writes ---

async function lifecycleTool(
  args: ToolArgs,
  ctx: ToolContext,
  verb: string,
  needsNote: boolean,
): Promise<ToolResult> {
  const taskId = args["id"];
  if (!validId(taskId)) {
    return {
      payload: { error: "invalid id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  const auth = await requireAuth(`lifecycle_${verb}`, args, ctx);
  if (!auth.ok) return auth.result;
  const cmd = argv(path.join(ctx.binDir, "fm-control.sh"), taskId as string, verb);
  if (needsNote) {
    const note = args["note"];
    if (!validNote(note)) {
      return {
        payload: { error: "invalid note", expect: "single line, 1..500 chars" },
        isError: true,
      };
    }
    cmd.push("--note", note as string);
  }
  const { payload, isError } = await ownedCall(cmd, `${verb} refused or failed`, ctx.run);
  if (!isError) return { payload: { ...payload, verb, id: taskId }, isError: false };
  return { payload, isError: true };
}

async function toolSpawnCrew(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  const project = args["project"];
  const mode = args["mode"];
  const yolo = args["yolo"];
  if (!validId(taskId)) {
    return {
      payload: { error: "invalid task_id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  if (!validProject(project)) {
    return {
      payload: {
        error: "invalid project",
        expect: "bare name or projects/<name>, no absolute paths or traversal",
      },
      isError: true,
    };
  }
  if (!(MODES as readonly unknown[]).includes(mode)) {
    return {
      payload: { error: "invalid mode", expect: "one of no-mistakes, direct-PR, local-only" },
      isError: true,
    };
  }
  if (!(YOLO as readonly unknown[]).includes(yolo)) {
    return { payload: { error: "invalid yolo", expect: "one of on, off" }, isError: true };
  }
  const auth = await requireAuth("spawn_crew", args, ctx);
  if (!auth.ok) return auth.result;
  const { payload, isError } = await ownedCall(
    argv(
      path.join(ctx.binDir, "fm-spawn.sh"),
      taskId as string,
      project as string,
      "--mode",
      mode as string,
      "--yolo",
      yolo as string,
    ),
    "spawn refused or failed",
    ctx.run,
  );
  if (!isError) {
    return { payload: { ...payload, task_id: taskId, project, mode }, isError: false };
  }
  return { payload, isError: true };
}

async function toolScaffoldBrief(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  const project = args["project"];
  const mode = args["mode"];
  if (!validId(taskId)) {
    return {
      payload: { error: "invalid task_id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  if (!validProject(project)) {
    return {
      payload: {
        error: "invalid project",
        expect: "bare name or projects/<name>, no absolute paths or traversal",
      },
      isError: true,
    };
  }
  if (!(BRIEF_MODES as readonly unknown[]).includes(mode)) {
    return {
      payload: {
        error: "invalid mode",
        expect: "one of no-mistakes, direct-PR, local-only, scout",
      },
      isError: true,
    };
  }
  const auth = await requireAuth("scaffold_brief", args, ctx);
  if (!auth.ok) return auth.result;
  const base = [path.join(ctx.binDir, "fm-brief.sh"), taskId as string, project as string];
  const cmd =
    mode === "scout" ? argv(...base, "--scout") : argv(...base, "--mode", mode as string);
  const { payload, isError } = await ownedCall(cmd, "brief refused or failed", ctx.run);
  if (!isError) {
    return { payload: { ...payload, task_id: taskId, project, mode }, isError: false };
  }
  return { payload, isError: true };
}

async function toolDecisionHold(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const originId = args["origin_id"];
  const decisionKey = args["decision_key"];
  const title = args["title"];
  const reason = args["reason"];
  if (!validId(originId)) {
    return {
      payload: { error: "invalid origin_id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  if (!validId(decisionKey)) {
    return {
      payload: { error: "invalid decision_key", expect: "short slug, no slashes or traversal" },
      isError: true,
    };
  }
  if (!validNote(title, 200)) {
    return {
      payload: { error: "invalid title", expect: "single line, 1..200 chars" },
      isError: true,
    };
  }
  if (!validNote(reason, 1000)) {
    return {
      payload: { error: "invalid reason", expect: "single line, 1..1000 chars" },
      isError: true,
    };
  }
  const auth = await requireAuth("decision_hold", args, ctx);
  if (!auth.ok) return auth.result;
  const { payload, isError } = await ownedCall(
    argv(
      path.join(ctx.binDir, "fm-decision-hold.sh"),
      "hold",
      originId as string,
      decisionKey as string,
      "--title",
      title as string,
      "--reason",
      reason as string,
    ),
    "decision hold refused or failed",
    ctx.run,
  );
  if (!isError) {
    return { payload: { ...payload, origin_id: originId, decision_key: decisionKey }, isError: false };
  }
  return { payload, isError: true };
}

let tmpCounter = 0;
function writeTempFile(content: string): string {
  tmpCounter += 1;
  const tmp = path.join(
    os.tmpdir(),
    `fm-mcp-ts-${process.pid}-${Date.now()}-${tmpCounter}.md`,
  );
  fs.writeFileSync(tmp, content, "utf8");
  return tmp;
}

function removeTempFile(tmp: string): void {
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* best effort */
  }
}

/** Compute SHA-256 hex digest for decision text. */
export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Check if deploy-level release grant is enabled via FM_RELEASE_GRANT. */
export function isReleaseGrantEnabled(): boolean {
  const grant = process.env.FM_RELEASE_GRANT;
  if (!grant) return false;
  const normalized = grant.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "on" ||
    normalized === "yes" ||
    normalized === "all" ||
    normalized === "enable" ||
    normalized === "enabled"
  );
}

/**
 * Determine if release of a hold is authorized under the SAFETY CORE:
 * Default scope permits releasing ONLY holds the calling agent opened itself.
 * Captain-opened or third-party holds refuse unless explicit deploy release grant is ON.
 */
export async function isReleaseAuthorized(
  callerActor: string,
  originId: string | undefined,
  taskId: string | undefined,
  ctx: ToolContext,
): Promise<{ authorized: boolean; reason?: string; author?: string | null }> {
  if (isReleaseGrantEnabled()) {
    return { authorized: true, author: "(grant-enabled)" };
  }

  // If originId was provided explicitly:
  if (originId) {
    if (callerActor === originId) {
      return { authorized: true, author: originId };
    }
    return {
      authorized: false,
      author: originId,
      reason: `release refused: caller '${callerActor}' did not author hold for origin '${originId}' (default scope permits self-holds only; captain-opened or third-party holds require FM_RELEASE_GRANT=1)`,
    };
  }

  // If taskId was provided:
  if (taskId) {
    // Check if taskId matches <origin>-decision-<key> format:
    const match = taskId.match(/^([a-zA-Z0-9._-]+)-decision-[a-zA-Z0-9._-]+$/);
    if (match) {
      const author = match[1];
      if (callerActor === author) {
        return { authorized: true, author };
      }
      return {
        authorized: false,
        author,
        reason: `release refused: caller '${callerActor}' did not author hold '${taskId}' (authored by '${author}'; default scope permits self-holds only; captain-opened or third-party holds require FM_RELEASE_GRANT=1)`,
      };
    }

    // Otherwise check if task metadata or task body carries Origin: <origin>
    // 1. Check if state/<taskId>.meta has origin=
    const metaPath = path.join(ctx.stateDir, `${taskId}.meta`);
    try {
      if (fs.existsSync(metaPath)) {
        const content = fs.readFileSync(metaPath, "utf8");
        const originMatch = content.match(/^origin=([a-zA-Z0-9._-]+)/m);
        if (originMatch) {
          const author = originMatch[1];
          if (callerActor === author) {
            return { authorized: true, author };
          }
          return {
            authorized: false,
            author,
            reason: `release refused: caller '${callerActor}' did not author hold '${taskId}' (authored by '${author}'; default scope permits self-holds only; captain-opened or third-party holds require FM_RELEASE_GRANT=1)`,
          };
        }
      }
    } catch {
      /* ignore file read error, fall through to task check */
    }

    // 2. Query task show
    try {
      const res = await ctx.run(argv(path.join(ctx.binDir, "fm-tasks-axi.sh"), "show", taskId, "--full"));
      if (isRunResult(res) && res.exitCode === 0) {
        const bodyMatch = res.stdout.match(/Origin:\s*([a-zA-Z0-9._-]+)/);
        if (bodyMatch) {
          const author = bodyMatch[1];
          if (callerActor === author) {
            return { authorized: true, author };
          }
          return {
            authorized: false,
            author,
            reason: `release refused: caller '${callerActor}' did not author hold '${taskId}' (authored by '${author}'; default scope permits self-holds only; captain-opened or third-party holds require FM_RELEASE_GRANT=1)`,
          };
        }
      }
    } catch {
      /* task query failed */
    }

    // No origin found -> captain-opened hold
    return {
      authorized: false,
      author: null,
      reason: `release refused: captain-opened hold '${taskId}' cannot be released by caller '${callerActor}' (default scope permits self-holds only; captain-opened holds require FM_RELEASE_GRANT=1)`,
    };
  }

  return {
    authorized: false,
    author: null,
    reason: "release refused: cannot determine hold authorship (origin_id or task id required)",
  };
}

async function toolDecisionResolve(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const originId = args["origin_id"];
  const decisionKey = args["decision_key"];
  const routedTo = args["routed_to"];
  const decisionText = args["decision_text"];
  if (!validId(originId)) {
    return {
      payload: { error: "invalid origin_id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  if (!validId(decisionKey)) {
    return {
      payload: { error: "invalid decision_key", expect: "short slug, no slashes or traversal" },
      isError: true,
    };
  }
  if (!validId(routedTo)) {
    return {
      payload: { error: "invalid routed_to", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  if (typeof decisionText !== "string" || decisionText.trim().length < 1 || decisionText.length > 2000) {
    return {
      payload: { error: "invalid decision_text", expect: "1..2000 chars" },
      isError: true,
    };
  }
  const auth = await requireAuth("decision_resolve", args, ctx);
  if (!auth.ok) return auth.result;

  const callerActor = process.env.FM_ACTOR ?? "local";
  const releaseAuth = await isReleaseAuthorized(callerActor, originId as string, undefined, ctx);
  if (!releaseAuth.authorized) {
    return {
      payload: { error: "release unauthorized", detail: releaseAuth.reason },
      isError: true,
    };
  }

  const decisionDigest = sha256Text(decisionText as string);
  const tmp = writeTempFile(decisionText as string);
  try {
    const { payload, isError } = await ownedCall(
      argv(
        path.join(ctx.binDir, "fm-decision-hold.sh"),
        "resolve",
        originId as string,
        decisionKey as string,
        "--decision-file",
        tmp,
        "--routed-to",
        routedTo as string,
      ),
      "decision resolve refused or failed",
      ctx.run,
    );
    if (!isError) {
      return {
        payload: {
          ...payload,
          origin_id: originId,
          decision_key: decisionKey,
          decision_digest: decisionDigest,
        },
        isError: false,
      };
    }
    return { payload, isError: true };
  } finally {
    removeTempFile(tmp);
  }
}

async function toolDecisionRelease(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const originId = args["origin_id"];
  const decisionKey = args["decision_key"];
  const taskId = args["id"];
  const routedTo = args["routed_to"];
  const decisionText = args["decision_text"];

  // Validate target identification
  if (originId !== undefined) {
    if (!validId(originId)) {
      return {
        payload: { error: "invalid origin_id", expect: "short task id, no slashes or traversal" },
        isError: true,
      };
    }
    if (!validId(decisionKey)) {
      return {
        payload: { error: "invalid decision_key", expect: "short slug, no slashes or traversal" },
        isError: true,
      };
    }
  } else if (taskId !== undefined) {
    if (!validId(taskId)) {
      return {
        payload: { error: "invalid id", expect: "short task id, no slashes or traversal" },
        isError: true,
      };
    }
  } else {
    return {
      payload: { error: "invalid target", expect: "either id or origin_id + decision_key" },
      isError: true,
    };
  }

  if (routedTo !== undefined && !validId(routedTo)) {
    return {
      payload: { error: "invalid routed_to", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }

  if (typeof decisionText !== "string" || decisionText.trim().length < 1 || decisionText.length > 2000) {
    return {
      payload: { error: "invalid decision_text", expect: "1..2000 chars" },
      isError: true,
    };
  }
  const auth = await requireAuth("decision_release", args, ctx);
  if (!auth.ok) return auth.result;

  const callerActor = process.env.FM_ACTOR ?? "local";
  const releaseAuth = await isReleaseAuthorized(
    callerActor,
    originId as string | undefined,
    taskId as string | undefined,
    ctx,
  );
  if (!releaseAuth.authorized) {
    return {
      payload: { error: "release unauthorized", detail: releaseAuth.reason },
      isError: true,
    };
  }

  const decisionDigest = sha256Text(decisionText as string);
  const tmp = writeTempFile(decisionText as string);

  try {
    if (originId && decisionKey && routedTo) {
      // Route through fm-decision-hold.sh resolve
      const { payload, isError } = await ownedCall(
        argv(
          path.join(ctx.binDir, "fm-decision-hold.sh"),
          "resolve",
          originId as string,
          decisionKey as string,
          "--decision-file",
          tmp,
          "--routed-to",
          routedTo as string,
        ),
        "decision release refused or failed",
        ctx.run,
      );
      if (!isError) {
        return {
          payload: {
            ...payload,
            origin_id: originId,
            decision_key: decisionKey,
            decision_digest: decisionDigest,
          },
          isError: false,
        };
      }
      return { payload, isError: true };
    } else {
      // Direct release via fm-captain-hold.sh answer --release
      const targetId = (taskId ?? `${originId}-decision-${decisionKey}`) as string;
      const { payload, isError } = await ownedCall(
        argv(
          path.join(ctx.binDir, "fm-captain-hold.sh"),
          "answer",
          targetId,
          "--decision-file",
          tmp,
          "--release",
        ),
        "decision release refused or failed",
        ctx.run,
      );
      if (!isError) {
        return {
          payload: {
            ...payload,
            id: targetId,
            origin_id: originId,
            decision_key: decisionKey,
            decision_digest: decisionDigest,
          },
          isError: false,
        };
      }
      return { payload, isError: true };
    }
  } finally {
    removeTempFile(tmp);
  }
}

async function toolReviewDecision(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["id"];
  const verdict = args["verdict"];
  const comment = args["comment"] ?? "";
  const release = args["release"] === true;
  if (!validId(taskId)) {
    return {
      payload: { error: "invalid id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  if (!(VERDICTS as readonly unknown[]).includes(verdict)) {
    return {
      payload: { error: "invalid verdict", expect: "one of approve, decline, comment" },
      isError: true,
    };
  }
  if (verdict === "comment" && !(typeof comment === "string" && comment.trim() !== "")) {
    return {
      payload: { error: "comment verdict requires comment text", expect: "single line, 1..500 chars" },
      isError: true,
    };
  }
  if (comment !== "" && !validNote(comment)) {
    return {
      payload: { error: "invalid comment", expect: "single line, 1..500 chars" },
      isError: true,
    };
  }
  if (args["release"] !== undefined && typeof args["release"] !== "boolean") {
    return {
      payload: { error: "invalid release", expect: "boolean" },
      isError: true,
    };
  }
  const auth = await requireAuth("review_decision", args, ctx);
  if (!auth.ok) return auth.result;

  // If release is requested, enforce SAFETY CORE
  if (release) {
    const callerActor = process.env.FM_ACTOR ?? "local";
    const releaseAuth = await isReleaseAuthorized(callerActor, undefined, taskId as string, ctx);
    if (!releaseAuth.authorized) {
      return {
        payload: { error: "release unauthorized", detail: releaseAuth.reason },
        isError: true,
      };
    }
  }
  const decisionText =
    typeof comment === "string" && comment.trim() !== ""
      ? `${verdict as string} - ${comment as string}`
      : (verdict as string);
  const decisionDigest = sha256Text(decisionText);
  const tmp = writeTempFile(decisionText);
  try {
    const cmdArgs = [
      path.join(ctx.binDir, "fm-captain-hold.sh"),
      "answer",
      taskId as string,
      "--decision-file",
      tmp,
    ];
    if (release) {
      cmdArgs.push("--release");
    }
    const { payload, isError } = await ownedCall(
      argv(...cmdArgs),
      "review decision refused or failed",
      ctx.run,
    );
    if (!isError) {
      return {
        payload: {
          ...payload,
          id: taskId,
          verdict,
          release,
          decision_digest: decisionDigest,
        },
        isError: false,
      };
    }
    return { payload, isError: true };
  } finally {
    removeTempFile(tmp);
  }
}

async function toolDecisionComplete(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const originId = args["origin_id"];
  const none = args["none"];
  const taskIds = args["task_ids"];
  if (!validId(originId)) {
    return {
      payload: { error: "invalid origin_id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  if (none !== undefined && typeof none !== "boolean") {
    return {
      payload: { error: "invalid none", expect: "boolean" },
      isError: true,
    };
  }
  if (none === true && taskIds !== undefined && Array.isArray(taskIds) && taskIds.length > 0) {
    return {
      payload: { error: "invalid task_ids", expect: "none cannot be combined with task_ids" },
      isError: true,
    };
  }
  let ids: string[] = [];
  if (taskIds !== undefined) {
    const parsed = validIdList(taskIds, 64);
    if (!parsed) {
      return {
        payload: { error: "invalid task_ids", expect: "array of 1..64 valid task ids" },
        isError: true,
      };
    }
    ids = parsed;
  }
  if (none !== true && ids.length === 0) {
    return {
      payload: { error: "invalid task_ids", expect: "either none: true or non-empty task_ids required" },
      isError: true,
    };
  }
  const auth = await requireAuth("decision_complete", args, ctx);
  if (!auth.ok) return auth.result;

  const cmdArgs = [path.join(ctx.binDir, "fm-captain-hold.sh"), "complete", originId as string];
  if (none === true) {
    cmdArgs.push("--none");
  } else {
    cmdArgs.push(...ids);
  }

  const { payload, isError } = await ownedCall(
    argv(...cmdArgs),
    "decision complete refused or failed",
    ctx.run,
  );
  if (!isError) {
    return {
      payload: { ...payload, origin_id: originId, none: none ?? false, task_ids: ids },
      isError: false,
    };
  }
  return { payload, isError: true };
}

async function toolDecisionVerify(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const originId = args["origin_id"];
  if (!validId(originId)) {
    return {
      payload: { error: "invalid origin_id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-captain-hold.sh"), "verify", originId as string),
    "decision verify refused or failed",
    ctx.run,
  );
  if (!isError) {
    return { payload: { ...payload, origin_id: originId, verified: true }, isError: false };
  }
  return { payload, isError: true };
}

async function toolDecisionOpen(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["id"];
  const identity = args["identity"] === true;
  const distinguishAbsent = args["distinguish_absent"] === true;
  if (!validId(taskId)) {
    return {
      payload: { error: "invalid id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  if (args["identity"] !== undefined && typeof args["identity"] !== "boolean") {
    return {
      payload: { error: "invalid identity", expect: "boolean" },
      isError: true,
    };
  }
  if (args["distinguish_absent"] !== undefined && typeof args["distinguish_absent"] !== "boolean") {
    return {
      payload: { error: "invalid distinguish_absent", expect: "boolean" },
      isError: true,
    };
  }
  const cmdArgs = [path.join(ctx.binDir, "fm-captain-hold.sh"), "open", taskId as string];
  if (identity) cmdArgs.push("--identity");
  if (distinguishAbsent) cmdArgs.push("--distinguish-absent");

  const res = await ctx.run(argv(...cmdArgs));
  if (!isRunResult(res)) {
    return { payload: res as unknown as Record<string, unknown>, isError: true };
  }
  if (res.exitCode === 0) {
    const out: Record<string, unknown> = { id: taskId, open: true };
    if (identity && res.stdout.trim()) {
      out["identity"] = res.stdout.trim();
    }
    return { payload: out, isError: false };
  }
  if (res.exitCode === 1) {
    return { payload: { id: taskId, open: false }, isError: false };
  }
  if (res.exitCode === 3) {
    return { payload: { id: taskId, open: false, absent: true }, isError: false };
  }
  return {
    payload: {
      error: "decision open refused or failed",
      exitCode: res.exitCode,
      stderr: res.stderr.trim(),
    },
    isError: true,
  };
}

async function toolDecisionDiverged(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-captain-hold.sh"), "diverged"),
    "decision diverged check refused or failed",
    ctx.run,
  );
  if (!isError) {
    const raw = typeof payload["stdout"] === "string" ? payload["stdout"] : "";
    const lines = raw.trim() ? raw.trim().split("\n") : [];
    const records = lines.map((l: string) => {
      const [id, origin, key, title] = l.split("\t");
      return { id, origin, key, title };
    });
    return {
      payload: {
        ...payload,
        diverged: records.length > 0,
        count: records.length,
        records,
      },
      isError: false,
    };
  }
  return { payload, isError: true };
}

async function toolRelayReply(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const requestId = args["request_id"];
  const text = args["text"];
  if (!validId(requestId)) {
    return {
      payload: { error: "invalid request_id", expect: "short slug, no slashes or traversal" },
      isError: true,
    };
  }
  if (typeof text !== "string" || text.length < 1 || text.length > 2000) {
    return { payload: { error: "invalid text", expect: "1..2000 chars" }, isError: true };
  }
  const auth = await requireAuth("relay_reply", args, ctx);
  if (!auth.ok) return auth.result;
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-x-reply.sh"), requestId as string, text),
    "relay reply refused or failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, request_id: requestId }, isError: false };
  return { payload, isError: true };
}

async function toolRelayDismiss(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const requestId = args["request_id"];
  if (!validId(requestId)) {
    return {
      payload: { error: "invalid request_id", expect: "short slug, no slashes or traversal" },
      isError: true,
    };
  }
  const auth = await requireAuth("relay_dismiss", args, ctx);
  if (!auth.ok) return auth.result;
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-x-dismiss.sh"), requestId as string),
    "relay dismiss refused or failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, request_id: requestId }, isError: false };
  return { payload, isError: true };
}

async function toolRelayFollowup(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  const text = args["text"];
  const final = args["final"] ?? false;
  if (!validId(taskId)) {
    return {
      payload: { error: "invalid task_id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  if (typeof text !== "string" || text.length < 1 || text.length > 2000) {
    return { payload: { error: "invalid text", expect: "1..2000 chars" }, isError: true };
  }
  if (typeof final !== "boolean") {
    return { payload: { error: "invalid final", expect: "boolean" }, isError: true };
  }
  const auth = await requireAuth("relay_followup", args, ctx);
  if (!auth.ok) return auth.result;
  const tmp = writeTempFile(text);
  try {
    const cmd = argv(path.join(ctx.binDir, "fm-x-followup.sh"), taskId as string, "--text-file", tmp);
    if (final) cmd.push("--final");
    const { payload, isError } = await ownedCall(cmd, "relay followup refused or failed", ctx.run);
    if (!isError) return { payload: { ...payload, task_id: taskId }, isError: false };
    return { payload, isError: true };
  } finally {
    removeTempFile(tmp);
  }
}

// --- CHANGED: secondmate / remote authority writes (Tier 3, approval) ---

async function toolSecondmateNudge(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Notify-only subset: the backstop asks mismatched secondmates to
  // reconcile through the cooldown-guarded notify path.
  const auth = await requireAuth("secondmate_nudge", args, ctx);
  if (!auth.ok) return auth.result;
  return ownedCall(
    argv(path.join(ctx.binDir, "fm-secondmate-reconcile.sh"), "notify"),
    "reconcile notify refused or failed",
    ctx.run,
  );
}

async function toolSecondmateRestart(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const ids = validIdList(args["ids"], RESTART_IDS_MAX);
  if (ids === null) {
    return {
      payload: { error: "invalid id", expect: "1..8 secondmate ids, no slashes or traversal" },
      isError: true,
    };
  }
  const auth = await requireAuth("secondmate_restart", args, ctx);
  if (!auth.ok) return auth.result;
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-secondmate-restart.sh"), ...ids),
    "secondmate restart refused or failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, ids }, isError: false };
  return { payload, isError: true };
}

async function toolSecondmateReport(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const verb = args["verb"];
  if (!validId(verb)) {
    return {
      payload: { error: "invalid verb", expect: "short slug, no slashes or traversal" },
      isError: true,
    };
  }
  const corr = args["corr"];
  if (!validCorr(corr)) {
    return {
      payload: { error: "invalid corr", expect: "16 hex chars, optional corr= prefix" },
      isError: true,
    };
  }
  const note = args["note"];
  if (!validNote(note)) {
    return {
      payload: { error: "invalid note", expect: "single line, 1..500 chars" },
      isError: true,
    };
  }
  const auth = await requireAuth("secondmate_report", args, ctx);
  if (!auth.ok) return auth.result;
  // Note-only form: --doc stays out, and the helper resolves the parent
  // channel itself, so no status path ever crosses this boundary.
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-secondmate-report.sh"), verb, corr, note),
    "secondmate report refused or failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, verb, corr }, isError: false };
  return { payload, isError: true };
}

async function toolRemoteControl(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const verb = args["verb"];
  if (typeof verb !== "string" || !(REMOTE_CONTROL_VERBS as readonly string[]).includes(verb)) {
    return {
      payload: { error: "invalid verb", expect: "one of state, route, observe, send" },
      isError: true,
    };
  }
  const taskId = args["id"];
  if (!validId(taskId)) {
    return {
      payload: { error: "invalid id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  const auth = await requireAuth("remote_control", args, ctx);
  if (!auth.ok) return auth.result;
  const cmd = argv(path.join(ctx.binDir, "fm-remote-secondmate-control.sh"), verb, taskId);
  if (verb === "send") {
    const text = args["text"];
    if (typeof text !== "string" || text.length < 1 || text.length > SEND_TEXT_MAX_CHARS) {
      return {
        payload: { error: "invalid text", expect: `single line, 1..${SEND_TEXT_MAX_CHARS} chars` },
        isError: true,
      };
    }
    if (text.includes("\n") || text.includes("\r")) {
      return {
        payload: { error: "invalid text", expect: "single line, no newlines" },
        isError: true,
      };
    }
    if (text.trimStart().startsWith("/")) {
      return {
        payload: { error: "slash commands refused", expect: "plain prose steer only" },
        isError: true,
      };
    }
    cmd.push(text);
  }
  // Closed verb subset: launch/relaunch (firstmate-owned provisioning),
  // key/capture (raw pane access), and sync/update/retire (remote code
  // and pane teardown) stay out.
  const { payload, isError } = await ownedCall(cmd, "remote control refused or failed", ctx.run);
  if (!isError) return { payload: { ...payload, verb, id: taskId }, isError: false };
  return { payload, isError: true };
}

async function toolHandoffMove(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["id"];
  if (!validId(taskId)) {
    return {
      payload: { error: "invalid id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  const resume = args["resume"] ?? false;
  if (typeof resume !== "boolean") {
    return { payload: { error: "invalid resume", expect: "boolean" }, isError: true };
  }
  const auth = await requireAuth("handoff_move", args, ctx);
  if (!auth.ok) return auth.result;
  if (resume) {
    const keys = args["keys"] ?? [];
    if (!(Array.isArray(keys) && keys.length === 0)) {
      return {
        payload: { error: "invalid keys", expect: "resume takes no keys" },
        isError: true,
      };
    }
    const { payload, isError } = await ownedCall(
      argv(path.join(ctx.binDir, "fm-backlog-handoff.sh"), "--resume-pending"),
      "handoff refused or failed",
      ctx.run,
    );
    if (!isError) return { payload: { ...payload, id: taskId, resumed: true }, isError: false };
    return { payload, isError: true };
  }
  const keys = validIdList(args["keys"], HANDOFF_KEYS_MAX);
  if (keys === null) {
    return {
      payload: { error: "invalid keys", expect: "1..20 backlog item keys, no slashes or traversal" },
      isError: true,
    };
  }
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-backlog-handoff.sh"), taskId, ...keys),
    "handoff refused or failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, id: taskId, keys }, isError: false };
  return { payload, isError: true };
}

async function toolFleetPoll(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  let count: number;
  const rawCount = args["count"] ?? 2;
  if (typeof rawCount === "number" && Number.isInteger(rawCount)) {
    count = rawCount;
  } else if (typeof rawCount === "string" && rawCount.trim() !== "" && Number.isInteger(Number(rawCount))) {
    count = Number(rawCount);
  } else {
    return { payload: { error: "invalid count", expect: "integer 1..3" }, isError: true };
  }
  let intervalS: number;
  const rawInterval = args["interval_s"] ?? 0;
  if (typeof rawInterval === "number" && Number.isFinite(rawInterval)) {
    intervalS = rawInterval;
  } else if (typeof rawInterval === "string" && rawInterval.trim() !== "" && Number.isFinite(Number(rawInterval))) {
    intervalS = Number(rawInterval);
  } else {
    return { payload: { error: "invalid interval_s", expect: "number 0..2" }, isError: true };
  }
  count = Math.max(1, Math.min(3, count));
  intervalS = Math.max(0, Math.min(2, intervalS));
  const polls: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i++) {
    const { payload: snapshot, isError } = await toolFleetSnapshot({}, ctx);
    if (isError) return { payload: snapshot, isError: true };
    polls.push({
      generated: snapshot["generated"],
      tasks: ((snapshot["tasks"] as unknown[]) ?? []).length,
    });
    if (intervalS > 0) await sleepSyncMs(intervalS * 1000);
  }
  const payload: Record<string, unknown> = {
    polls,
    warning: "polling convenience only; fleet_snapshot stays canonical",
  };
  if (byteLength(JSON.stringify(payload)) > MAX_OUTPUT_BYTES) {
    return {
      payload: { error: "poll output too large for PoC envelope", polls: polls.length },
      isError: true,
    };
  }
  return { payload, isError: false };
}

// --- Wave 4: installs, voice/mail, and small PR/relay gaps ---

async function toolMailStatus(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Config + cursor only: no network, no wake.
  return ownedCall(argv(path.join(ctx.binDir, "fm-mail.sh"), "status"), "mail status failed", ctx.run);
}

async function toolMailRead(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // BODY.PEEK digest: mail stays unseen until firstmate answers.
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-mail.sh"), "read"),
    "mail read failed",
    ctx.run,
  );
  if (!isError) {
    return {
      payload: {
        ...payload,
        warning: "BODY.PEEK digest; mail stays unseen until firstmate answers",
      },
      isError: false,
    };
  }
  return { payload, isError: true };
}

async function toolMailCheck(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Inbound received-mail check only; arm/disarm mutate watcher trust state and stay out of MCP.
  return ownedCall(
    argv(path.join(ctx.binDir, "fm-mail-check.sh"), "check"),
    "mail check failed",
    ctx.run,
  );
}

async function toolMailSend(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const to = args["to"];
  const subject = args["subject"];
  const body = args["body"];
  if (!validMailTo(to)) {
    return {
      payload: {
        error: "invalid to",
        expect: "single-line recipient address with @, 3..200 chars, no whitespace",
      },
      isError: true,
    };
  }
  if (!validMailSubject(subject)) {
    return {
      payload: { error: "invalid subject", expect: "single line, 1..200 chars" },
      isError: true,
    };
  }
  if (!validMailBody(body)) {
    return { payload: { error: "invalid body", expect: "1..5000 chars" }, isError: true };
  }
  const auth = await requireAuth("mail_send", args, ctx);
  if (!auth.ok) return auth.result;
  // Body via stdin ("-" form), exactly like the owning script: never argv.
  const res = await ctx.run(
    argv(path.join(ctx.binDir, "fm-mail.sh"), "send", to as string, subject as string, "-"),
    { input: body as string },
  );
  if (!isRunResult(res)) return { payload: res as Record<string, unknown>, isError: true };
  const [out, outTrunc] = truncate(res.stdout ?? "");
  const [errOut, errTrunc] = truncate(res.stderr ?? "");
  if (res.exitCode !== 0) {
    return {
      payload: { error: "mail send refused or failed", exit: res.exitCode, stdout: out, stderr: errOut },
      isError: true,
    };
  }
  return {
    payload: {
      ok: true,
      to,
      subject,
      stdout: out,
      stdout_truncated: outTrunc,
      stderr: errOut,
      stderr_truncated: errTrunc,
    },
    isError: false,
  };
}

async function toolVoiceStatus(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const scope = args["scope"] ?? "counts";
  if (!validVoiceScope(scope)) {
    return {
      payload: { error: "invalid scope", expect: "one of counts, full" },
      isError: true,
    };
  }
  // Counts is safe by construction; full only via the captain's own
  // read-scope with the helper's deny list enforced inside.
  const res = await ctx.run(
    argv(path.join(ctx.binDir, "fm_voice_records.py"), "status", "--scope", scope as string),
  );
  if (!isRunResult(res)) return { payload: res as Record<string, unknown>, isError: true };
  if (res.exitCode !== 0) {
    const [out] = truncate(res.stderr || res.stdout || "");
    return {
      payload: { error: "voice status failed", exit: res.exitCode, output: out },
      isError: true,
    };
  }
  let status: Record<string, unknown>;
  try {
    status = JSON.parse(res.stdout) as Record<string, unknown>;
  } catch {
    const [out] = truncate(res.stdout);
    return { payload: { error: "voice status was not JSON", output: out }, isError: true };
  }
  if (typeof status !== "object" || status === null || Array.isArray(status)) {
    const [out] = truncate(res.stdout);
    return { payload: { error: "voice status was not JSON", output: out }, isError: true };
  }
  return { payload: status, isError: false };
}

async function toolVoiceQueue(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const text = args["text"];
  if (!validVoiceQueueText(text)) {
    return {
      payload: { error: "invalid text", expect: "single line, 1..500 chars" },
      isError: true,
    };
  }
  const auth = await requireAuth("voice_queue", args, ctx);
  if (!auth.ok) return auth.result;
  // Handover queue only: no microphone, no audio, no Bedrock session.
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm_voice_records.py"), "queue", text as string),
    "voice queue refused or failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, queued: true }, isError: false };
  return { payload, isError: true };
}

async function toolLintVersions(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Version probes only: the required ShellCheck/actionlint pins.
  const shellcheckRes = await ctx.run([path.join(ctx.binDir, "fm-lint.sh"), "--required-version"]);
  if (!isRunResult(shellcheckRes)) {
    return { payload: shellcheckRes as Record<string, unknown>, isError: true };
  }
  if (shellcheckRes.exitCode !== 0) {
    const [out] = truncate(shellcheckRes.stderr || shellcheckRes.stdout || "");
    return {
      payload: { error: "lint versions failed", exit: shellcheckRes.exitCode, output: out },
      isError: true,
    };
  }
  const actionlintRes = await ctx.run([
    path.join(ctx.binDir, "fm-lint-workflows.sh"),
    "--required-version",
  ]);
  let actionlint: unknown;
  if (!isRunResult(actionlintRes)) {
    // The owning script is retired upstream: degrade this probe instead of
    // failing the whole call, so the pins we do have still land.
    if ((actionlintRes as Record<string, unknown>)["error"] === "executable not found") {
      actionlint = {
        error: "unsupported probe",
        expect: "owning script fm-lint-workflows.sh retired upstream",
      };
    } else {
      return { payload: actionlintRes as Record<string, unknown>, isError: true };
    }
  } else if (actionlintRes.exitCode !== 0) {
    const [out] = truncate(actionlintRes.stderr || actionlintRes.stdout || "");
    return {
      payload: { error: "lint versions failed", exit: actionlintRes.exitCode, output: out },
      isError: true,
    };
  } else {
    actionlint = (actionlintRes.stdout ?? "").trim();
  }
  return {
    payload: {
      shellcheck: (shellcheckRes.stdout ?? "").trim(),
      actionlint,
    },
    isError: false,
  };
}

async function toolToolUpdateCheck(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Report-only sweep: repairs nothing, installs nothing.
  return ownedCall(
    argv(path.join(ctx.binDir, "fm-tool-update-check.sh"), "check"),
    "tool update check failed",
    ctx.run,
  );
}

async function toolVendorAuthProbe(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const probe = args["probe"];
  if (!validProbe(probe)) {
    return {
      payload: { error: "invalid probe", expect: "one of grok" },
      isError: true,
    };
  }
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-vendor-auth-probe.sh"), probe as string),
    "vendor auth probe failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, probe }, isError: false };
  return { payload, isError: true };
}

async function toolStartupMemory(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const mode = args["mode"] ?? "read";
  if (!validStartupMode(mode)) {
    return {
      payload: { error: "invalid mode", expect: "one of read, report" },
      isError: true,
    };
  }
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-startup-memory-budget.sh"), mode as string),
    "startup memory read failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, mode }, isError: false };
  return { payload, isError: true };
}

// --- Installs gap area: setup/hygiene reads ---
//
// Every installer, seeder, bootstrapper, updater, and test-runner verb
// stays OUT of doorway ownership: approval-gated Tier-3 names with no
// handler (refused as unknown even with approval; see the deny-list
// comment on the registry below). The six reads here expose only the
// genuinely read-only, bounded modes: a deferred-network report, a docs
// inventory check, a home-seed registry validation, a stow-cascade
// enumeration, and the test topology lists. Runs, installs, seeds,
// bootstraps, and updates never dispatch.

async function toolStartupNetworkReport(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // report only: prints the current state plus the last run's per-step
  // timings without changing anything. start/run/harvest/wait stay out:
  // start detaches a worker, run executes sweeps, harvest writes the
  // delivered acknowledgement, and wait blocks past the envelope.
  return ownedCall(
    argv(path.join(ctx.binDir, "fm-startup-network.sh"), "report"),
    "startup network report failed",
    ctx.run,
  );
}

async function toolDocAudienceCheck(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Structure-only docs inventory + local-link validation against one
  // home-confined repo root (default: this home, which is the checkout
  // in the default deployment). The inventory path stays at the
  // upstream default (docs/documentation-audiences.json under root).
  const root = args["root"];
  let resolved: string;
  if (root === undefined) {
    resolved = homeRoot(ctx);
  } else {
    if (!validRelpath(root)) {
      return {
        payload: { error: "invalid root", expect: "home-relative path, no traversal" },
        isError: true,
      };
    }
    const confined = confineHomePath(ctx, root as string);
    if (confined === null) {
      return {
        payload: { error: "invalid root", expect: "home-relative path, no traversal" },
        isError: true,
      };
    }
    resolved = confined;
  }
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-doc-audience-check.sh"), "--root", resolved),
    "doc audience check failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, root: resolved }, isError: false };
  return { payload, isError: true };
}

async function toolHomeSeedValidate(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // validate only: refuses secondmate-registry records that operational
  // consumers cannot parse. Provisioning (clones, markers, registry
  // writes, treehouse leases) stays out.
  return ownedCall(
    argv(path.join(ctx.binDir, "fm-home-seed.sh"), "validate"),
    "home seed validation failed",
    ctx.run,
  );
}

async function toolStowCascade(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Read-only cascade enumeration: one key=value stanza per registered
  // secondmate home with its budget report and transport judgement.
  // Curation itself stays with the /stow skill; remote homes that do not
  // answer inside the subprocess envelope surface as a typed timeout.
  return ownedCall(
    argv(path.join(ctx.binDir, "fm-stow-cascade.sh")),
    "stow cascade failed",
    ctx.run,
  );
}

async function toolTestIsolationList(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const mode = args["mode"] ?? "candidates";
  if (!validTestIsolationMode(mode)) {
    return {
      payload: { error: "invalid mode", expect: "one of candidates, exclusions" },
      isError: true,
    };
  }
  const pool = args["pool"] ?? "portable";
  if (!validIsolationPool(pool)) {
    return {
      payload: { error: "invalid pool", expect: "portable or a test-runner family name" },
      isError: true,
    };
  }
  // List modes only: proven candidates or kept-serial exclusions.
  // Proof runs (concurrent workers, timing artifacts) stay out.
  const flag = mode === "exclusions" ? "--list-exclusions" : "--list";
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-test-isolation-proof.sh"), flag, "--pool", pool as string),
    "test isolation list failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, mode, pool }, isError: false };
  return { payload, isError: true };
}

async function toolTestRunList(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const mode = args["mode"] ?? "families";
  if (!validTestRunListMode(mode)) {
    return {
      payload: { error: "invalid mode", expect: "one of families, lanes, concurrent_safe, coverage" },
      isError: true,
    };
  }
  // Selection-list reads only: family/lane topology and the parallel
  // coverage guard. Suite runs (minutes-long, log-writing) stay out.
  const flag =
    mode === "lanes" ? "--list-lanes"
    : mode === "concurrent_safe" ? "--list-concurrent-safe-families"
    : mode === "coverage" ? "--check-coverage"
    : "--list-families";
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-test-run.sh"), flag),
    "test run list failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, mode }, isError: false };
  return { payload, isError: true };
}

export async function toolTestRun(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const mode = args["mode"];
  if (!validTestRunMode(mode)) {
    return {
      payload: {
        error: "invalid mode",
        expect: "one of all, family, changed, lane, proven-isolated, scripts",
      },
      isError: true,
    };
  }
  const listOnly = args["list"] === true;
  const checkCoverage = args["check_coverage"] === true;
  if (args["list"] !== undefined && typeof args["list"] !== "boolean") {
    return { payload: { error: "invalid list", expect: "boolean" }, isError: true };
  }
  if (args["check_coverage"] !== undefined && typeof args["check_coverage"] !== "boolean") {
    return { payload: { error: "invalid check_coverage", expect: "boolean" }, isError: true };
  }

  const cmd = argv(path.join(ctx.binDir, "fm-test-run.sh"));
  const selection: string[] = [];
  switch (mode) {
    case "all":
      selection.push("--all");
      break;
    case "proven-isolated":
      selection.push("--proven-isolated");
      break;
    case "family": {
      const family = args["family"];
      if (!validTestFamily(family)) {
        return { payload: { error: "invalid family", expect: "family name from --list-families" }, isError: true };
      }
      selection.push("--family", family);
      break;
    }
    case "changed": {
      selection.push("--changed");
      const base = args["base"];
      if (base !== undefined) {
        if (!validGitRef(base)) {
          return { payload: { error: "invalid base", expect: "git ref, no revision range" }, isError: true };
        }
        selection.push("--base", base);
      }
      break;
    }
    case "lane": {
      const lane = args["lane"];
      if (!validTestLane(lane)) {
        return {
          payload: { error: "invalid lane", expect: "portable-parallel-1|2, portable-serial, portable-serial-<k>of<n>" },
          isError: true,
        };
      }
      selection.push("--lane", lane);
      break;
    }
    case "scripts": {
      const scripts = args["scripts"];
      if (!Array.isArray(scripts) || scripts.length === 0 || !scripts.every(validTestScriptPath)) {
        return {
          payload: { error: "invalid scripts", expect: "non-empty list of tests/<name>.test.sh paths" },
          isError: true,
        };
      }
      selection.push(...(scripts as string[]));
      break;
    }
  }
  // --list is the inspection form: it composes with all/family/lane and never
  // executes the suite. --check-coverage is standalone.
  if (listOnly) cmd.push("--list");
  cmd.push(...selection);
  if (checkCoverage) cmd.push("--check-coverage");

  const { payload, isError } = await ownedCall(cmd, "test run failed", ctx.run);
  if (isError) return { payload, isError };
  const executes = !listOnly && !checkCoverage;
  return {
    payload: {
      ...payload,
      mode,
      selection: selection.join(" "),
      list_only: listOnly,
      // Suite runs take minutes and can exceed the 30s envelope; say so up front
      // instead of letting the caller discover it as a bare timeout.
      ...(executes
        ? { long_running: true, hint: "suite runs can exceed the 30s envelope; submit test_run through receipt_submit (180s budget)" }
        : {}),
    },
    isError: false,
  };
}

async function toolPrState(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const url = args["url"];
  if (!validPrUrl(url)) {
    return {
      payload: {
        error: "invalid url",
        expect: "https://github.com/<owner>/<repo>/pull/<number>",
      },
      isError: true,
    };
  }
  // One-shot read-only blockers read; never posts, requests, or merges.
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-pr-state.sh"), url as string),
    "pr state failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, url }, isError: false };
  return { payload, isError: true };
}

async function toolPrPoll(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const url = args["url"];
  if (!validPrUrl(url)) {
    return {
      payload: {
        error: "invalid url",
        expect: "https://github.com/<owner>/<repo>/pull/<number>",
      },
      isError: true,
    };
  }
  const match = PR_URL_RE.exec(url as string);
  if (!match) {
    return {
      payload: {
        error: "invalid url",
        expect: "https://github.com/<owner>/<repo>/pull/<number>",
      },
      isError: true,
    };
  }
  const owner = match[1];
  const repo = match[2];
  const number = match[3];

  const cmd = [
    path.join(ctx.binDir, "fm-pr-poll.sh"),
    "--validated",
    "github",
    url as string,
    "github.com",
    `${owner}/${repo}`,
    number,
  ];
  const { payload, isError } = await ownedCall(cmd, "pr poll failed", ctx.run);
  if (!isError) return { payload: { ...payload, url }, isError: false };
  return { payload, isError: true };
}

async function toolRelayPoll(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Short bounded poll; hard no-op without relay consent (FMX token).
  return ownedCall(argv(path.join(ctx.binDir, "fm-x-poll.sh")), "relay poll failed", ctx.run);
}

async function toolPrReviewers(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const url = args["url"];
  if (!validPrUrl(url)) {
    return {
      payload: {
        error: "invalid url",
        expect: "https://github.com/<owner>/<repo>/pull/<number>",
      },
      isError: true,
    };
  }
  // Read-only advisory reviewer candidates from the PR's changed files
  // and recent authorship; never requests, assigns, or posts reviews.
  // Wide PRs cost one API read per changed path and may time out past
  // the envelope instead of completing.
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-pr-reviewers.sh"), url as string),
    "pr reviewers failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, url }, isError: false };
  return { payload, isError: true };
}

/**
 * Shared PreToolUse classifier shape: the guard never executes the
 * submitted command or tool name, it only classifies. Exit 0 is an
 * allow, exit 2 is a deny with the reason on its outputs, anything
 * else is a failed classification. Both verdicts are answers, not errors.
 */
async function classifyCall(
  cmd: string[],
  label: string,
  run: typeof runScript,
): Promise<ToolResult> {
  const res = await run(cmd);
  if (!isRunResult(res)) return { payload: res as Record<string, unknown>, isError: true };
  const [out, outTrunc] = truncate(res.stdout ?? "");
  const [errOut, errTrunc] = truncate(res.stderr ?? "");
  if (res.exitCode === 0) {
    return {
      payload: { verdict: "allow", stdout: out, stdout_truncated: outTrunc },
      isError: false,
    };
  }
  if (res.exitCode === 2) {
    return {
      payload: {
        verdict: "deny",
        stdout: out,
        stdout_truncated: outTrunc,
        stderr: errOut,
        stderr_truncated: errTrunc,
      },
      isError: false,
    };
  }
  return {
    payload: { error: label, exit: res.exitCode, stdout: out, stderr: errOut },
    isError: true,
  };
}

async function toolArmPolicyCheck(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const command = args["command"];
  if (!validPolicyCommand(command)) {
    return {
      payload: { error: "invalid command", expect: "shell text, 1..4000 chars, no NUL" },
      isError: true,
    };
  }
  // Classification only: the hook never executes, sources, evaluates,
  // or expands the submitted command. Fail-open (missing node/policy)
  // reports allow with empty outputs, exactly like the hook.
  const result = await classifyCall(
    argv(path.join(ctx.binDir, "fm-arm-pretool-check.sh"), "--command", command as string),
    "arm policy check failed",
    ctx.run,
  );
  if (!result.isError) return { payload: { ...result.payload, command }, isError: false };
  return result;
}

async function toolCdPolicyCheck(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const command = args["command"];
  if (!validPolicyCommand(command)) {
    return {
      payload: { error: "invalid command", expect: "shell text, 1..4000 chars, no NUL" },
      isError: true,
    };
  }
  // Classification only, scoped to the real primary checkout: outside
  // it the guard is inert (allow), exactly like the hook.
  const result = await classifyCall(
    argv(path.join(ctx.binDir, "fm-cd-pretool-check.sh"), "--command", command as string),
    "cd policy check failed",
    ctx.run,
  );
  if (!result.isError) return { payload: { ...result.payload, command }, isError: false };
  return result;
}

async function toolSubagentPolicyCheck(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const tool = args["tool"];
  if (!validSubagentTool(tool)) {
    return {
      payload: { error: "invalid tool", expect: "harness tool name, 1..128 chars, single line" },
      isError: true,
    };
  }
  // Classification only: matches the delegation shape of the tool name.
  // FM_ALLOW_SUBAGENT=1 escapes in the hook; the tool reports the
  // guard as configured without setting it.
  const result = await classifyCall(
    argv(path.join(ctx.binDir, "fm-subagent-pretool-check.sh"), "--tool", tool as string),
    "subagent policy check failed",
    ctx.run,
  );
  if (!result.isError) return { payload: { ...result.payload, tool }, isError: false };
  return result;
}

async function toolSupervisionInstructions(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Pure render of the tracked supervision protocol for one harness;
  // no state read beyond the optional x-mode env file, no writes.
  // An omitted harness auto-detects, exactly like the script.
  const parts: string[] = [path.join(ctx.binDir, "fm-supervision-instructions.sh")];
  const echoed: Record<string, unknown> = {};
  const harness = args["harness"];
  if (harness !== undefined) {
    if (!validSupervisionHarness(harness)) {
      return {
        payload: {
          error: "invalid harness",
          expect: "one of claude, codex, opencode, pi, pi-signed, grok, cursor, omp",
        },
        isError: true,
      };
    }
    parts.push("--harness", harness as string);
    echoed["harness"] = harness;
  }
  for (const [key, flag] of [
    ["read_only", "--read-only"],
    ["afk", "--afk"],
    ["x_mode", "--x-mode"],
    ["queue_pending", "--queue-pending"],
  ] as const) {
    const value = args[key];
    if (value !== undefined) {
      if (typeof value !== "boolean") {
        return {
          payload: { error: `invalid ${key}`, expect: "boolean" },
          isError: true,
        };
      }
      parts.push(flag, value ? "1" : "0");
      echoed[key] = value;
    }
  }
  const afkMode = args["afk_mode"];
  if (afkMode !== undefined) {
    if (!validSupervisionAfkMode(afkMode)) {
      return {
        payload: { error: "invalid afk_mode", expect: "away or quiet" },
        isError: true,
      };
    }
    parts.push("--afk-mode", afkMode as string);
    echoed["afk_mode"] = afkMode;
  }
  const repairLine = args["repair_line"];
  if (repairLine !== undefined) {
    if (typeof repairLine !== "boolean") {
      return {
        payload: { error: "invalid repair_line", expect: "boolean" },
        isError: true,
      };
    }
    if (repairLine) parts.push("--repair-line");
    echoed["repair_line"] = repairLine;
  }
  const { payload, isError } = await ownedCall(
    argv(...parts),
    "supervision instructions failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, ...echoed }, isError: false };
  return { payload, isError: true };
}

async function toolQuotaChoose(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const snapshot = args["snapshot"];
  if (!validQuotaSnapshot(snapshot)) {
    return {
      payload: { error: "invalid snapshot", expect: "captured quota-axi text, 1..65536 chars" },
      isError: true,
    };
  }
  const candidates = args["candidates"];
  if (!validQuotaCandidates(candidates)) {
    return {
      payload: {
        error: "invalid candidates",
        expect: "1..16 <harness>:<model> tokens, no leading colon",
      },
      isError: true,
    };
  }
  // Deterministic selection over an already-captured snapshot piped on
  // stdin (never a path, never a fresh quota-axi run): no side effects.
  // Exit 0 prints "<harness> <model>"; exit 1 prints "none".
  const list = candidates as string[];
  const cmd = [path.join(ctx.binDir, "fm-quota-choose.sh")];
  for (const candidate of list) cmd.push("--candidate", candidate);
  const res = await ctx.run(argv(...cmd), { input: snapshot as string });
  if (!isRunResult(res)) return { payload: res as Record<string, unknown>, isError: true };
  const [out, outTrunc] = truncate(res.stdout ?? "");
  const [errOut, errTrunc] = truncate(res.stderr ?? "");
  if (res.exitCode === 0) {
    const [harness, model] = out.trim().split(/\s+/, 2);
    return {
      payload: {
        eligible: true,
        harness,
        model,
        stdout: out,
        stdout_truncated: outTrunc,
      },
      isError: false,
    };
  }
  if (res.exitCode === 1 && out.trim() === "none") {
    return {
      payload: { eligible: false, stdout: out, stdout_truncated: outTrunc },
      isError: false,
    };
  }
  return {
    payload: { error: "quota choose failed", exit: res.exitCode, stdout: out, stderr: errOut },
    isError: true,
  };
}

async function toolPublicFollowupPending(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Open public-followup loop digest; reports unresolved and delivered public loops without mutating state.
  return ownedCall(
    argv(path.join(ctx.binDir, "fm-public-followup.sh"), "pending"),
    "public followup pending failed",
    ctx.run,
  );
}

async function toolPublicFollowupCollect(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Non-destructively read typed terminal events staged in this home's outbox.
  const obligationId = args["obligation_id"];
  if (!validId(obligationId)) {
    return {
      payload: { error: "invalid obligation_id", expect: "short slug, no slashes or traversal" },
      isError: true,
    };
  }
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-public-followup-collect.sh"), "drain", obligationId as string),
    "public followup collect failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, obligation_id: obligationId }, isError: false };
  return { payload, isError: true };
}

export async function toolPublicFollowupEmit(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const obligationId = args["obligation_id"];
  const relationId = args["relation_id"];
  const sourceHome = args["source_home"];
  const workId = args["work_id"];
  const generation = args["generation"];
  const outcome = args["outcome"];
  const outcomeText = args["outcome_text"];
  if (!validId(obligationId)) {
    return { payload: { error: "invalid obligation_id", expect: "short slug, no slashes" }, isError: true };
  }
  if (!validId(relationId)) {
    return { payload: { error: "invalid relation_id", expect: "short slug, no slashes" }, isError: true };
  }
  if (typeof sourceHome !== "string" || (!sourceHome.startsWith("secondmate:") && sourceHome !== "main")) {
    return { payload: { error: "invalid source_home", expect: "main or secondmate:<id>" }, isError: true };
  }
  if (!validId(workId)) {
    return { payload: { error: "invalid work_id", expect: "short slug, no slashes" }, isError: true };
  }
  if (typeof generation !== "number" || generation < 1 || !Number.isInteger(generation)) {
    return { payload: { error: "invalid generation", expect: "integer >= 1" }, isError: true };
  }
  if (!validId(outcome)) {
    return { payload: { error: "invalid outcome", expect: "short slug" }, isError: true };
  }
  if (typeof outcomeText !== "string" || outcomeText.length < 1 || outcomeText.length > 2000) {
    return { payload: { error: "invalid outcome_text", expect: "1..2000 chars" }, isError: true };
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = [
    path.join(ctx.binDir, "fm-public-followup-emit.sh"),
    "--obligation", obligationId as string,
    "--relation", relationId as string,
    "--source-home", sourceHome as string,
    "--work-id", workId as string,
    "--generation", String(generation),
    "--outcome", outcome as string,
    "--outcome-text", outcomeText as string,
  ];
  return ownedCall(cmd, "public_followup_emit", ctx.run);
}

export async function toolRelayLink(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  const requestId = args["request_id"];
  if (!validId(taskId)) {
    return { payload: { error: "invalid task_id", expect: "short slug, no slashes" }, isError: true };
  }
  if (!validId(requestId)) {
    return { payload: { error: "invalid request_id", expect: "short slug, no slashes" }, isError: true };
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = [path.join(ctx.binDir, "fm-x-link.sh"), taskId as string, requestId as string];
  return ownedCall(cmd, "relay_link", ctx.run);
}

export async function toolFleetSync(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const project = args["project"];
  if (project !== undefined && typeof project !== "string") {
    return { payload: { error: "invalid project", expect: "string" }, isError: true };
  }
  if (typeof project === "string" && (project.includes("..") || project.startsWith("/"))) {
    return { payload: { error: "invalid project", expect: "project name or relative path without traversal" }, isError: true };
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = [path.join(ctx.binDir, "fm-fleet-sync.sh"), ...(project ? [project as string] : [])];
  return ownedCall(cmd, "fleet_sync", ctx.run);
}

export async function toolInactiveReconcile(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const mode = args["mode"] !== undefined ? args["mode"] : "scan";
  const startup = args["startup"];
  const taskId = args["task_id"];
  const fingerprint = args["fingerprint"];
  if (typeof mode !== "string" || !["scan", "report", "acknowledge"].includes(mode)) {
    return { payload: { error: "invalid mode", expect: "must be scan, report, or acknowledge" }, isError: true };
  }
  if (mode === "report") {
    if (!validId(taskId)) {
      return { payload: { error: "invalid task_id", expect: "short slug, no slashes" }, isError: true };
    }
  } else if (mode === "acknowledge") {
    if (typeof fingerprint !== "string" || !/^[A-Fa-f0-9]+$/.test(fingerprint)) {
      return { payload: { error: "invalid fingerprint", expect: "hex string" }, isError: true };
    }
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  let cmd: string[];
  if (mode === "report") {
    cmd = [path.join(ctx.binDir, "fm-inactive-reconcile.sh"), "report", taskId as string];
  } else if (mode === "acknowledge") {
    cmd = [path.join(ctx.binDir, "fm-inactive-reconcile.sh"), "acknowledge", fingerprint as string];
  } else {
    cmd = [path.join(ctx.binDir, "fm-inactive-reconcile.sh"), "scan", ...(startup ? ["--startup"] : [])];
  }
  return ownedCall(cmd, "inactive_reconcile", ctx.run);
}

export async function toolTasksList(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const state = args["state"];
  const repo = args["repo"];
  const kind = args["kind"];
  const blocked = args["blocked"];
  const limit = args["limit"];
  const fields = args["fields"];

  if (state !== undefined && (typeof state !== "string" || !["queued", "in_flight", "done", "held", "all"].includes(state))) {
    return { payload: { error: "invalid state", expect: "queued, in_flight, done, held, or all" }, isError: true };
  }
  if (repo !== undefined) {
    if (typeof repo !== "string" || repo.includes("..") || repo.startsWith("/")) {
      return { payload: { error: "invalid repo", expect: "repo name without traversal" }, isError: true };
    }
  }
  if (kind !== undefined) {
    if (typeof kind !== "string" || !validId(kind)) {
      return { payload: { error: "invalid kind", expect: "short slug, no slashes" }, isError: true };
    }
  }
  if (blocked !== undefined && typeof blocked !== "boolean") {
    return { payload: { error: "invalid blocked", expect: "boolean" }, isError: true };
  }
  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      return { payload: { error: "invalid limit", expect: "integer between 1 and 1000" }, isError: true };
    }
  }
  if (fields !== undefined) {
    if (typeof fields !== "string" || fields.includes(" ") || fields.includes("\n") || fields.length > 200) {
      return { payload: { error: "invalid fields", expect: "comma-separated field names without spaces" }, isError: true };
    }
  }

  const cmd = [
    path.join(ctx.binDir, "fm-tasks-axi.sh"),
    "list",
    ...(state ? ["--state", state] : []),
    ...(repo ? ["--repo", repo] : []),
    ...(kind ? ["--kind", kind] : []),
    ...(blocked ? ["--blocked"] : []),
    ...(limit !== undefined ? ["--limit", String(limit)] : []),
    ...(fields ? ["--fields", fields] : []),
  ];
  return ownedCall(cmd, "tasks list failed", ctx.run);
}

export async function toolTasksShow(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const id = args["id"];
  const full = args["full"];
  if (!validId(id)) {
    return { payload: { error: "invalid id", expect: "short slug, no slashes" }, isError: true };
  }
  if (full !== undefined && typeof full !== "boolean") {
    return { payload: { error: "invalid full", expect: "boolean" }, isError: true };
  }
  const cmd = [
    path.join(ctx.binDir, "fm-tasks-axi.sh"),
    "show",
    id as string,
    ...(full ? ["--full"] : []),
  ];
  return ownedCall(cmd, "tasks show failed", ctx.run);
}

export async function toolTasksReady(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const repo = args["repo"];
  const includeHeld = args["include_held"];
  if (repo !== undefined) {
    if (typeof repo !== "string" || repo.includes("..") || repo.startsWith("/")) {
      return { payload: { error: "invalid repo", expect: "repo name without traversal" }, isError: true };
    }
  }
  if (includeHeld !== undefined && typeof includeHeld !== "boolean") {
    return { payload: { error: "invalid include_held", expect: "boolean" }, isError: true };
  }
  const cmd = [
    path.join(ctx.binDir, "fm-tasks-axi.sh"),
    "ready",
    ...(repo ? ["--repo", repo] : []),
    ...(includeHeld ? ["--include-held"] : []),
  ];
  return ownedCall(cmd, "tasks ready failed", ctx.run);
}

export async function toolBacklogReceive(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const relPath = args["path"];
  const bytes = args["bytes"];
  const sha256 = args["sha256"];
  const generation = args["generation"];

  if (typeof relPath !== "string" || !relPath.startsWith("state/handoff/") || !relPath.endsWith(".outbox.md") || relPath.includes("..")) {
    return { payload: { error: "invalid path", expect: "state/handoff/<id>.outbox.md without traversal" }, isError: true };
  }
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0 || bytes > 1048576) {
    return { payload: { error: "invalid bytes", expect: "non-negative integer <= 1048576" }, isError: true };
  }
  if (typeof sha256 !== "string" || !/^[A-Fa-f0-9]{64}$/.test(sha256)) {
    return { payload: { error: "invalid sha256", expect: "64 hex chars" }, isError: true };
  }
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) {
    return { payload: { error: "invalid generation", expect: "positive integer" }, isError: true };
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = [
    path.join(ctx.binDir, "fm-backlog-receive.sh"),
    relPath,
    String(bytes),
    sha256,
    String(generation),
  ];
  return ownedCall(cmd, "backlog_receive", ctx.run);
}

// --- Sessions gap area: dispatch resolution + session-start nudge reads ---
//
// The session-launch and lifecycle machinery behind these tools never runs
// through the doorway except as explicitly approval-gated denied-by-design
// verbs (below): spawning, trusting, cleaning up, arming, or switching a
// real session/backend stays firstmate-owned. The two reads here print a
// plan without launching anything.

export async function toolDispatchResolve(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  const project = args["project"];
  if (!validId(taskId)) {
    return { payload: { error: "invalid task_id", expect: "short slug, no slashes" }, isError: true };
  }
  if (project !== undefined && !validProject(project)) {
    return { payload: { error: "invalid project", expect: "bare name or projects/<name>, no absolute paths or traversal" }, isError: true };
  }
  // Canonical brief path only (data/<task-id>/brief.md, where fm-brief.sh
  // scaffolds it): arbitrary brief-file argv stays out so the resolver can
  // never be pointed at files outside this home.
  const brief = path.join(ctx.dataDir, taskId as string, "brief.md");
  const cmd = [
    path.join(ctx.binDir, "fm-dispatch-resolve.sh"),
    brief,
    ...(project ? ["--project", project as string] : []),
  ];
  const { payload, isError } = await ownedCall(cmd, "dispatch resolve failed", ctx.run);
  if (isError) return { payload, isError: true };
  return { payload: { ...payload, task_id: taskId, ...(project ? { project } : {}) }, isError: false };
}

export async function toolSessionstartNudge(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-sessionstart-nudge.sh")),
    "session-start nudge failed",
    ctx.run,
  );
  if (isError) return { payload, isError: true };
  const line = ((payload["stdout"] as string) || "").trim();
  return { payload: { ...payload, fired: line.length > 0 }, isError: false };
}

// --- Sessions gap area: denied-by-design lifecycle verbs ---
//
// Every verb below spawns, launches, trusts, cleans up, arms, or switches a
// real session/backend, so each stays OUT of doorway ownership: approval-
// gated, classified denied-by-design in manifest/COVERAGE.md, and never
// dispatched in conformance. The backend adapters (backends/*.sh) are
// sourced libraries with no CLI surface, so they are denied without a tool
// under backend_select (see scripts/gen_coverage.py DENY_ALSO) rather than
// behind an invented no-op invocation.

function validPlainArg(value: unknown, max = 500): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max &&
    !value.includes("\0") && !value.includes("\n") && !value.includes("\r");
}

function validSessionSource(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(value);
}

function validLabSession(value: unknown): value is string {
  return typeof value === "string" && /^fm-lab-[A-Za-z0-9-]{1,48}$/.test(value);
}

function homeRoot(ctx: ToolContext): string {
  return path.resolve(ctx.stateDir, "..");
}

function confineHomePath(ctx: ToolContext, relPath: string): string | null {
  const home = homeRoot(ctx);
  const resolved = path.resolve(home, relPath);
  if (resolved !== home && resolved.startsWith(home + path.sep)) return resolved;
  return null;
}

export async function toolSessionStart(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const reemit = args["reemit"];
  const source = args["source"];
  if (reemit !== undefined && typeof reemit !== "boolean") {
    return { payload: { error: "invalid reemit", expect: "boolean" }, isError: true };
  }
  if (source !== undefined && !validSessionSource(source)) {
    return { payload: { error: "invalid source", expect: "short harness source slug" }, isError: true };
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = [
    path.join(ctx.binDir, "fm-session-start.sh"),
    ...(reemit ? ["--reemit"] : []),
    ...(source ? ["--source", source as string] : []),
  ];
  return ownedCall(cmd, "session_start", ctx.run);
}

export async function toolSessionstartRun(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const source = args["source"];
  if (source !== undefined && !validSessionSource(source)) {
    return { payload: { error: "invalid source", expect: "short harness source slug" }, isError: true };
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  // --pi-prerequisite is an internal provider-preflight gate and stays out.
  const cmd = [
    path.join(ctx.binDir, "fm-sessionstart-run.sh"),
    ...(source ? ["--source", source as string] : []),
  ];
  return ownedCall(cmd, "sessionstart_run", ctx.run);
}

export async function toolSessionstartCursor(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const source = args["source"];
  if (!validSessionSource(source)) {
    return { payload: { error: "invalid source", expect: "short harness source slug" }, isError: true };
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = [path.join(ctx.binDir, "fm-sessionstart-cursor.sh"), "--source", source as string];
  return ownedCall(cmd, "sessionstart_cursor", ctx.run);
}

export async function toolHerdrLab(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const subcommand = args["subcommand"];
  const session = args["session"];
  const label = args["label"];
  const action = args["action"];
  if (typeof subcommand !== "string" || !["name", "prepare", "provision", "run", "viewer", "stop", "teardown"].includes(subcommand)) {
    return { payload: { error: "invalid subcommand", expect: "name, prepare, provision, run, viewer, stop, or teardown" }, isError: true };
  }
  if (subcommand === "name") {
    if (typeof label !== "string" || !/^[A-Za-z0-9-]{1,16}$/.test(label)) {
      return { payload: { error: "invalid label", expect: "1..16 chars, letters/digits/dashes" }, isError: true };
    }
  } else {
    if (!validLabSession(session)) {
      return { payload: { error: "invalid session", expect: "fm-lab-<label>, never default" }, isError: true };
    }
    if (subcommand === "viewer" && action !== "start" && action !== "stop") {
      return { payload: { error: "invalid action", expect: "start or stop" }, isError: true };
    }
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  // run's trailing Herdr passthrough argv stays out: free-form Herdr
  // server/lifecycle operations never pass the doorway.
  let cmd: string[];
  if (subcommand === "name") {
    cmd = [path.join(ctx.binDir, "fm-herdr-lab.sh"), "name", label as string];
  } else if (subcommand === "viewer") {
    cmd = [path.join(ctx.binDir, "fm-herdr-lab.sh"), "viewer", action as string, session as string];
  } else {
    cmd = [path.join(ctx.binDir, "fm-herdr-lab.sh"), subcommand as string, session as string];
  }
  return ownedCall(cmd, "herdr_lab", ctx.run);
}

export async function toolHerdrCiCleanup(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const command = args["command"];
  const relPath = args["path"];
  if (command !== "snapshot" && command !== "teardown") {
    return { payload: { error: "invalid command", expect: "snapshot or teardown" }, isError: true };
  }
  if (!validRelpath(relPath)) {
    return { payload: { error: "invalid path", expect: "home-relative snapshot path, no traversal" }, isError: true };
  }
  const confined = confineHomePath(ctx, relPath as string);
  if (confined === null) {
    return { payload: { error: "invalid path", expect: "home-relative snapshot path, no traversal" }, isError: true };
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = [path.join(ctx.binDir, "fm-herdr-ci-cleanup.sh"), command as string, confined];
  return ownedCall(cmd, "herdr_ci_cleanup", ctx.run);
}

export async function toolSessionCleanup(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = [path.join(ctx.binDir, "fm-herdr-session-cleanup.sh")];
  return ownedCall(cmd, "session_cleanup", ctx.run);
}

export async function toolClaudeTrust(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const worktree = args["worktree"];
  const project = args["project"];
  const home = args["home"];
  const id = args["id"];
  const worktreeMode = worktree !== undefined || project !== undefined;
  const homeMode = home !== undefined || id !== undefined;
  if (worktreeMode === homeMode) {
    return { payload: { error: "invalid mode", expect: "worktree+project or home+id, exactly one" }, isError: true };
  }
  let cmd: string[];
  if (worktreeMode) {
    if (!validPlainArg(worktree) || !validPlainArg(project)) {
      return { payload: { error: "invalid worktree", expect: "worktree and project paths, 1..500 chars" }, isError: true };
    }
    cmd = [path.join(ctx.binDir, "fm-claude-trust.sh"), worktree as string, project as string];
  } else {
    if (!validPlainArg(home) || !validId(id)) {
      return { payload: { error: "invalid home", expect: "secondmate home path plus short id" }, isError: true };
    }
    cmd = [path.join(ctx.binDir, "fm-claude-trust.sh"), "--secondmate-home", home as string, id as string];
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  return ownedCall(cmd, "claude_trust", ctx.run);
}

export async function toolAgyTrust(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const worktree = args["worktree"];
  const project = args["project"];
  if (!validPlainArg(worktree) || !validPlainArg(project)) {
    return { payload: { error: "invalid worktree", expect: "worktree and project paths, 1..500 chars" }, isError: true };
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = [path.join(ctx.binDir, "fm-agy-trust.sh"), worktree as string, project as string];
  return ownedCall(cmd, "agy_trust", ctx.run);
}

export async function toolClaudeStopAutoarm(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = [path.join(ctx.binDir, "fm-claude-stop-autoarm.sh")];
  return ownedCall(cmd, "claude_stop_autoarm", ctx.run);
}

export async function toolHerdrEventwait(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const socket = args["socket"];
  const timeoutS = args["timeout_s"];
  const paneIds = args["pane_ids"];
  if (!validPlainArg(socket)) {
    return { payload: { error: "invalid socket", expect: "control socket path, 1..500 chars" }, isError: true };
  }
  if (typeof timeoutS !== "number" || !Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > 300) {
    return { payload: { error: "invalid timeout_s", expect: "integer between 1 and 300" }, isError: true };
  }
  if (!Array.isArray(paneIds) || paneIds.length < 1 || paneIds.length > 8 ||
    !paneIds.every((p) => typeof p === "number" && Number.isInteger(p) && p > 0 && p < 2147483647)) {
    return { payload: { error: "invalid pane_ids", expect: "1..8 positive integer pane ids" }, isError: true };
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = [
    path.join(ctx.binDir, "backends", "herdr-eventwait.py"),
    socket as string,
    String(timeoutS),
    ...(paneIds as number[]).map(String),
  ];
  return ownedCall(cmd, "herdr_eventwait", ctx.run);
}

export async function toolHerdrWorkspaceMove(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const socket = args["socket"];
  const workspaceId = args["workspace_id"];
  const insertIndex = args["insert_index"];
  if (!validPlainArg(socket)) {
    return { payload: { error: "invalid socket", expect: "control socket path, 1..500 chars" }, isError: true };
  }
  if (typeof workspaceId !== "number" || !Number.isInteger(workspaceId) || workspaceId <= 0 || workspaceId >= 2147483647) {
    return { payload: { error: "invalid workspace_id", expect: "positive integer workspace id" }, isError: true };
  }
  if (typeof insertIndex !== "number" || !Number.isInteger(insertIndex) || insertIndex < 0 || insertIndex > 1000000) {
    return { payload: { error: "invalid insert_index", expect: "non-negative integer <= 1000000" }, isError: true };
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = [
    path.join(ctx.binDir, "backends", "herdr-workspace-move.py"),
    socket as string,
    String(workspaceId),
    String(insertIndex),
  ];
  return ownedCall(cmd, "herdr_workspace_move", ctx.run);
}

// --- Registry (schemas match the Python server's tools/list exactly) ---

export interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

function approvalSchema(extra: Record<string, unknown>, required?: string[]): Record<string, unknown> {
  const properties = { ...extra };
  (properties as Record<string, unknown>)["approval"] = {
    type: "string",
    description: "Explicit authorization starting with 'I authorize'",
  };
  return {
    type: "object",
    properties,
    required: required !== undefined ? [...required, "approval"] : [...Object.keys(extra), "approval"],
    additionalProperties: false,
  };
}

function idApprovalSchema(idField = "id"): Record<string, unknown> {
  return approvalSchema({ [idField]: { type: "string", description: "Task id" } });
}

export async function toolPromoteScout(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  const mode = args["mode"];
  const yolo = args["yolo"];
  if (!validId(taskId)) {
    return { payload: { error: "invalid task_id", expect: "short slug, no slashes" }, isError: true };
  }
  if (!MODES.includes(mode as (typeof MODES)[number])) {
    return { payload: { error: "invalid mode", expect: `must be one of ${MODES.join(", ")}` }, isError: true };
  }
  if (!YOLO.includes(yolo as (typeof YOLO)[number])) {
    return { payload: { error: "invalid yolo", expect: "must be on or off" }, isError: true };
  }
  const cmd = [path.join(ctx.binDir, "fm-promote.sh"), taskId as string, "--mode", mode as string, "--yolo", yolo as string];
  return ownedCall(cmd, "promote_scout", ctx.run);
}

export async function toolTeardownCrew(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  if (!validId(taskId)) {
    return { payload: { error: "invalid task_id", expect: "short slug, no slashes" }, isError: true };
  }
  const cmd = [path.join(ctx.binDir, "fm-teardown.sh"), taskId as string];
  return ownedCall(cmd, "teardown_crew", ctx.run);
}

export async function toolArmPrCheck(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  if (!validId(taskId)) {
    return { payload: { error: "invalid task_id", expect: "short slug, no slashes" }, isError: true };
  }
  const cmd = [path.join(ctx.binDir, "fm-arm-pretool-check.sh"), "--command", `fm-pr-check.sh ${taskId}`];
  return ownedCall(cmd, "arm_pr_check", ctx.run);
}

export async function toolMergePr(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  const method = args["method"] !== undefined ? args["method"] : "squash";
  if (!validId(taskId)) {
    return { payload: { error: "invalid task_id", expect: "short slug, no slashes" }, isError: true };
  }
  if (!validMergeMethod(method)) {
    return { payload: { error: "invalid method", expect: "must be squash, merge, or rebase" }, isError: true };
  }
  const cmd = [path.join(ctx.binDir, "fm-pr-merge.sh"), taskId as string, "--", `--${method}`];
  return ownedCall(cmd, "merge_pr", ctx.run);
}

export async function toolMergeLocal(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  if (!validId(taskId)) {
    return { payload: { error: "invalid task_id", expect: "short slug, no slashes" }, isError: true };
  }
  const cmd = [path.join(ctx.binDir, "fm-merge-local.sh"), taskId as string];
  return ownedCall(cmd, "merge_local", ctx.run);
}

export async function toolRepoEdit(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const relpath = args["path"];
  const content = args["content"];
  if (!validRelpath(relpath)) {
    return { payload: { error: "invalid path", expect: "home-relative path required" }, isError: true };
  }
  if (!validFileContent(content)) {
    return { payload: { error: "invalid content", expect: "string <= 256KB" }, isError: true };
  }
  const targetPath = path.resolve(ctx.dataDir, "..", relpath as string);
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content as string, "utf8");
    return {
      payload: { status: "edited", path: relpath, bytes: byteLength(content as string) },
      isError: false,
    };
  } catch (err) {
    return { payload: { error: "failed to edit file", detail: String(err) }, isError: true };
  }
}

export async function toolRepoCommit(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const message = args["message"];
  if (!validCommitMessage(message)) {
    return { payload: { error: "invalid message", expect: "1..500 chars, single line required" }, isError: true };
  }
  const cmd = ["git", "commit", "-m", message as string];
  return ownedCall(cmd, "repo_commit", ctx.run);
}

export async function toolRepoPush(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const branch = args["branch"];
  if (!validBranchName(branch)) {
    return { payload: { error: "invalid branch", expect: "non-default branch name, no traversal" }, isError: true };
  }
  const cmd = ["git", "push", "origin", branch as string];
  return ownedCall(cmd, "repo_push", ctx.run);
}

export async function toolRepoMerge(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const branch = args["branch"];
  if (!validBranchName(branch)) {
    return { payload: { error: "invalid branch", expect: "valid branch name" }, isError: true };
  }
  const cmd = ["git", "merge", "--no-ff", "-m", `Merge branch ${branch}`, branch as string];
  return ownedCall(cmd, "repo_merge", ctx.run);
}

/**
 * Open a pull request for an already-pushed branch.
 *
 * Completes the delivery chain: repo_commit and repo_push could publish a
 * branch but nothing could open the PR, so an agent had to shell out to gh
 * outside the doorway. merge_pr stays forbidden by design — this tool stops at
 * opening, and never merges.
 */
export async function toolPrOpen(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const title = args["title"];
  if (!validPrTitle(title)) {
    return {
      payload: {
        error: "invalid title",
        expect: `1..${PR_TITLE_MAX_CHARS} chars, single line required`,
      },
      isError: true,
    };
  }
  const body = args["body"];
  if (!validPrBody(body)) {
    return {
      payload: { error: "invalid body", expect: `non-empty, <= ${PR_BODY_MAX_BYTES} bytes` },
      isError: true,
    };
  }
  const head = args["head"];
  if (!validBranchName(head)) {
    return {
      payload: { error: "invalid head", expect: "non-default source branch name, no traversal" },
      isError: true,
    };
  }
  const base = args["base"] ?? DEFAULT_PR_BASE;
  if (!validBaseBranch(base)) {
    return { payload: { error: "invalid base", expect: "branch name, no traversal" }, isError: true };
  }
  const draft = args["draft"] ?? false;
  if (typeof draft !== "boolean") {
    return { payload: { error: "invalid draft", expect: "boolean" }, isError: true };
  }
  const cmd = [
    // Resolved, not a bare "gh": the serving process has a launchd PATH.
    resolveGhBin(),
    "pr",
    "create",
    "--title",
    title,
    "--body",
    body,
    "--head",
    head,
    "--base",
    base,
  ];
  if (draft) cmd.push("--draft");
  return ownedCall(cmd, "pr_open", ctx.run);
}

export async function toolDaemonStart(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const cmd = [path.join(ctx.binDir, "fm-supervise-daemon.sh")];
  return ownedCall(cmd, "daemon_start", ctx.run);
}

export async function toolDaemonStop(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const afkPath = path.join(ctx.stateDir, ".afk");
  try {
    if (fs.existsSync(afkPath)) {
      fs.unlinkSync(afkPath);
    }
    return { payload: { status: "stopped", afk: false }, isError: false };
  } catch (err) {
    return { payload: { error: "failed to stop daemon", detail: String(err) }, isError: true };
  }
}

export async function toolDaemonRestart(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const afkPath = path.join(ctx.stateDir, ".afk");
  try {
    fs.writeFileSync(afkPath, "", "utf8");
    return { payload: { status: "restarted", afk: true }, isError: false };
  } catch (err) {
    return { payload: { error: "failed to restart daemon", detail: String(err) }, isError: true };
  }
}

export async function toolDaemonStatus(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const afkPath = path.join(ctx.stateDir, ".afk");
  const isAfk = fs.existsSync(afkPath);
  return {
    payload: {
      status: isAfk ? "running" : "stopped",
      afk: isAfk,
    },
    isError: false,
  };
}

export async function toolWatchStart(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const cmd = [path.join(ctx.binDir, "fm-watch.sh")];
  return ownedCall(cmd, "watch_start", ctx.run);
}

export async function toolWatchStop(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  return { payload: { status: "stopped" }, isError: false };
}

export async function toolTaskIntake(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  const project = args["project"];
  const mode = args["mode"] !== undefined ? args["mode"] : "no-mistakes";
  if (!validId(taskId)) {
    return { payload: { error: "invalid task_id", expect: "short slug, no slashes" }, isError: true };
  }
  if (!validProject(project)) {
    return { payload: { error: "invalid project", expect: "bare name or projects/<name>" }, isError: true };
  }
  const briefRes = await toolScaffoldBrief({ task_id: taskId, project, mode, approval: args["approval"] }, ctx);
  if (briefRes.isError) return briefRes;
  return {
    payload: {
      status: "intake_complete",
      task_id: taskId,
      project,
      mode,
      brief: briefRes.payload,
    },
    isError: false,
  };
}

export async function toolWorktreeAllocate(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  const project = args["project"];
  if (!validId(taskId)) {
    return { payload: { error: "invalid task_id", expect: "short slug, no slashes" }, isError: true };
  }
  if (!validProject(project)) {
    return { payload: { error: "invalid project", expect: "bare name or projects/<name>" }, isError: true };
  }
  const wtPath = path.resolve(ctx.stateDir, "worktrees", taskId as string);
  try {
    fs.mkdirSync(wtPath, { recursive: true });
    return {
      payload: {
        status: "allocated",
        task_id: taskId,
        worktree_path: wtPath,
      },
      isError: false,
    };
  } catch (err) {
    return { payload: { error: "failed to allocate worktree", detail: String(err) }, isError: true };
  }
}

export async function toolLifecycleDrive(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  const project = args["project"];
  const mode = (args["mode"] as (typeof MODES)[number]) || "no-mistakes";
  const yolo = (args["yolo"] as "on" | "off") || "off";
  if (!validId(taskId)) {
    return { payload: { error: "invalid task_id", expect: "short slug, no slashes" }, isError: true };
  }
  if (!validProject(project)) {
    return { payload: { error: "invalid project", expect: "bare name or projects/<name>" }, isError: true };
  }
  const spawnRes = await toolSpawnCrew({ task_id: taskId, project, mode, yolo, approval: args["approval"] }, ctx);
  if (spawnRes.isError) return spawnRes;
  const stateRes = await toolCrewState({ id: taskId }, ctx);
  return {
    payload: {
      status: "lifecycle_driven",
      task_id: taskId,
      spawn: spawnRes.payload,
      current_state: stateRes.payload,
    },
    isError: false,
  };
}

export async function toolReviewGate(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  const verdict = args["verdict"] as (typeof VERDICTS)[number];
  const comment = args["comment"] as string | undefined;
  if (!validId(taskId)) {
    return { payload: { error: "invalid task_id", expect: "short slug, no slashes" }, isError: true };
  }
  if (!VERDICTS.includes(verdict)) {
    return { payload: { error: "invalid verdict", expect: `must be one of ${VERDICTS.join(", ")}` }, isError: true };
  }
  const diffRes = await toolReviewDiff({ id: taskId, stat: true }, ctx);
  if (diffRes.isError) return diffRes;
  const decRes = await toolReviewDecision({ id: taskId, verdict, comment, approval: args["approval"] }, ctx);
  if (decRes.isError) return decRes;
  return {
    payload: {
      status: "review_gate_passed",
      task_id: taskId,
      verdict,
      diff: diffRes.payload,
      decision: decRes.payload,
    },
    isError: false,
  };
}

export async function toolReconcileUpstream(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const cmd = ["python3", path.join(ctx.binDir, "..", "drift", "shift.py"), "--format", "json"];
  return ownedCall(cmd, "reconcile_upstream", ctx.run);
}

export async function toolGrantMint(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const auth = await requireAuth("grant_mint", args, ctx);
  if (!auth.ok) return auth.result;

  const grantee = args["grantee"];
  if (typeof grantee !== "string" || !grantee.trim() || grantee.length > 64) {
    return {
      payload: { error: "invalid grantee", expect: "non-empty string, max 64 chars" },
      isError: true,
    };
  }

  const tierLimit = args["tier_limit"] !== undefined ? Number(args["tier_limit"]) : 3;
  if (!Number.isInteger(tierLimit) || tierLimit < 1 || tierLimit > 4) {
    return {
      payload: { error: "invalid tier_limit", expect: "integer between 1 and 4" },
      isError: true,
    };
  }

  let tools: string[] | null = null;
  if (args["tools"] !== undefined && args["tools"] !== null) {
    if (!Array.isArray(args["tools"])) {
      return {
        payload: { error: "invalid tools", expect: "array of tool name strings or null" },
        isError: true,
      };
    }
    tools = [];
    for (const t of args["tools"]) {
      if (typeof t !== "string" || !t.trim()) {
        return {
          payload: { error: "invalid tools", expect: "array of tool name strings" },
          isError: true,
        };
      }
      const trimmed = t.trim();
      if (trimmed === "*") {
        tools.push("*");
        continue;
      }
      if (tierOf(trimmed) === TIER_FORBIDDEN || (FORBIDDEN_TOOLS as readonly string[]).includes(trimmed)) {
        return {
          payload: { error: "cannot grant forbidden tool", tool: trimmed },
          isError: true,
        };
      }
      tools.push(trimmed);
    }
  }

  let projects: string[] | null = null;
  if (args["projects"] !== undefined && args["projects"] !== null) {
    if (!Array.isArray(args["projects"])) {
      return {
        payload: { error: "invalid projects", expect: "array of project strings or null" },
        isError: true,
      };
    }
    projects = [];
    for (const p of args["projects"]) {
      if (typeof p !== "string" || !validProject(p)) {
        return {
          payload: { error: "invalid projects", expect: "array of valid project names" },
          isError: true,
        };
      }
      projects.push(p);
    }
  }

  let ttlS = 3600;
  if (args["ttl_s"] !== undefined && args["ttl_s"] !== null) {
    const parsed = Number(args["ttl_s"]);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2592000) {
      return {
        payload: { error: "invalid ttl_s", expect: "integer between 1 and 2592000 seconds (max 30 days)" },
        isError: true,
      };
    }
    ttlS = parsed;
  }

  let maxUses: number | null = null;
  if (args["max_uses"] !== undefined && args["max_uses"] !== null) {
    const parsed = Number(args["max_uses"]);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return {
        payload: { error: "invalid max_uses", expect: "positive integer" },
        isError: true,
      };
    }
    maxUses = parsed;
  }

  let note: string | null = null;
  if (args["note"] !== undefined && args["note"] !== null) {
    if (!validNote(args["note"], 200)) {
      return {
        payload: { error: "invalid note", expect: "single line, 1..200 chars" },
        isError: true,
      };
    }
    note = args["note"] as string;
  }

  const issuer = (typeof args["issuer"] === "string" && args["issuer"].trim()) ? args["issuer"].trim() : "captain";

  const result = mintGrant(
    {
      issuer,
      grantee: grantee.trim(),
      tier_limit: tierLimit as GrantTier,
      tools,
      projects,
      ttl_s: ttlS,
      max_uses: maxUses,
      note,
    },
    ctx,
  );

  return { payload: result as unknown as Record<string, unknown>, isError: false };
}

export async function toolGrantRevoke(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const auth = await requireAuth("grant_revoke", args, ctx);
  if (!auth.ok) return auth.result;

  const grantId = args["grant_id"];
  if (typeof grantId !== "string" || !grantId.trim()) {
    return {
      payload: { error: "invalid grant_id", expect: "non-empty grant ID or grant_ref" },
      isError: true,
    };
  }

  let reason: string | null = null;
  if (args["reason"] !== undefined && args["reason"] !== null) {
    if (!validNote(args["reason"], 200)) {
      return {
        payload: { error: "invalid reason", expect: "single line, 1..200 chars" },
        isError: true,
      };
    }
    reason = args["reason"] as string;
  }

  const res = revokeGrant(grantId.trim(), reason, ctx);
  if ("error" in res) {
    return { payload: res, isError: true };
  }
  return { payload: res, isError: false };
}

export async function toolGrantStatus(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const grantId = typeof args["grant_id"] === "string" && args["grant_id"].trim() ? args["grant_id"].trim() : null;
  const grantee = typeof args["grantee"] === "string" && args["grantee"].trim() ? args["grantee"].trim() : null;
  const res = getGrantStatus(grantId, grantee, ctx);
  if ("error" in res) {
    return { payload: res, isError: true };
  }
  return { payload: res, isError: false };
}

export const TOOLS: Record<string, ToolDef> = {
  fleet_snapshot: {
    description:
      "Read-only canonical fleet snapshot (backlog plus per-task state), with optional cursor pagination.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: {
          type: "string",
          description:
            "Optional pagination cursor (<snapshot_id>:<offset> or integer offset) into a cached snapshot",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          default: 50,
          description: "Maximum task rows per page",
        },
        snapshot_id: {
          type: "string",
          description:
            "Optional cached snapshot id to paginate across without re-running the snapshot script",
        },
      },
      additionalProperties: false,
    },
    handler: toolFleetSnapshot,
  },
  backlog: {
    description:
      "Read-only backlog records plus per-state task counts, derived from the fleet snapshot, with optional cursor pagination.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: {
          type: "string",
          description:
            "Optional pagination cursor (<snapshot_id>:<offset> or integer offset) into a cached snapshot",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          default: 50,
          description: "Maximum task rows per page",
        },
        snapshot_id: {
          type: "string",
          description:
            "Optional cached snapshot id to paginate across without re-running the snapshot script",
        },
      },
      additionalProperties: false,
    },
    handler: toolBacklog,
  },
  crew_state: {
    description:
      "Read-only deterministic current state of one crew; never infer state from the status log tail.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Task id" } },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolCrewState,
  },
  status_tail: {
    description: "Read-only tail of one task wake-event log; history only, not current state.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id" },
        lines: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolStatusTail,
  },
  peek: {
    description: "Read-only bounded tail of one crew endpoint for cheap diagnosis.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Exact task id" },
        lines: { type: "integer", minimum: 1, maximum: 100, default: 40 },
      },
      required: ["target"],
      additionalProperties: false,
    },
    handler: toolPeek,
  },
  fleet_view: {
    description: "Read-only human render of the fleet snapshot for operators.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolFleetView,
  },
  review_diff: {
    description: "Read-only branch-vs-base diff for one task worktree.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id" },
        stat: { type: "boolean", description: "Stat summary only", default: false },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolReviewDiff,
  },
  bearings_snapshot: {
    description:
      "Read-only compact pick-up digest projected from the fleet snapshot (local-only).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolBearingsSnapshot,
  },
  wake_drain: {
    description: "Read-only drained-wake records from the durable watcher queue.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolWakeDrain,
  },
  guard_check: {
    description: "Read-only watcher liveness and worktree-tangle verdict.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolGuardCheck,
  },
  remote_doctor: {
    description:
      "Read-only remote-home readiness diagnostic (check mode; repairs stay out).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolRemoteDoctor,
  },
  remote_file: {
    description:
      "Read-only bounded read of one home-relative file (get only; intake stays out).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Home-relative file path" },
        max_bytes: { type: "integer", minimum: 1, maximum: 262144, default: 8192 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: toolRemoteFile,
  },
  remote_delta: {
    description: "Read-only continuity-checked delta read of one append-only log.",
    inputSchema: {
      type: "object",
      properties: {
        log: { type: "string", description: "Home-relative log path" },
        offset: { type: "integer", minimum: 0, description: "Byte cursor", default: 0 },
        sha256: { type: "string", description: "64 hex chars of the exact prefix" },
        wait: { type: "integer", minimum: 0, maximum: 10, default: 0 },
      },
      required: ["log", "sha256"],
      additionalProperties: false,
    },
    handler: toolRemoteDelta,
  },
  extension_list: {
    description: "Read-only list of enabled home-local extension bindings (bind/retire/verify/process-event stay out).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolExtensionList,
  },
  extension_inspect: {
    description: "Read-only deterministic JSON for one enabled home-local extension binding.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Extension id [a-z0-9]+([.-][a-z0-9]+)*" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolExtensionInspect,
  },
  handoff_status: {
    description:
      "Read-only staged handoff outboxes: list staged moves, or read one outbox tail.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Secondmate id" },
        lines: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      },
      additionalProperties: false,
    },
    handler: toolHandoffStatus,
  },
  harness_detect: {
    description:
      "Read-only harness detection for this home; closed mode subset, never walks process ancestry.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["own", "crew", "secondmate", "secondmate-model", "secondmate-effort"],
          default: "own",
        },
      },
      additionalProperties: false,
    },
    handler: toolHarnessDetect,
  },
  project_mode: {
    description: "Read-only registered delivery posture (mode + yolo) for one project.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "Bare name or projects/<name>" } },
      required: ["project"],
      additionalProperties: false,
    },
    handler: toolProjectMode,
  },
  lock_status: {
    description: "Read-only per-home session lock status; acquiring stays out.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolLockStatus,
  },
  lease_check: {
    description: "Read-only per-task supervision lease check; claim/release/sweep stay out.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Task id" } },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolLeaseCheck,
  },
  bearings_board_path: {
    description:
      "Read-only stable path of the captain's bearings board; building/arming stays out.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolBearingsBoardPath,
  },
  inbox_status: {
    description: "Read-only captain inbox status from durable records; sends no wake.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolInboxStatus,
  },
  inbox_list: {
    description: "Read-only list of queued captain inbox notes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolInboxList,
  },
  home_summary: {
    description: "Read-only published home-summary ledger; refresh stays firstmate-owned.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolHomeSummary,
  },
  home_summary_refresh: {
    description:
      "Atomically refresh and publish state/home-summary.json for this FM_HOME.",
    inputSchema: {
      type: "object",
      properties: {
        best_effort: {
          type: "boolean",
          description: "Log failures to .home-summary-refresh.log and exit 0",
          default: false,
        },
      },
      additionalProperties: false,
    },
    handler: toolHomeSummaryRefresh,
  },
  contributions_snapshot: {
    description:
      "Read-only owned-contribution coverage projected from the fleet snapshot; never contacts a forge.",
    inputSchema: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "Include rows for supervisor inspection", default: false },
      },
      additionalProperties: false,
    },
    handler: toolContributionsSnapshot,
  },
  contributions_pending: {
    description: "Read-only pending contribution event tokens from saved records.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolContributionsPending,
  },
  send_message: {
    description:
      "Steer one crew with a single verified prose line; slash commands, keys, raw panes, and lifecycle verbs are refused.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Exact task id" },
        text: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["target", "text"],
      additionalProperties: false,
    },
    handler: toolSendMessage,
  },
  lifecycle_interrupt: {
    description:
      "Authority write: deliver the harness interrupt sequence to one crew; agent keeps running.",
    inputSchema: idApprovalSchema(),
    handler: (args, ctx) => lifecycleTool(args, ctx, "interrupt", false),
  },
  lifecycle_exit: {
    description:
      "Authority write: stop one agent, preserving its endpoint, worktree, and uncommitted changes.",
    inputSchema: idApprovalSchema(),
    handler: (args, ctx) => lifecycleTool(args, ctx, "exit", false),
  },
  lifecycle_relaunch: {
    description:
      "Authority write: transactionally replace one running agent in the same endpoint and worktree.",
    inputSchema: approvalSchema({
      id: { type: "string", description: "Task id" },
      note: { type: "string", description: "Progress note, single line 1..500 chars" },
    }),
    handler: (args, ctx) => lifecycleTool(args, ctx, "relaunch", true),
  },
  lifecycle_suspend: {
    description: "Authority write: park one persistent secondmate with a durable note.",
    inputSchema: approvalSchema({
      id: { type: "string", description: "Task id" },
      note: { type: "string", description: "Park note, single line 1..500 chars" },
    }),
    handler: (args, ctx) => lifecycleTool(args, ctx, "suspend", true),
  },
  lifecycle_resume: {
    description: "Authority write: restore one parked secondmate with a durable note.",
    inputSchema: approvalSchema({
      id: { type: "string", description: "Task id" },
      note: { type: "string", description: "Resume note, single line 1..500 chars" },
    }),
    handler: (args, ctx) => lifecycleTool(args, ctx, "resume", true),
  },
  spawn_crew: {
    description:
      "Authority write: spawn one direct report via fm-spawn.sh with an explicit delivery contract.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      project: { type: "string", description: "Bare name or projects/<name>" },
      mode: { type: "string", enum: [...MODES] },
      yolo: { type: "string", enum: ["on", "off"] },
    }),
    handler: toolSpawnCrew,
  },
  scaffold_brief: {
    description:
      "Authority write: scaffold one crewmate brief via fm-brief.sh; does not launch anything.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      project: { type: "string", description: "Bare name or projects/<name>" },
      mode: { type: "string", enum: [...BRIEF_MODES] },
    }),
    handler: toolScaffoldBrief,
  },
  decision_hold: {
    description:
      "Authority write: record one durable captain-held decision via fm-decision-hold.sh hold.",
    inputSchema: approvalSchema({
      origin_id: { type: "string" },
      decision_key: { type: "string", description: "Short slug" },
      title: { type: "string" },
      reason: { type: "string" },
    }),
    handler: toolDecisionHold,
  },
  decision_resolve: {
    description:
      "Authority write: resolve one held decision via fm-decision-hold.sh resolve with a decision file.",
    inputSchema: approvalSchema({
      origin_id: { type: "string" },
      decision_key: { type: "string" },
      routed_to: { type: "string", description: "Task id receiving the decision" },
      decision_text: { type: "string", description: "Decision record, 1..2000 chars" },
    }),
    handler: toolDecisionResolve,
  },
  decision_release: {
    description:
      "Authority write: release one captain hold via fm-decision-hold.sh resolve or fm-captain-hold.sh answer --release with a durable decision record.",
    inputSchema: approvalSchema({
      origin_id: { type: "string", description: "Origin task id for composed hold" },
      decision_key: { type: "string", description: "Short slug when origin_id is given" },
      id: { type: "string", description: "Direct task id to release" },
      routed_to: { type: "string", description: "Task id receiving the decision" },
      decision_text: { type: "string", description: "Decision record, 1..2000 chars" },
    }),
    handler: toolDecisionRelease,
  },
  decision_complete: {
    description:
      "Authority write: attest the reviewed inventory of captain-held tasks for an origin via fm-captain-hold.sh complete.",
    inputSchema: approvalSchema({
      origin_id: { type: "string", description: "Origin task id" },
      none: { type: "boolean", description: "Explicit attestation that no captain decisions remain" },
      task_ids: {
        type: "array",
        items: { type: "string" },
        description: "List of captain-held task ids or keys",
      },
    }),
    handler: toolDecisionComplete,
  },
  decision_verify: {
    description:
      "Open read: verify that an origin has completed its captain-call inventory and no open keyed decisions remain via fm-captain-hold.sh verify.",
    inputSchema: {
      type: "object",
      properties: {
        origin_id: { type: "string", description: "Origin task id" },
      },
      required: ["origin_id"],
      additionalProperties: false,
    },
    handler: toolDecisionVerify,
  },
  decision_open: {
    description:
      "Open read: check if a captain-held task is still open, optionally retrieving its lifecycle identity via fm-captain-hold.sh open.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id" },
        identity: { type: "boolean", description: "Retrieve lifecycle identity" },
        distinguish_absent: { type: "boolean", description: "Distinguish absent tasks from not-open tasks" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolDecisionOpen,
  },
  decision_diverged: {
    description:
      "Open read: check for divergence between status log decisions and durable captain holds via fm-captain-hold.sh diverged.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: toolDecisionDiverged,
  },
  review_decision: {
    description:
      "Authority write: record one captain approve, decline, or comment via fm-captain-hold.sh answer with a decision file.",
    inputSchema: approvalSchema({
      id: { type: "string" },
      verdict: { type: "string", enum: [...VERDICTS] },
      comment: { type: "string", description: "Optional single-line comment" },
      release: { type: "boolean", description: "Release hold so held work resumes (tasks-axi unhold) instead of closing task" },
    }),
    handler: toolReviewDecision,
  },
  relay_reply: {
    description: "External send: post one public-safe reply to the relay via fm-x-reply.sh.",
    inputSchema: approvalSchema({
      request_id: { type: "string" },
      text: { type: "string", description: "Reply text, 1..2000 chars" },
    }),
    handler: toolRelayReply,
  },
  relay_dismiss: {
    description:
      "External send: dismiss one pending relay mention without replying via fm-x-dismiss.sh.",
    inputSchema: idApprovalSchema("request_id"),
    handler: toolRelayDismiss,
  },
  relay_followup: {
    description:
      "External send: post one completion follow-up for a relay-linked task via fm-x-followup.sh.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      text: { type: "string", description: "Follow-up text, 1..2000 chars" },
      final: { type: "boolean", description: "Clear the link after this post" },
    }),
    handler: toolRelayFollowup,
  },
  secondmate_nudge: {
    description:
      "Authority write: ask mismatched secondmates to reconcile via the cooldown-guarded notify path.",
    inputSchema: approvalSchema({}),
    handler: toolSecondmateNudge,
  },
  secondmate_restart: {
    description:
      "Authority write: restart secondmates onto current wiring after persist; ids only.",
    inputSchema: approvalSchema({
      ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 },
    }),
    handler: toolSecondmateRestart,
  },
  secondmate_report: {
    description:
      "Authority write: append one correlated report to the parent channel; the helper resolves the destination.",
    inputSchema: approvalSchema({
      verb: { type: "string", description: "Report verb slug" },
      corr: { type: "string", description: "16 hex chars, optional corr= prefix" },
      note: { type: "string", description: "Report note, single line 1..500 chars" },
    }),
    handler: toolSecondmateReport,
  },
  remote_control: {
    description:
      "Authority write: closed state/route/observe/send subset of remote secondmate control.",
    inputSchema: approvalSchema({
      verb: { type: "string", enum: [...REMOTE_CONTROL_VERBS] },
      id: { type: "string", description: "Secondmate id" },
      text: { type: "string", description: "Prose steer for send, 1..500 chars" },
    }),
    handler: toolRemoteControl,
  },
  handoff_move: {
    description:
      "Authority write: hand queued backlog items to a secondmate, or resume pending wakes.",
    inputSchema: approvalSchema({
      id: { type: "string", description: "Secondmate id" },
      keys: { type: "array", items: { type: "string" }, description: "1..20 backlog item keys" },
      resume: {
        type: "boolean",
        description: "Resume pending wakes; takes no keys",
        default: false,
      },
    }),
    handler: toolHandoffMove,
  },
  mail_status: {
    description: "Read-only mail configuration and last poll cursor; no network, no wake.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolMailStatus,
  },
  mail_read: {
    description:
      "Read-only unseen-INBOX digest over BODY.PEEK; mail stays unseen until firstmate answers.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolMailRead,
  },
  mail_check: {
    description:
      "Read-only inbound received-mail check; arming/disarming the watcher check stays out of MCP.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolMailCheck,
  },
  mail_send: {
    description: "External send: one SMTP message via fm-mail.sh send; credentials live outside MCP.",
    inputSchema: approvalSchema({
      to: { type: "string", description: "Recipient address with @" },
      subject: { type: "string", description: "Subject, single line 1..200 chars" },
      body: { type: "string", description: "Body, 1..5000 chars, piped via stdin" },
    }),
    handler: toolMailSend,
  },
  voice_status: {
    description:
      "Read-only voice-agent status answer from durable records; no mic, no Bedrock, no audio.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["counts", "full"], default: "counts" },
      },
      additionalProperties: false,
    },
    handler: toolVoiceStatus,
  },
  voice_queue: {
    description: "Authority write: hand one request to firstmate through the voice handover queue.",
    inputSchema: approvalSchema({
      text: { type: "string", description: "Request text, single line 1..500 chars" },
    }),
    handler: toolVoiceQueue,
  },
  lint_versions: {
    description: "Read-only required ShellCheck/actionlint pins from the lint owners (actionlint degrades to an unsupported-probe record when its owning script is retired upstream).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolLintVersions,
  },
  tool_update_check: {
    description: "Read-only watched-tool update report; repairs nothing, installs nothing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolToolUpdateCheck,
  },
  vendor_auth_probe: {
    description: "Read-only bounded vendor auth probe; raw output is classified, never printed.",
    inputSchema: {
      type: "object",
      properties: { probe: { type: "string", enum: ["grok"] } },
      required: ["probe"],
      additionalProperties: false,
    },
    handler: toolVendorAuthProbe,
  },
  startup_memory: {
    description: "Read-only startup-memory budget read or local estimate; never creates config.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["read", "report"], default: "read" },
      },
      additionalProperties: false,
    },
    handler: toolStartupMemory,
  },
  startup_network_report: {
    description: "Read-only deferred startup-network stage report (state + last-run timings); start/run/harvest/wait stay out.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolStartupNetworkReport,
  },
  doc_audience_check: {
    description: "Read-only docs audience-inventory + local-link validation for one home-confined repo root (default: this home).",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Home-relative repo root to check" },
      },
      additionalProperties: false,
    },
    handler: toolDocAudienceCheck,
  },
  home_seed_validate: {
    description: "Read-only secondmate-registry validation; provisioning (clones, markers, leases) stays out.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolHomeSeedValidate,
  },
  stow_cascade: {
    description: "Read-only /stow cascade enumeration: per-home budget report + transport judgement; curation stays with the skill.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolStowCascade,
  },
  test_isolation_list: {
    description: "Read-only isolation-proof topology: proven concurrent candidates or kept-serial exclusions; proof runs stay out.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["candidates", "exclusions"], default: "candidates" },
        pool: { type: "string", description: "Candidate pool: portable or a test-runner family name", default: "portable" },
      },
      additionalProperties: false,
    },
    handler: toolTestIsolationList,
  },
  test_run_list: {
    description: "Read-only test-runner topology: families, lanes, concurrent-safe families, or the parallel coverage guard; suite runs stay out.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["families", "lanes", "concurrent_safe", "coverage"], default: "families" },
      },
      additionalProperties: false,
    },
    handler: toolTestRunList,
  },
  test_run: {
    description:
      "Authority write: run the firstmate behavior-test runner for one selection (all, family, changed, lane, proven-isolated, or explicit scripts); --list and --check-coverage inspect without executing.",
    inputSchema: approvalSchema(
      {
        mode: {
          type: "string",
          enum: ["all", "family", "changed", "lane", "proven-isolated", "scripts"],
          description: "What to run",
        },
        family: { type: "string", description: "Family name for mode=family" },
        lane: { type: "string", description: "Lane name for mode=lane" },
        base: { type: "string", description: "Git ref for mode=changed (defaults to the runner's own base)" },
        scripts: {
          type: "array",
          items: { type: "string" },
          description: "tests/<name>.test.sh paths for mode=scripts",
        },
        list: { type: "boolean", description: "Inspect the selection without executing it" },
        check_coverage: { type: "boolean", description: "Run the parallel coverage guard instead of a suite" },
      },
      ["mode"],
    ),
    handler: toolTestRun,
  },
  pr_state: {
    description: "Read-only blockers on one GitHub pull request; never posts, requests, or merges.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "https://github.com/<owner>/<repo>/pull/<number>" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    handler: toolPrState,
  },
  pr_poll: {
    description: "Read-only static merge-poll watcher check source; returns merged when merged, silent otherwise.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "https://github.com/<owner>/<repo>/pull/<number>" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    handler: toolPrPoll,
  },
  pr_reviewers: {
    description: "Read-only advisory reviewer candidates from a PR's changed files and recent authorship; never requests or assigns reviews.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "https://github.com/<owner>/<repo>/pull/<number>" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    handler: toolPrReviewers,
  },
  pr_open: {
    description:
      "Authority write: open a pull request for an already-pushed non-default branch; never merges.",
    inputSchema: approvalSchema(
      {
        title: { type: "string", description: `PR title, 1..${PR_TITLE_MAX_CHARS} chars, single line` },
        body: { type: "string", description: `PR body, non-empty, <= ${PR_BODY_MAX_BYTES} bytes` },
        head: { type: "string", description: "Source branch (non-default, already pushed)" },
        base: { type: "string", description: `Target branch (default ${DEFAULT_PR_BASE})` },
        draft: { type: "boolean", description: "Open as a draft PR" },
      },
      ["title", "body", "head"],
    ),
    handler: toolPrOpen,
  },
  arm_policy_check: {
    description: "Read-only watcher-arm command-policy verdict (allow or deny) for one shell command; never executes it.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "shell text to classify, 1..4000 chars" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    handler: toolArmPolicyCheck,
  },
  cd_policy_check: {
    description: "Read-only cd-guard command-policy verdict (allow or deny) for one shell command; never executes it.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "shell text to classify, 1..4000 chars" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    handler: toolCdPolicyCheck,
  },
  subagent_policy_check: {
    description: "Read-only subagent-guard verdict (allow or deny) for one harness tool name; never delegates.",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "harness tool name to classify, single line" },
      },
      required: ["tool"],
      additionalProperties: false,
    },
    handler: toolSubagentPolicyCheck,
  },
  supervision_instructions: {
    description: "Read-only render of the tracked supervision operating block for one harness, or its one-line repair instruction.",
    inputSchema: {
      type: "object",
      properties: {
        harness: { type: "string", enum: ["claude", "codex", "opencode", "pi", "pi-signed", "grok", "cursor", "omp"] },
        read_only: { type: "boolean" },
        afk: { type: "boolean" },
        afk_mode: { type: "string", enum: ["away", "quiet"] },
        x_mode: { type: "boolean" },
        queue_pending: { type: "boolean" },
        repair_line: { type: "boolean" },
      },
      additionalProperties: false,
    },
    handler: toolSupervisionInstructions,
  },
  quota_choose: {
    description: "Deterministic first quota-eligible dispatch candidate from an already-captured quota snapshot; never takes a fresh snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        snapshot: { type: "string", description: "captured quota-axi JSON (schemaVersion 5) or TOON text, 1..65536 chars" },
        candidates: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16, description: "ordered <harness>:<model> tokens" },
      },
      required: ["snapshot", "candidates"],
      additionalProperties: false,
    },
    handler: toolQuotaChoose,
  },
  relay_poll: {
    description: "Read-only short-poll of the relay connector; hard no-op without relay consent.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolRelayPoll,
  },
  public_followup_pending: {
    description:
      "Open public-followup loop digest; reports unresolved and delivered public loops without mutating state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolPublicFollowupPending,
  },
  public_followup_collect: {
    description:
      "Non-destructively read typed terminal events staged in this home's outbox for an obligation.",
    inputSchema: {
      type: "object",
      properties: {
        obligation_id: {
          type: "string",
          description: "tasks-axi public-followup obligation id (short slug)",
        },
      },
      required: ["obligation_id"],
      additionalProperties: false,
    },
    handler: toolPublicFollowupCollect,
  },
  public_followup_emit: {
    description:
      "Authority write: emit a structured terminal event for work bound to a public commitment.",
    inputSchema: approvalSchema({
      obligation_id: { type: "string" },
      relation_id: { type: "string" },
      source_home: { type: "string" },
      work_id: { type: "string" },
      generation: { type: "integer", minimum: 1 },
      outcome: { type: "string" },
      outcome_text: { type: "string" },
    }),
    handler: toolPublicFollowupEmit,
  },
  relay_link: {
    description: "Authority write: link a task to the relay mention that triggered it.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      request_id: { type: "string" },
    }),
    handler: toolRelayLink,
  },
  fleet_sync: {
    description: "Authority write: refresh project clones with safe fast-forwards, self-heals, and branch pruning.",
    inputSchema: approvalSchema({
      project: { type: "string", description: "Optional project name or relative path" },
    }, []),
    handler: toolFleetSync,
  },
  inactive_reconcile: {
    description: "Authority write: run bounded reconciliation of inactive crewmate terminal outcomes.",
    inputSchema: approvalSchema({
      mode: { type: "string", enum: ["scan", "report", "acknowledge"], description: "Reconciliation mode" },
      startup: { type: "boolean", description: "Run startup scan immediately" },
      task_id: { type: "string", description: "Task ID for report mode" },
      fingerprint: { type: "string", description: "Outcome fingerprint for acknowledge mode" },
    }, []),
    handler: toolInactiveReconcile,
  },
  tasks_list: {
    description: "Read-only backlog item listing via fm-tasks-axi.sh list.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["queued", "in_flight", "done", "held", "all"], description: "Filter by task state" },
        repo: { type: "string", description: "Filter by repository name" },
        kind: { type: "string", description: "Filter by task kind" },
        blocked: { type: "boolean", description: "Filter to blocked tasks" },
        limit: { type: "integer", description: "Maximum number of items to list (1..1000)" },
        fields: { type: "string", description: "Comma-separated field list" },
      },
      additionalProperties: false,
    },
    handler: toolTasksList,
  },
  tasks_show: {
    description: "Read-only inspection of one task in the backlog via fm-tasks-axi.sh show.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task ID slug" },
        full: { type: "boolean", description: "Include full body notes" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolTasksShow,
  },
  tasks_ready: {
    description: "Read-only list of dependency-cleared ready queued work via fm-tasks-axi.sh ready.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Filter by repository name" },
        include_held: { type: "boolean", description: "Include held work in a separate section" },
      },
      additionalProperties: false,
    },
    handler: toolTasksReady,
  },
  dispatch_resolve: {
    description: "Read-only dispatch resolution for one task brief; prints a dispatch plan without launching anything.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task id whose data/<id>/brief.md is resolved" },
        project: { type: "string", description: "Bare name or projects/<name>" },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    handler: toolDispatchResolve,
  },
  sessionstart_nudge: {
    description: "Read-only session-start nudge read; prints the one-line start instruction or nothing, exits 0.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolSessionstartNudge,
  },
  session_start: {
    description: "Authority write: run the whole session-start bootstrap (lock, sweeps, digests).",
    inputSchema: approvalSchema({
      reemit: { type: "boolean", description: "Re-emit context only" },
      source: { type: "string", description: "Harness session-open source slug" },
    }, []),
    handler: toolSessionStart,
  },
  sessionstart_run: {
    description: "Authority write: run the session-open digest runner for one harness source.",
    inputSchema: approvalSchema({
      source: { type: "string", description: "Harness session-open source slug" },
    }, []),
    handler: toolSessionstartRun,
  },
  sessionstart_cursor: {
    description: "Authority write: run the Cursor session-open transport for one harness source.",
    inputSchema: approvalSchema({
      source: { type: "string", description: "Harness session-open source slug" },
    }, ["source"]),
    handler: toolSessionstartCursor,
  },
  herdr_lab: {
    description: "Authority write: operate one isolated Herdr lab session (never default).",
    inputSchema: approvalSchema({
      subcommand: { type: "string", enum: ["name", "prepare", "provision", "run", "viewer", "stop", "teardown"] },
      session: { type: "string", description: "fm-lab-<label> session name" },
      label: { type: "string", description: "Short label for the name subcommand" },
      action: { type: "string", enum: ["start", "stop"], description: "Viewer action" },
    }, ["subcommand"]),
    handler: toolHerdrLab,
  },
  herdr_ci_cleanup: {
    description: "Authority write: snapshot or tear down CI-owned Herdr lab sessions from a snapshot file.",
    inputSchema: approvalSchema({
      command: { type: "string", enum: ["snapshot", "teardown"] },
      path: { type: "string", description: "Home-relative snapshot file path" },
    }, ["command", "path"]),
    handler: toolHerdrCiCleanup,
  },
  session_cleanup: {
    description: "Authority write: retire stale restored-shell Herdr presentation children at locked session start.",
    inputSchema: approvalSchema({}, []),
    handler: toolSessionCleanup,
  },
  claude_trust: {
    description: "Authority write: pre-register Claude Code workspace trust for a spawn target.",
    inputSchema: approvalSchema({
      worktree: { type: "string", description: "Isolated task worktree this spawn launches into" },
      project: { type: "string", description: "Primary checkout that worktree belongs to" },
      home: { type: "string", description: "Seeded secondmate home this spawn launches into" },
      id: { type: "string", description: "Secondmate id that home is marked for" },
    }, []),
    handler: toolClaudeTrust,
  },
  agy_trust: {
    description: "Authority write: pre-register Antigravity workspace trust for a spawn worktree.",
    inputSchema: approvalSchema({
      worktree: { type: "string", description: "Isolated task worktree this spawn launches into" },
      project: { type: "string", description: "Primary checkout that worktree belongs to" },
    }, ["worktree", "project"]),
    handler: toolAgyTrust,
  },
  claude_stop_autoarm: {
    description: "Authority write: run the Claude Stop-owned watcher auto-arm hook path.",
    inputSchema: approvalSchema({}, []),
    handler: toolClaudeStopAutoarm,
  },
  herdr_eventwait: {
    description: "Authority write: wait on a Herdr session control socket for pane status transitions.",
    inputSchema: approvalSchema({
      socket: { type: "string", description: "Herdr session control socket path" },
      timeout_s: { type: "integer", description: "Bounded wait budget, 1..300 seconds" },
      pane_ids: { type: "array", items: { type: "integer" }, description: "Pane ids to subscribe (1..8)" },
    }, ["socket", "timeout_s", "pane_ids"]),
    handler: toolHerdrEventwait,
  },
  herdr_workspace_move: {
    description: "Authority write: send one workspace.move request to a Herdr session control socket.",
    inputSchema: approvalSchema({
      socket: { type: "string", description: "Herdr session control socket path" },
      workspace_id: { type: "integer", description: "Exact workspace id to move" },
      insert_index: { type: "integer", description: "Non-negative insert index" },
    }, ["socket", "workspace_id", "insert_index"]),
    handler: toolHerdrWorkspaceMove,
  },
  backlog_receive: {
    description: "Authority write: receive one delivered remote-secondmate outbox into this home's backlog.",
    inputSchema: approvalSchema({
      path: { type: "string", description: "Delivered outbox path (state/handoff/<id>.outbox.md)" },
      bytes: { type: "integer", description: "Expected byte size" },
      sha256: { type: "string", description: "Expected SHA-256 digest" },
      generation: { type: "integer", description: "Upload generation" },
    }, ["path", "bytes", "sha256", "generation"]),
    handler: toolBacklogReceive,
  },
  receipt_submit: {
    description:
      "Detach one tool call past the 30s fail-closed budget; returns a pending receipt to poll with receipt_status.",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "Name of the tool to run detached" },
        arguments: {
          type: "object",
          description:
            "Arguments for the named tool, including its approval when it requires one",
        },
      },
      required: ["tool", "arguments"],
      additionalProperties: false,
    },
    handler: toolReceiptSubmit,
  },
  receipt_status: {
    description:
      "Read-only check on one detached receipt; reports running, done with the result attached, failed, or expired.",
    inputSchema: {
      type: "object",
      properties: {
        receipt_id: {
          type: "string",
          description: "Receipt id from a receipt_submit pending response",
        },
      },
      required: ["receipt_id"],
      additionalProperties: false,
    },
    handler: toolReceiptStatus,
  },
  fleet_poll: {
    description:
      "Read-only convenience poller over fleet_snapshot for clients that need push-like updates.",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1, maximum: 3, default: 2 },
        interval_s: { type: "number", minimum: 0, maximum: 2, default: 0 },
      },
      additionalProperties: false,
    },
    handler: toolFleetPoll,
  },
  promote_scout: {
    description: "Authority write: promote a scout task to a ship task in place.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      mode: { type: "string", enum: [...MODES] },
      yolo: { type: "string", enum: ["on", "off"] },
    }),
    handler: toolPromoteScout,
  },
  teardown_crew: {
    description: "Authority write: tear down one completed crew and release resources.",
    inputSchema: idApprovalSchema("task_id"),
    handler: toolTeardownCrew,
  },
  arm_pr_check: {
    description: "Authority write: arm watcher PR check for a landed crew task.",
    inputSchema: idApprovalSchema("task_id"),
    handler: toolArmPrCheck,
  },
  merge_pr: {
    description: "Authority write: merge a task PR or MR via fm-pr-merge.sh.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      method: { type: "string", enum: ["squash", "merge", "rebase"], default: "squash" },
    }),
    handler: toolMergePr,
  },
  merge_local: {
    description: "Authority write: fast-forward local default branch for mode=local-only tasks.",
    inputSchema: idApprovalSchema("task_id"),
    handler: toolMergeLocal,
  },
  repo_edit: {
    description: "Authority write: edit or create a bounded file within the workspace.",
    inputSchema: approvalSchema({
      path: { type: "string", description: "Home-relative path" },
      content: { type: "string", description: "File content (<= 256KB)" },
    }),
    handler: toolRepoEdit,
  },
  repo_commit: {
    description: "Authority write: commit workspace changes with a single-line message.",
    inputSchema: approvalSchema({
      message: { type: "string", description: "Commit message 1..500 chars" },
    }),
    handler: toolRepoCommit,
  },
  repo_push: {
    description: "Authority write: push a non-default branch to origin.",
    inputSchema: approvalSchema({
      branch: { type: "string", description: "Target branch name" },
    }),
    handler: toolRepoPush,
  },
  repo_merge: {
    description: "Authority write: merge a branch with --no-ff.",
    inputSchema: approvalSchema({
      branch: { type: "string", description: "Branch to merge" },
    }),
    handler: toolRepoMerge,
  },
  daemon_start: {
    description: "Authority write: start the away-mode supervisor daemon.",
    inputSchema: approvalSchema({}),
    handler: toolDaemonStart,
  },
  daemon_stop: {
    description: "Authority write: stop the away-mode supervisor daemon by clearing .afk.",
    inputSchema: approvalSchema({}),
    handler: toolDaemonStop,
  },
  daemon_restart: {
    description: "External write: restart the away-mode supervisor daemon.",
    inputSchema: approvalSchema({}),
    handler: toolDaemonRestart,
  },
  daemon_status: {
    description: "Read-only check on the supervisor daemon state and away posture.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolDaemonStatus,
  },
  watch_start: {
    description: "Authority write: run one watcher polling cycle.",
    inputSchema: approvalSchema({}),
    handler: toolWatchStart,
  },
  watch_stop: {
    description: "Authority write: stop watcher cycle.",
    inputSchema: approvalSchema({}),
    handler: toolWatchStop,
  },
  task_intake: {
    description: "Authority composite: ingest task and scaffold brief.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      project: { type: "string", description: "Bare name or projects/<name>" },
      mode: { type: "string", enum: [...BRIEF_MODES], default: "no-mistakes" },
    }),
    handler: toolTaskIntake,
  },
  worktree_allocate: {
    description: "Authority write: allocate isolated worktree slot for task.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      project: { type: "string" },
    }),
    handler: toolWorktreeAllocate,
  },
  lifecycle_drive: {
    description: "Authority composite: spawn crew and capture initial state.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      project: { type: "string" },
      mode: { type: "string", enum: [...MODES], default: "no-mistakes" },
      yolo: { type: "string", enum: ["on", "off"], default: "off" },
    }),
    handler: toolLifecycleDrive,
  },
  review_gate: {
    description: "Authority composite: inspect diff and record captain review decision.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      verdict: { type: "string", enum: [...VERDICTS] },
      comment: { type: "string" },
    }),
    handler: toolReviewGate,
  },
  reconcile_upstream: {
    description: "Authority composite: run upstream drift/shift report for reconciliation.",
    inputSchema: approvalSchema({}),
    handler: toolReconcileUpstream,
  },
  grant_mint: {
    description:
      "Authority write: mint a new scoped standing approval grant for autonomous loops.",
    inputSchema: approvalSchema({
      grantee: { type: "string", description: "Identity receiving the grant (e.g. task id or agent name)" },
      tier_limit: { type: "integer", minimum: 1, maximum: 4, default: 3, description: "Maximum tier allowed by grant" },
      tools: { type: "array", items: { type: "string" }, description: "Optional allowlist of tool names" },
      projects: { type: "array", items: { type: "string" }, description: "Optional allowlist of projects" },
      ttl_s: { type: "integer", minimum: 1, maximum: 2592000, default: 3600, description: "Grant lifetime in seconds" },
      max_uses: { type: "integer", minimum: 1, description: "Optional maximum usage count" },
      note: { type: "string", description: "Optional description or note for the grant" },
    }),
    handler: toolGrantMint,
  },
  grant_revoke: {
    description: "Authority write: revoke an active standing approval grant immediately.",
    inputSchema: approvalSchema({
      grant_id: { type: "string", description: "Grant ID or grant_ref to revoke" },
      reason: { type: "string", description: "Optional revocation reason" },
    }),
    handler: toolGrantRevoke,
  },
  grant_status: {
    description:
      "Read-only inspection of standing approval grants (safe metadata only, never exposes secrets).",
    inputSchema: {
      type: "object",
      properties: {
        grant_id: { type: "string", description: "Optional grant ID or grant_ref to inspect" },
        grantee: { type: "string", description: "Optional grantee filter" },
      },
      additionalProperties: false,
    },
    handler: toolGrantStatus,
  },
};

export const TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(TOOLS));

void APPROVAL_PREFIX;
