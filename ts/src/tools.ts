/**
 * The 36 smarts-only tools, in feature-manifest order.
 *
 * SUPPORTED (no approval): fleet_snapshot, backlog, crew_state,
 * status_tail, send_message (+ fleet_poll, the read-only poller, peek,
 * fleet_view, review_diff, bearings_snapshot, wake_drain, guard_check,
 * remote_doctor, remote_file, remote_delta, handoff_status,
 * plus receipt_submit/receipt_status, the fail-closed async receipts).
 * CHANGED (approval-gated): decision_hold, decision_resolve,
 * lifecycle_interrupt/exit/relaunch/suspend/resume, relay_reply/dismiss/
 * followup, review_decision, scaffold_brief, spawn_crew,
 * secondmate_nudge/restart/report, remote_control, handoff_move.
 *
 * Refused by the deny-list (no tool, answered unknown): promote_scout,
 * teardown_crew, arm_pr_check, merge_pr, merge_local, daemon_start/stop/
 * restart, watch_start/stop, repo_edit/commit/push/merge.
 *
 * Every tool shells to its owning bin/fm-*.sh script and never reimplements
 * firstmate behavior. Wire payloads match the Python server exactly so the
 * shared conformance checks are the referee between the two paths.
 */
import { randomBytes } from "node:crypto";
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
  MAX_OUTPUT_BYTES,
  MODES,
  RECEIPT_DIRNAME,
  RECEIPT_TIMEOUT_S,
  RECEIPT_TTL_S,
  REMOTE_CONTROL_VERBS,
  REMOTE_FILE_DEFAULT_MAX_BYTES,
  RESTART_IDS_MAX,
  SEND_TEXT_MAX_CHARS,
  SNAPSHOT_SCHEMA,
  VERDICTS,
  YOLO,
  binDir as defaultBinDir,
  dataDir as defaultDataDir,
  stateDir as defaultStateDir,
} from "./constants.js";
import { ownedCall, runScript, truncate, byteLength, isRunResult } from "./runner.js";
import {
  confineHandoffPath,
  confineStatePath,
  validApproval,
  validCorr,
  validDeltaWait,
  validHandoffLines,
  validId,
  validIdList,
  validNonnegInt,
  validNote,
  validPeekLines,
  validProject,
  validRelpath,
  validRemoteMaxBytes,
  validSha256,
  validStatusLines,
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
const NEEDS_APPROVAL: ReadonlySet<string> = new Set([
  "lifecycle_interrupt", "lifecycle_exit", "lifecycle_relaunch",
  "lifecycle_suspend", "lifecycle_resume", "spawn_crew",
  "scaffold_brief", "decision_hold", "decision_resolve",
  "review_decision", "relay_reply", "relay_dismiss", "relay_followup",
  "secondmate_nudge", "secondmate_restart", "secondmate_report",
  "remote_control", "handoff_move",
]);

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
  if (NEEDS_APPROVAL.has(target) && !validApproval((nested as ToolArgs)["approval"])) {
    return { payload: approvalError(), isError: true };
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

// --- Deny-list: code-writing, landing, daemon, and repo-mutation surfaces
// have no tool and are refused as unknown before any process starts. ---

export const DENY_LIST: ReadonlySet<string> = new Set([
  "promote_scout",
  "teardown_crew",
  "arm_pr_check",
  "merge_pr",
  "merge_local",
  "daemon_start",
  "daemon_stop",
  "daemon_restart",
  "watch_start",
  "watch_stop",
  "repo_edit",
  "repo_commit",
  "repo_push",
  "repo_merge",
]);

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

function sleepSyncMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- SUPPORTED: open reads + the single safe steer ---

async function toolFleetSnapshot(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
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
  return { payload: snapshot, isError: false };
}

async function toolBacklog(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const { payload: snapshot, isError } = await toolFleetSnapshot({}, ctx);
  if (isError) return { payload: snapshot, isError: true };
  const byState: Record<string, number> = {};
  const tasks = (snapshot["tasks"] as Array<Record<string, unknown>>) ?? [];
  for (const task of tasks) {
    const current = (task["current_state"] as Record<string, unknown> | undefined) ?? {};
    const state = (current["state"] as string) || "unknown";
    byState[state] = (byState[state] ?? 0) + 1;
  }
  return {
    payload: {
      generated: snapshot["generated"],
      backlog: (snapshot["backlog"] as unknown) ?? {},
      task_counts: { total: tasks.length, by_state: byState },
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
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
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
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
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
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
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
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
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
  if (typeof decisionText !== "string" || decisionText.length < 1 || decisionText.length > 2000) {
    return {
      payload: { error: "invalid decision_text", expect: "1..2000 chars" },
      isError: true,
    };
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const tmp = writeTempFile(decisionText);
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
        payload: { ...payload, origin_id: originId, decision_key: decisionKey },
        isError: false,
      };
    }
    return { payload, isError: true };
  } finally {
    removeTempFile(tmp);
  }
}

async function toolReviewDecision(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["id"];
  const verdict = args["verdict"];
  const comment = args["comment"] ?? "";
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
  if (comment !== "" && !validNote(comment)) {
    return {
      payload: { error: "invalid comment", expect: "single line, 1..500 chars" },
      isError: true,
    };
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = argv(path.join(ctx.binDir, "fm-review-decision.sh"), taskId as string, verdict as string);
  if (comment !== "") cmd.push(comment as string);
  const { payload, isError } = await ownedCall(cmd, "review decision refused or failed", ctx.run);
  if (!isError) {
    return { payload: { ...payload, id: taskId, verdict }, isError: false };
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
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
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
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
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
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
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
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
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
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
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
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
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
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
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
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
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

// --- Registry (schemas match the Python server's tools/list exactly) ---

export interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

function approvalSchema(extra: Record<string, unknown>): Record<string, unknown> {
  const properties = { ...extra };
  (properties as Record<string, unknown>)["approval"] = {
    type: "string",
    description: "Explicit authorization starting with 'I authorize'",
  };
  return {
    type: "object",
    properties,
    required: [...Object.keys(extra), "approval"],
    additionalProperties: false,
  };
}

function idApprovalSchema(idField = "id"): Record<string, unknown> {
  return approvalSchema({ [idField]: { type: "string", description: "Task id" } });
}

export const TOOLS: Record<string, ToolDef> = {
  fleet_snapshot: {
    description: "Read-only canonical fleet snapshot (backlog plus per-task state).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolFleetSnapshot,
  },
  backlog: {
    description:
      "Read-only backlog records plus per-state task counts, derived from the fleet snapshot.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
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
  review_decision: {
    description:
      "Authority write: record one captain approve, decline, or comment via fm-review-decision.sh.",
    inputSchema: approvalSchema({
      id: { type: "string" },
      verdict: { type: "string", enum: [...VERDICTS] },
      comment: { type: "string", description: "Optional single-line comment" },
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
};

export const TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(TOOLS));

void APPROVAL_PREFIX;
