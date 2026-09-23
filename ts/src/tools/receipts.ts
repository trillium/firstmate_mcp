/**
 * Detached receipt submit/status + receipt store helpers. (slice 15a of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. Helpers are receipt-local; handlers are private as before; tools.ts imports both for the registry.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  RECEIPT_DIRNAME,
  RECEIPT_TIMEOUT_S,
  RECEIPT_TTL_S,
} from "../constants.js";
import { requiresApproval } from "../auth.js";
import { requireAuth } from "../grants.js";
import { TOOLS, argv } from "../tools.js";
import { missingContractScript } from "./doctor.js";
import { validId } from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

function receiptDir(ctx: ToolContext): string {
  return path.join(ctx.stateDir, RECEIPT_DIRNAME);
}

export function utcNow(): string {
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

export async function toolReceiptSubmit(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
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
  // A detached call must not be opened for a contract this home cannot run: the
  // refusal would otherwise arrive asynchronously as a raw ENOENT.
  const missingScript = missingContractScript(target, ctx.binDir);
  if (missingScript !== null) {
    return {
      payload: {
        error: "unavailable on this home",
        tool: target,
        script: missingScript,
        expect: `bin/${missingScript} in the served home`,
        hint: "declared contract with no implementation on this served line; doctor lists every one",
      },
      isError: true,
    };
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

export async function toolReceiptStatus(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
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
