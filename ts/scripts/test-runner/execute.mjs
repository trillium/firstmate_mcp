/**
 * Test execution + per-file tracking + timing report. (slice 27 of the test-runner.mjs folder split, task-8pqjb).
 *
 * Moved verbatim from scripts/test-runner.mjs. Imported by test-runner.mjs;
 * CLI surface (`--bun/--node/--all/--no-cache/--failed-only`) is unchanged.
 */
import { spawn } from "node:child_process";
import { TS_ROOT } from "./config.mjs";

export async function runTestFiles(files, runner) {
  return new Promise((resolve) => {
    let cmd;
    let cmdArgs;

    if (runner === "bun") {
      cmd = "bun";
      cmdArgs = ["test", "--timeout", "120000", ...files];
    } else {
      cmd = "node";
      cmdArgs = ["--test", ...files];
    }

    const proc = spawn(cmd, cmdArgs, {
      cwd: TS_ROOT,
      stdio: "inherit",
      env: process.env,
    });

    proc.on("close", (code) => {
      resolve(code === 0);
    });
  });
}

export async function runPerFileTracking(files, runner) {
  const failed = [];
  for (const file of files) {
    const passed = await runTestFiles([file], runner);
    if (!passed) {
      failed.push(file);
    }
  }
  return failed;
}

export function printTimingReport(timing) {
  console.log("\n" + "=".repeat(62));
  console.log("   AST Unit-Test Proof Cache: Timing Breakdown");
  console.log("=".repeat(62));
  console.log(` Phase                            Duration    Percentage`);
  console.log("-".repeat(62));
  console.log(` Proof Validation (ast-grep)     ${timing.valMs.toFixed(1).padStart(8)} ms     ${((timing.valMs / timing.totalMs) * 100).toFixed(1).padStart(5)}%`);
  console.log(` Test Execution (${timing.runner.padEnd(4)})          ${timing.execMs.toFixed(1).padStart(8)} ms     ${((timing.execMs / timing.totalMs) * 100).toFixed(1).padStart(5)}%`);
  console.log("-".repeat(62));
  console.log(` Total Wall-Clock                ${timing.totalMs.toFixed(1).padStart(8)} ms     100.0%`);
  console.log("-".repeat(62));
  console.log(` Files Skipped (Proof Cached):   ${timing.skippedCount} / ${timing.totalCount} (${timing.contractsValid} unit proofs verified)`);
  console.log(` Files Executed:                 ${timing.executedCount} / ${timing.totalCount}`);
  console.log("=".repeat(62) + "\n");
}
