/**
 * Review-decision (captain verdict routing). (slice 7c of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. All handlers were module-private there
 * and stay module-private here; tools.ts imports them for the TOOLS registry.
 * No re-export: the `./tools.js` public surface is unchanged.
 */
import path from "node:path";
import { VERDICTS } from "../constants.js";
import { requireAuth } from "../grants.js";
import { ownedCall } from "../runner.js";
import { argv } from "../tools.js";
import { isReleaseAuthorized } from "../grants.js";
import { removeTempFile, sha256Text, writeTempFile } from "./tempfiles.js";
import { validId, validNote } from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolReviewDecision(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
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
