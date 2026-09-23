/**
 * Cached whole-home projections: fleet view, review diff, bearings. (slice 11a of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. Helpers are shared with no one else; handlers are private as before. tools.ts imports them for the
 * TOOLS registry.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ARTIFACT_DIRNAME,
  ARTIFACT_TTL_S,
  BEARINGS_SCHEMA,
  MAX_OUTPUT_BYTES,
} from "../constants.js";
import { byteLength, isRunResult, ownedCall, truncate } from "../runner.js";
import { argv } from "../tools.js";
import { validId, validRelpath } from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

/**
 * Cached whole-home reads.
 *
 * `fleet_view` and `bearings_snapshot` are thin projections of
 * `fm-fleet-snapshot.sh` — they re-run that 110s walk inside their own scripts,
 * which the 30s envelope kills (measured: 35s timeouts while four sibling reads
 * answer in 20-180ms). `fm-fleet-snapshot.sh` has no cache-reuse flag (its env
 * knobs cap scope, not caching), so the doorway caches the projection itself:
 * one successful run — direct or via receipt_submit, where the 180s budget fits —
 * warms an artifact that later reads serve instantly with an explicit age.
 *
 * Deliberately not a TS reimplementation of either projection: the scripts own
 * those semantics, and a second implementation would drift.
 */
function artifactFile(ctx: ToolContext, tool: string, args: Record<string, unknown>): string {
  const key = createHash("sha256")
    .update(JSON.stringify(args, Object.keys(args).sort()))
    .digest("hex")
    .slice(0, 12);
  return path.join(ctx.stateDir, ARTIFACT_DIRNAME, `${tool}-${key}.json`);
}

function readArtifact(
  ctx: ToolContext,
  tool: string,
  args: Record<string, unknown>,
): { stdout: string; ageS: number; stale: boolean } | null {
  try {
    const record = JSON.parse(fs.readFileSync(artifactFile(ctx, tool, args), "utf8")) as {
      created_epoch?: number;
      ttl_s?: number;
      stdout?: string;
    };
    if (typeof record.stdout !== "string") return null;
    const age = Date.now() / 1000 - (typeof record.created_epoch === "number" ? record.created_epoch : 0);
    const ttl = typeof record.ttl_s === "number" ? record.ttl_s : ARTIFACT_TTL_S;
    return { stdout: record.stdout, ageS: age, stale: !(age <= ttl) };
  } catch {
    return null;
  }
}

function writeArtifact(
  ctx: ToolContext,
  tool: string,
  args: Record<string, unknown>,
  stdout: string,
): void {
  try {
    const file = artifactFile(ctx, tool, args);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        tool,
        created_epoch: Date.now() / 1000,
        ttl_s: ARTIFACT_TTL_S,
        stdout,
      }),
      "utf8",
    );
    fs.renameSync(tmp, file);
  } catch {
    /* caching is best effort; the read still answered */
  }
}

/** Tell a caller how to warm a read the envelope cannot finish, rather than
 *  making them discover it as a bare timeout. */
function warmHint(tool: string): Record<string, unknown> {
  return {
    long_running: true,
    hint: `${tool} runs the whole-fleet walk and can exceed the 30s envelope; submit ${tool} through receipt_submit (180s budget) once — a successful run warms the cache and later reads are instant`,
  };
}

export async function toolFleetView(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const cached = readArtifact(ctx, "fleet_view", args);
  if (cached !== null) {
    return {
      payload: {
        ok: true,
        stdout: cached.stdout,
        stdout_truncated: false,
        stderr: "",
        stderr_truncated: false,
        from_cache: true,
        stale: cached.stale,
        snapshot_age_s: Math.round(cached.ageS),
      },
      isError: false,
    };
  }
  const res = await ctx.run([path.join(ctx.binDir, "fm-fleet-view.sh")]);
  if (!isRunResult(res)) return { payload: { ...(res as Record<string, unknown>), ...warmHint("fleet_view") }, isError: true };
  if (res.exitCode !== 0) {
    return {
      payload: { error: "fleet view failed", exit: res.exitCode, stderr: truncate(res.stderr ?? "")[0] },
      isError: true,
    };
  }
  writeArtifact(ctx, "fleet_view", args, res.stdout ?? "");
  return {
    payload: {
      ok: true,
      stdout: res.stdout ?? "",
      stdout_truncated: false,
      stderr: truncate(res.stderr ?? "")[0],
      stderr_truncated: false,
      from_cache: false,
    },
    isError: false,
  };
}

export async function toolReviewDiff(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
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

export async function toolBearingsSnapshot(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const cached = readArtifact(ctx, "bearings_snapshot", args);
  if (cached !== null) {
    let projection: Record<string, unknown>;
    try {
      projection = JSON.parse(cached.stdout) as Record<string, unknown>;
    } catch {
      // A corrupt cache must not shadow the real read.
      projection = {} as Record<string, unknown>;
    }
    if (projection["schema"] === BEARINGS_SCHEMA) {
      return {
        payload: {
          ...projection,
          from_cache: true,
          stale: cached.stale,
          snapshot_age_s: Math.round(cached.ageS),
        },
        isError: false,
      };
    }
  }
  const res = await ctx.run([path.join(ctx.binDir, "fm-bearings-snapshot.sh"), "--json"]);
  if (!isRunResult(res)) return { payload: { ...(res as Record<string, unknown>), ...warmHint("bearings_snapshot") }, isError: true };
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
  // A validated projection is worth caching: the next read answers instantly with
  // an explicit age instead of re-walking the fleet into the envelope.
  writeArtifact(ctx, "bearings_snapshot", args, res.stdout);
  return { payload: { ...projection, from_cache: false }, isError: false };
}

