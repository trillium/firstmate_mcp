import { spawn } from "node:child_process";

/**
 * Test execution. (slice 28 of the conformance-runner.mjs folder split, task-8pqjb).
 *
 * Moved verbatim from scripts/conformance-runner.mjs. Imported by
 * conformance-runner.mjs; CLI surface (`--runtime/--shard/--no-cache`) unchanged.
 */
import { spawnSync } from "node:child_process";
import { TS_ROOT } from "./config.mjs";

export async function runTests(targetRuntime, testFiles) {
  return new Promise((resolve) => {
    let cmd;
    let cmdArgs;

    if (targetRuntime === "bun") {
      cmd = "bun";
      cmdArgs = ["test", "--timeout", "120000", ...testFiles];
    } else {
      cmd = "node";
      cmdArgs = ["--test", ...testFiles];
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
