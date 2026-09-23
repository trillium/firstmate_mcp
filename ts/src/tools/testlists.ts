/**
 * Test topology list handlers: isolation candidates/exclusions and run-list
 * families/lanes (slice 4b of the tools.ts folder split, task-8pqjb).
 * Split from installs.ts to keep both files under the 250-line limit.
 * Module-private as before; tools.ts imports them for the TOOLS registry.
 */
import fs from "node:fs";
import path from "node:path";
import { isRunResult, ownedCall } from "../runner.js";
import { argv } from "../tools.js";
import {
  validTestIsolationMode,
  validIsolationPool,
  validTestRunListMode,
} from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";
export async function toolTestIsolationList(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
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
  const script = path.join(ctx.binDir, "fm-test-isolation-proof.sh");
  // `--pool` is upstream's newer selector; the served fork line's older script
  // rejects it outright ("unknown option: --pool", exit 2), which made this read
  // fail on the live home while working against the upstream pin. Probe the
  // script's own source for the flag rather than assuming the interface, and say
  // in the payload whether the selection could be honoured — the same fork-shape
  // class as the decision core, and a concrete case of the unvalidated flag
  // surfaces tracked in project-2od.14.
  let poolHonored = false;
  try {
    poolHonored = fs.readFileSync(script, "utf8").includes("--pool");
  } catch {
    /* unreadable script: fall back to the modern argv and let the run report */
    poolHonored = true;
  }
  const cmd = poolHonored ? argv(script, flag, "--pool", pool as string) : argv(script, flag);
  const { payload, isError } = await ownedCall(cmd, "test isolation list failed", ctx.run);
  if (!isError) {
    return {
      payload: {
        ...payload,
        mode,
        pool,
        pool_honored: poolHonored,
        ...(poolHonored
          ? {}
          : { note: "this home's fm-test-isolation-proof.sh predates --pool; the list is the whole proven set" }),
      },
      isError: false,
    };
  }
  return { payload, isError: true };
}

export async function toolTestRunList(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
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
