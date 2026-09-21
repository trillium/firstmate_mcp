#!/usr/bin/env node
/**
 * Test runner with AST-based unit-test proof caching and selective failure rerun support.
 *
 * Capabilities:
 * 1. AST Proof Caching: Skips explicitly bounded unit tests whose AST fingerprints
 *    match committed PASS proofs, without re-executing.
 * 2. Selective Failure Rerun: During dev iterations, reruns previously failing files first.
 * 3. Timing Split: Measures and reports TypeScript compilation, AST proof validation,
 *    and test execution wall-clock times.
 * 4. Multi-Runtime: Supports both Node.js (`node --test`) and Bun (`bun test`).
 *
 * Usage:
 *   node scripts/test-runner.mjs [--bun] [--node] [--all] [--no-cache] [--failed-only]
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TS_ROOT = path.resolve(HERE, "..");
const CACHE_FILE = path.join(TS_ROOT, ".test-failures.json");
const TEST_DIR = path.join(TS_ROOT, "testbuild", "tests");
const CONTRACTS_FILE = path.join(TS_ROOT, "proof-cache", "contracts.json");
const MANIFEST_FILE = path.join(TS_ROOT, "proof-cache", "manifest.json");

const isCI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS || process.env.CONTINUOUS_INTEGRATION);
const args = process.argv.slice(2);
const useBun = args.includes("--bun") || (process.versions.bun !== undefined && !args.includes("--node"));
const forceAll = args.includes("--all");
const noCache = args.includes("--no-cache") || args.includes("--no-proof-cache");
const failedOnly = args.includes("--failed-only");

const startTime = performance.now();

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

/**
 * Runs AST proof cache evaluation.
 * Spawns node if currently executing under bun (due to Bun N-API tree-sitter compatibility).
 */
async function evaluateProofs(testFiles) {
  const t0 = performance.now();

  try {
    if (process.versions.bun !== undefined) {
      // In Bun: spawn Node for AST evaluation
      const script = `
        import { evaluateProofCache } from "./dist/proof/engine.js";
        const files = ${JSON.stringify(testFiles)};
        const summary = await evaluateProofCache(files, "proof-cache/contracts.json", "proof-cache/manifest.json", ${JSON.stringify(TS_ROOT)});
        console.log(JSON.stringify(summary));
      `;
      const res = spawnSync("node", ["--input-type=module", "-e", script], {
        cwd: TS_ROOT,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      if (res.status === 0 && res.stdout) {
        const summary = JSON.parse(res.stdout);
        const t1 = performance.now();
        return { summary, durationMs: t1 - t0 };
      }
    } else {
      // In Node: direct import
      const { evaluateProofCache } = await import("../dist/proof/engine.js");
      const summary = await evaluateProofCache(
        testFiles,
        "proof-cache/contracts.json",
        "proof-cache/manifest.json",
        TS_ROOT,
      );
      const t1 = performance.now();
      return { summary, durationMs: t1 - t0 };
    }
  } catch (err) {
    console.warn(`[test-runner] Warning: AST proof evaluation failed (${err.message}). Falling back to full execution.`);
  }

  const t1 = performance.now();
  return { summary: null, durationMs: t1 - t0 };
}

/**
 * Updates passing proofs in the committed manifest.
 */
async function updatePassingProofs(passedFiles) {
  try {
    if (process.versions.bun !== undefined) {
      const script = `
        import { recordPassingProofs } from "./dist/proof/engine.js";
        const files = ${JSON.stringify(passedFiles)};
        const res = await recordPassingProofs(files, "proof-cache/contracts.json", "proof-cache/manifest.json", ${JSON.stringify(TS_ROOT)});
        console.log(JSON.stringify(res));
      `;
      spawnSync("node", ["--input-type=module", "-e", script], {
        cwd: TS_ROOT,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      });
    } else {
      const { recordPassingProofs } = await import("../dist/proof/engine.js");
      await recordPassingProofs(
        passedFiles,
        "proof-cache/contracts.json",
        "proof-cache/manifest.json",
        TS_ROOT,
      );
    }
  } catch (err) {
    console.warn(`[test-runner] Warning: Failed to record passing proofs: ${err.message}`);
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

function printTimingReport(timing) {
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

async function main() {
  const runner = useBun ? "bun" : "node";
  const allFiles = getAllTestFiles();

  if (allFiles.length === 0) {
    console.error("No test files found in testbuild/tests/*.test.js");
    process.exit(1);
  }

  const previousFailures = loadFailedFiles();

  // 1. Dev failure rerun fast-path
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

    console.log(`[test-runner] Running remaining test suite...\n`);
  }

  // 2. AST Proof Cache Evaluation
  let filesToExecute = allFiles;
  let skippedFiles = [];
  let valMs = 0;
  let contractsValid = 0;

  const enableProofCache = !forceAll && !noCache;

  if (enableProofCache) {
    const proofRes = await evaluateProofs(allFiles);
    valMs = proofRes.durationMs;

    if (proofRes.summary) {
      const summary = proofRes.summary;
      contractsValid = summary.validContracts;

      skippedFiles = summary.fileDecisions
        .filter((f) => f.canSkip)
        .map((f) => f.testBuildFile);

      filesToExecute = summary.fileDecisions
        .filter((f) => !f.canSkip)
        .map((f) => f.testBuildFile);

      if (skippedFiles.length > 0) {
        console.log(`[test-runner] ⚡ AST Proof Cache: ${summary.validContracts}/${summary.totalContracts} unit proofs verified from manifest.`);
        console.log(`[test-runner] ⚡ Skipping ${skippedFiles.length} cached test file(s):`);
        for (const sf of skippedFiles) {
          const dec = summary.fileDecisions.find((f) => f.testBuildFile === sf);
          console.log(`     ✔ ${sf} (${dec?.validContracts}/${dec?.totalContracts} proofs valid)`);
        }
        console.log(`[test-runner] 🏃 Executing ${filesToExecute.length} test file(s) (ineligible/stale)...\n`);
      } else {
        console.log(`[test-runner] AST Proof Cache: all files need execution (${summary.totalContracts} contracts evaluated in ${valMs.toFixed(1)}ms).\n`);
      }
    }
  } else if (forceAll) {
    console.log(`[test-runner] --all specified. Running full uncached test suite (${runner})...\n`);
  } else {
    console.log(`[test-runner] Running test suite without proof caching (${runner})...\n`);
  }

  // 3. Execute Tests
  const t0_exec = performance.now();
  let passedFull = true;

  if (filesToExecute.length > 0) {
    passedFull = await runTestFiles(filesToExecute, runner);
  } else {
    console.log(`[test-runner] All tests were skipped via valid AST proof cache!`);
  }
  const t1_exec = performance.now();
  const execMs = t1_exec - t0_exec;

  const totalMs = performance.now() - startTime;

  if (passedFull) {
    saveFailedFiles([]);

    // Repin/update passing proofs if files were executed
    if (filesToExecute.length > 0) {
      await updatePassingProofs(filesToExecute);
    }

    console.log(`\n[test-runner] ✅ All test suites passed!`);

    printTimingReport({
      runner,
      valMs,
      execMs,
      totalMs,
      skippedCount: skippedFiles.length,
      executedCount: filesToExecute.length,
      totalCount: allFiles.length,
      contractsValid,
    });

    process.exit(0);
  } else {
    if (!isCI) {
      console.log(`\n[test-runner] Recording failing files for next dev run...`);
      const failed = await runPerFileTracking(filesToExecute, runner);
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
