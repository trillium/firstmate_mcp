#!/usr/bin/env node
/**
 * Test runner with AST-based unit-test proof caching and selective failure rerun support.
 *
 * Entry point only (slice 27, task-8pqjb): implementation lives in
 * ./test-runner/{config,failures,proofs,execute}.mjs. CLI surface unchanged.
 */
import {
  failedOnly,
  forceAll,
  isCI,
  noCache,
  startTime,
  useBun,
} from "./test-runner/config.mjs";
import {
  getAllTestFiles,
  loadFailedFiles,
  saveFailedFiles,
} from "./test-runner/failures.mjs";
import {
  evaluateProofs,
  updatePassingProofs,
} from "./test-runner/proofs.mjs";
import {
  runPerFileTracking,
  runTestFiles,
  printTimingReport,
} from "./test-runner/execute.mjs";

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
