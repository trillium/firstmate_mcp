/**
 * Fleet activity ledger read + Devin worker-config write (gap ports).
 *
 * fleet_ledger is a Tier-1 O(1) tail read over state/fleet-ledger.jsonl
 * ({v, ts, event, task, ...} records, opt-in upstream feature). Absent file
 * returns typed degraded state, never an error.
 *
 * devin_config is a Tier-3 authority write dispatching the owning upstream
 * script, which writes a scoped per-worker Devin config (mode 600) forcing
 * read_config_from.claude=false + attribution=false. Divergence: upstream
 * takes an arbitrary <state-dir>; the doorway pins stateDir to the served
 * home, so the tool can only write inside the fleet it serves. Approval is
 * enforced centrally by tier; the handler dispatches only.
 */
import fs from "node:fs";
import path from "node:path";
import { ownedCall } from "../runner.js";
import { argv } from "../tools.js";
import { validId, validNonnegInt } from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

const LEDGER_FILENAME = "fleet-ledger.jsonl";
const LEDGER_LIMIT_MAX = 100;

function validGen(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 64 &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

export async function toolFleetLedger(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const rawLimit = args["limit"] ?? 20;
  const limit = validNonnegInt(rawLimit);
  if (limit === null || limit < 1 || limit > LEDGER_LIMIT_MAX) {
    return {
      payload: { error: "invalid limit", expect: "integer 1..100" },
      isError: true,
    };
  }
  const file = path.join(ctx.stateDir, LEDGER_FILENAME);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { payload: { present: false, records: [] }, isError: false };
  }
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const tail = lines.slice(-limit);
  const records: unknown[] = [];
  let dropped = 0;
  for (const line of tail) {
    try {
      const rec = JSON.parse(line) as unknown;
      if (rec && typeof rec === "object") records.push(rec);
      else dropped += 1;
    } catch {
      dropped += 1;
    }
  }
  return {
    payload: {
      present: true,
      total_lines: lines.length,
      returned: records.length,
      dropped_malformed: dropped,
      records,
    },
    isError: false,
  };
}

export async function toolDevinConfig(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  const gen = args["busy_gen"];
  if (!validId(taskId)) {
    return {
      payload: { error: "invalid task_id", expect: "short slug, no slashes" },
      isError: true,
    };
  }
  if (!validGen(gen)) {
    return {
      payload: { error: "invalid busy_gen", expect: "1..64 chars, [A-Za-z0-9._-]" },
      isError: true,
    };
  }
  const cmd = [
    path.join(ctx.binDir, "fm-devin-config.sh"),
    ctx.stateDir,
    taskId as string,
    gen as string,
  ];
  const { payload, isError } = await ownedCall(cmd, "devin config failed", ctx.run);
  if (isError) return { payload, isError: true };
  return {
    payload: { ...payload, task_id: taskId, state_dir: ctx.stateDir },
    isError: false,
  };
}
