/**
 * Suite-run execution counterpart. (slice 15b of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. Exported in tools.ts (tests import it), re-exported via tools.ts so the surface is unchanged.
 */
import path from "node:path";
import { ownedCall } from "../runner.js";
import { argv } from "../tools.js";
import {
  validGitRef,
  validTestFamily,
  validTestLane,
  validTestRunMode,
  validTestScriptPath,
} from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolTestRun(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const mode = args["mode"];
  if (!validTestRunMode(mode)) {
    return {
      payload: {
        error: "invalid mode",
        expect: "one of all, family, changed, lane, proven-isolated, scripts",
      },
      isError: true,
    };
  }
  const listOnly = args["list"] === true;
  const checkCoverage = args["check_coverage"] === true;
  if (args["list"] !== undefined && typeof args["list"] !== "boolean") {
    return { payload: { error: "invalid list", expect: "boolean" }, isError: true };
  }
  if (args["check_coverage"] !== undefined && typeof args["check_coverage"] !== "boolean") {
    return { payload: { error: "invalid check_coverage", expect: "boolean" }, isError: true };
  }

  const cmd = argv(path.join(ctx.binDir, "fm-test-run.sh"));
  const selection: string[] = [];
  switch (mode) {
    case "all":
      selection.push("--all");
      break;
    case "proven-isolated":
      selection.push("--proven-isolated");
      break;
    case "family": {
      const family = args["family"];
      if (!validTestFamily(family)) {
        return { payload: { error: "invalid family", expect: "family name from --list-families" }, isError: true };
      }
      selection.push("--family", family);
      break;
    }
    case "changed": {
      selection.push("--changed");
      const base = args["base"];
      if (base !== undefined) {
        if (!validGitRef(base)) {
          return { payload: { error: "invalid base", expect: "git ref, no revision range" }, isError: true };
        }
        selection.push("--base", base);
      }
      break;
    }
    case "lane": {
      const lane = args["lane"];
      if (!validTestLane(lane)) {
        return {
          payload: { error: "invalid lane", expect: "portable-parallel-1|2, portable-serial, portable-serial-<k>of<n>" },
          isError: true,
        };
      }
      selection.push("--lane", lane);
      break;
    }
    case "scripts": {
      const scripts = args["scripts"];
      if (!Array.isArray(scripts) || scripts.length === 0 || !scripts.every(validTestScriptPath)) {
        return {
          payload: { error: "invalid scripts", expect: "non-empty list of tests/<name>.test.sh paths" },
          isError: true,
        };
      }
      selection.push(...(scripts as string[]));
      break;
    }
  }
  // --list is the inspection form: it composes with all/family/lane and never
  // executes the suite. --check-coverage is standalone.
  if (listOnly) cmd.push("--list");
  cmd.push(...selection);
  if (checkCoverage) cmd.push("--check-coverage");

  const { payload, isError } = await ownedCall(cmd, "test run failed", ctx.run);
  if (isError) return { payload, isError };
  const executes = !listOnly && !checkCoverage;
  return {
    payload: {
      ...payload,
      mode,
      selection: selection.join(" "),
      list_only: listOnly,
      // Suite runs take minutes and can exceed the 30s envelope; say so up front
      // instead of letting the caller discover it as a bare timeout.
      ...(executes
        ? { long_running: true, hint: "suite runs can exceed the 30s envelope; submit test_run through receipt_submit (180s budget)" }
        : {}),
    },
    isError: false,
  };
}

/**
 * Locate schema/matrix.md from wherever this module happens to be built.
 *
 * CHECKOUT_ROOT assumes <repo>/ts/<src|dist>/constants.js, which holds for the
 * served dist build but not for the test build (ts/testbuild/src/), where it
 * resolves one level short. Probing candidates keeps doctor honest in every
 * layout instead of silently reporting "contract resolution unknown".
 */
