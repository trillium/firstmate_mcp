/**
 * Installs/setup/hygiene handlers: linters, probes, startup, doc-audience,
 * home-seed, stow, test isolation/run lists (slice 4 of the tools.ts folder
 * split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. All ten were module-private there and
 * stay module-private here; tools.ts imports them for the TOOLS registry.
 * No re-export: the `./tools.js` public surface is unchanged.
 * (`argv` is imported from ../tools.js for deferred call-time use only;
 * ESM-circular-safe the same way slice 3's import is.)
 */
import fs from "node:fs";
import path from "node:path";
import { isRunResult, ownedCall, truncate } from "../runner.js";
import { argv, confineHomePath, homeRoot } from "../tools.js";
import {
  validIsolationPool,
  validProbe,
  validRelpath,
  validStartupMode,
  validTestIsolationMode,
  validTestRunListMode,
} from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolLintVersions(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Version probes only: the required ShellCheck/actionlint pins.
  const shellcheckRes = await ctx.run([path.join(ctx.binDir, "fm-lint.sh"), "--required-version"]);
  if (!isRunResult(shellcheckRes)) {
    return { payload: shellcheckRes as Record<string, unknown>, isError: true };
  }
  if (shellcheckRes.exitCode !== 0) {
    const [out] = truncate(shellcheckRes.stderr || shellcheckRes.stdout || "");
    return {
      payload: { error: "lint versions failed", exit: shellcheckRes.exitCode, output: out },
      isError: true,
    };
  }
  const actionlintRes = await ctx.run([
    path.join(ctx.binDir, "fm-lint-workflows.sh"),
    "--required-version",
  ]);
  let actionlint: unknown;
  if (!isRunResult(actionlintRes)) {
    // The owning script is retired upstream: degrade this probe instead of
    // failing the whole call, so the pins we do have still land.
    if ((actionlintRes as Record<string, unknown>)["error"] === "executable not found") {
      actionlint = {
        error: "unsupported probe",
        expect: "owning script fm-lint-workflows.sh retired upstream",
      };
    } else {
      return { payload: actionlintRes as Record<string, unknown>, isError: true };
    }
  } else if (actionlintRes.exitCode !== 0) {
    const [out] = truncate(actionlintRes.stderr || actionlintRes.stdout || "");
    return {
      payload: { error: "lint versions failed", exit: actionlintRes.exitCode, output: out },
      isError: true,
    };
  } else {
    actionlint = (actionlintRes.stdout ?? "").trim();
  }
  return {
    payload: {
      shellcheck: (shellcheckRes.stdout ?? "").trim(),
      actionlint,
    },
    isError: false,
  };
}

export async function toolToolUpdateCheck(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Report-only sweep: repairs nothing, installs nothing.
  return ownedCall(
    argv(path.join(ctx.binDir, "fm-tool-update-check.sh"), "check"),
    "tool update check failed",
    ctx.run,
  );
}

export async function toolVendorAuthProbe(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const probe = args["probe"];
  if (!validProbe(probe)) {
    return {
      payload: { error: "invalid probe", expect: "one of grok" },
      isError: true,
    };
  }
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-vendor-auth-probe.sh"), probe as string),
    "vendor auth probe failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, probe }, isError: false };
  return { payload, isError: true };
}

export async function toolStartupMemory(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const mode = args["mode"] ?? "read";
  if (!validStartupMode(mode)) {
    return {
      payload: { error: "invalid mode", expect: "one of read, report" },
      isError: true,
    };
  }
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-startup-memory-budget.sh"), mode as string),
    "startup memory read failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, mode }, isError: false };
  return { payload, isError: true };
}

// --- Installs gap area: setup/hygiene reads ---
//
// Every installer, seeder, bootstrapper, updater, and test-runner verb
// stays OUT of doorway ownership: approval-gated Tier-3 names with no
// handler (refused as unknown even with approval; see the deny-list
// comment on the registry below). The six reads here expose only the
// genuinely read-only, bounded modes: a deferred-network report, a docs
// inventory check, a home-seed registry validation, a stow-cascade
// enumeration, and the test topology lists. Runs, installs, seeds,
// bootstraps, and updates never dispatch.

export async function toolStartupNetworkReport(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // report only: prints the current state plus the last run's per-step
  // timings without changing anything. start/run/harvest/wait stay out:
  // start detaches a worker, run executes sweeps, harvest writes the
  // delivered acknowledgement, and wait blocks past the envelope.
  return ownedCall(
    argv(path.join(ctx.binDir, "fm-startup-network.sh"), "report"),
    "startup network report failed",
    ctx.run,
  );
}

export async function toolDocAudienceCheck(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Structure-only docs inventory + local-link validation against one
  // home-confined repo root (default: this home, which is the checkout
  // in the default deployment). The inventory path stays at the
  // upstream default (docs/documentation-audiences.json under root).
  const root = args["root"];
  let resolved: string;
  if (root === undefined) {
    resolved = homeRoot(ctx);
  } else {
    if (!validRelpath(root)) {
      return {
        payload: { error: "invalid root", expect: "home-relative path, no traversal" },
        isError: true,
      };
    }
    const confined = confineHomePath(ctx, root as string);
    if (confined === null) {
      return {
        payload: { error: "invalid root", expect: "home-relative path, no traversal" },
        isError: true,
      };
    }
    resolved = confined;
  }
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-doc-audience-check.sh"), "--root", resolved),
    "doc audience check failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, root: resolved }, isError: false };
  return { payload, isError: true };
}

export async function toolHomeSeedValidate(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // validate only: refuses secondmate-registry records that operational
  // consumers cannot parse. Provisioning (clones, markers, registry
  // writes, treehouse leases) stays out.
  return ownedCall(
    argv(path.join(ctx.binDir, "fm-home-seed.sh"), "validate"),
    "home seed validation failed",
    ctx.run,
  );
}

export async function toolStowCascade(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Read-only cascade enumeration: one key=value stanza per registered
  // secondmate home with its budget report and transport judgement.
  // Curation itself stays with the /stow skill; remote homes that do not
  // answer inside the subprocess envelope surface as a typed timeout.
  return ownedCall(
    argv(path.join(ctx.binDir, "fm-stow-cascade.sh")),
    "stow cascade failed",
    ctx.run,
  );
}
