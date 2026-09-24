/**
 * Fork advisory reads (curator-authorized ports).
 *
 * Tier-1 reads dispatching fork-only advisory scripts. Read-only reports,
 * never gates: exit status is always 0 from the owning scripts.
 */
import path from "node:path";
import { ownedCall } from "../runner.js";
import { argv } from "../tools.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolForkOriginCheck(
  _args: ToolArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const cmd = [path.join(ctx.binDir, "fm-fork-origin-check.sh")];
  const { payload, isError } = await ownedCall(cmd, "fork origin check failed", ctx.run);
  if (isError) return { payload, isError: true };
  return { payload: { ...payload }, isError: false };
}
