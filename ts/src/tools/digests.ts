/**
 * Bearings/inbox/home-summary reads. (slice 9a of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. All handlers were module-private there
 * and stay module-private here; tools.ts imports them for the TOOLS registry.
 * No re-export: the `./tools.js` public surface is unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import { HOME_SUMMARY_SCHEMA, MAX_OUTPUT_BYTES } from "../constants.js";
import { byteLength, isRunResult, ownedCall, truncate } from "../runner.js";
import { argv } from "../tools.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolBearingsBoardPath(
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

export async function toolInboxStatus(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  return ownedCall(
    argv(path.join(ctx.binDir, "fm-inbox.sh"), "status"),
    "inbox status failed",
    ctx.run,
  );
}

export async function toolInboxList(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  return ownedCall(
    argv(path.join(ctx.binDir, "fm-inbox.sh"), "list"),
    "inbox list failed",
    ctx.run,
  );
}

export async function toolHomeSummary(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
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
export async function publishHomeSummary(ctx: ToolContext, bestEffort: boolean): Promise<ToolResult> {
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
