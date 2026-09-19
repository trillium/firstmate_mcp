#!/usr/bin/env node
/**
 * Test runner with selective failure rerun support during development.
 *
 * Behavior:
 * - In CI environments (CI=true or GITHUB_ACTIONS=true) or when `--all` is passed:
 *   Always runs the full test suite.
 * - During local development:
 *   If there are recorded failures from the previous test run in `.test-failures.json`,
 *   it runs ONLY the failed test files first. If they pass, it runs the full test suite
 *   to confirm global green status and clears the failure cache.
 *
 * Supports both Node.js (`node --test`) and Bun (`bun test`).
 *
 * Usage:
 *   node scripts/test-runner.mjs [--bun] [--all] [--failed-only]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TS_ROOT = path.resolve(HERE, "..");
const CACHE_FILE = path.join(TS_ROOT, ".test-failures.json");
const TEST_DIR = path.join(TS_ROOT, "testbuild", "tests");

const isCI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS || process.env.CONTINUOUS_INTEGRATION);
const args = process.argv.slice(2);
const useBun = args.includes("--bun") || (process.versions.bun !== undefined && !args.includes("--node"));
const forceAll = args.includes("--all") || isCI;
const failedOnly = args.includes("--failed-only");

function getAllTestFiles() {
  if (!fs.existsSync(TEST_DIR)) return [];
  return fs
    .readdirSync(TEST_DIR)
    .filter((f) => f.endsWith(".test.js"))
    .map((f) => path.join("testbuild", "tests", f))
    .sort();
}

function loadFailedFiles() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      if (Array.isArray(data.failedFiles)) {
        return data.failedFiles.filter((f) => fs.existsSync(path.join(TS_ROOT, f)));
      }
    }
  } catch {
    /* ignore read error */
  }
  return [];
}

function saveFailedFiles(failedFiles) {
  try {
    if (failedFiles.length === 0) {
      if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
    } else {
      fs.writeFileSync(
        CACHE_FILE,
        JSON.stringify({ failedFiles, timestamp: new Date().toISOString() }, null, 2),
        "utf8",
      );
    }
  } catch {
    /* ignore write error */
  }
}

async function runTestFiles(files, runner) {
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

async function runPerFileTracking(files, runner) {
  const failed = [];
  for (const file of files) {
    const passed = await runTestFiles([file], runner);
    if (!passed) {
      failed.push(file);
    }
  }
  return failed;
}

async function main() {
  const runner = useBun ? "bun" : "node";
  const allFiles = getAllTestFiles();

  if (allFiles.length === 0) {
    console.error("No test files found in testbuild/tests/*.test.js");
    process.exit(1);
  }

  const previousFailures = loadFailedFiles();

  if (!forceAll && previousFailures.length > 0) {
    console.log(
      `\n[test-runner] Found ${previousFailures.length} previously failed test file(s). Rerunning failed tests first (${runner})...`,
    );
    console.log(`[test-runner] Files: ${previousFailures.join(", ")}\n`);

    const passedSubset = await runTestFiles(previousFailures, runner);

    if (!passedSubset) {
      console.log(`\n[test-runner] ❌ Failed tests still failing. Fix them and re-run.`);
      process.exit(1);
    }

    console.log(`\n[test-runner] ✅ Previously failed tests now PASS!`);

    if (failedOnly) {
      saveFailedFiles([]);
      process.exit(0);
    }

    console.log(`[test-runner] Running full test suite to verify overall green status...\n`);
  } else if (isCI) {
    console.log(`[test-runner] CI environment detected. Running full test suite (${runner})...\n`);
  } else {
    console.log(`[test-runner] Running test suite (${runner})...\n`);
  }

  // Run full test suite
  const passedFull = await runTestFiles(allFiles, runner);

  if (passedFull) {
    saveFailedFiles([]);
    console.log(`\n[test-runner] ✅ All tests passed!`);
    process.exit(0);
  } else {
    // If full run failed in dev, identify which files failed to cache them
    if (!isCI) {
      console.log(`\n[test-runner] Recording failing files for next dev run...`);
      const failed = await runPerFileTracking(allFiles, runner);
      saveFailedFiles(failed);
      console.log(`[test-runner] Recorded ${failed.length} failing file(s): ${failed.join(", ")}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
