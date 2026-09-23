/**
 * Decision hold (open). (slice 7a of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. All handlers were module-private there
 * and stay module-private here; tools.ts imports them for the TOOLS registry.
 * No re-export: the `./tools.js` public surface is unchanged.
 */
import path from "node:path";
import { requireAuth } from "../grants.js";
import { ownedCall } from "../runner.js";
import { argv } from "../tools.js";
import { validId, validNote } from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolDecisionHold(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
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
