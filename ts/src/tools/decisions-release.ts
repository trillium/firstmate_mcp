/**
 * Decision resolve + release (close). (slice 7b of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. All handlers were module-private there
 * and stay module-private here; tools.ts imports them for the TOOLS registry.
 * No re-export: the `./tools.js` public surface is unchanged.
 */
import path from "node:path";
import { requireAuth } from "../grants.js";
import { ownedCall } from "../runner.js";
import { argv } from "../tools.js";
import { isReleaseAuthorized } from "../grants.js";
import { removeTempFile, sha256Text, writeTempFile } from "./tempfiles.js";
import { validId } from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolDecisionResolve(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
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

export async function toolDecisionRelease(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
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
