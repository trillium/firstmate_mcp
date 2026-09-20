#!/usr/bin/env node
/**
 * CLI Tool for AST-based Unit-Test Proof Caching.
 *
 * Commands:
 *   check              Evaluate all proof contracts against source code and manifest
 *   update             Re-verify passing tests and update committed proof manifest
 *   explain [file]     Explain AST extraction, normalization, and fingerprints for a file
 *   bench              Benchmark wall-clock timing: compile vs validate vs execute
 *
 * Usage:
 *   node scripts/proof-cache.mjs check
 *   node scripts/proof-cache.mjs update
 *   node scripts/proof-cache.mjs explain tests/validators.test.ts
 *   node scripts/proof-cache.mjs bench
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TS_ROOT = path.resolve(HERE, "..");
const TEST_DIR = path.join(TS_ROOT, "testbuild", "tests");

async function getEngine() {
  return await import("../dist/proof/engine.js");
}

async function getFingerprint() {
  return await import("../dist/proof/fingerprint.js");
}

function getAllTestFiles() {
  if (!fs.existsSync(TEST_DIR)) return [];
  return fs
    .readdirSync(TEST_DIR)
    .filter((f) => f.endsWith(".test.js"))
    .map((f) => path.join("testbuild", "tests", f))
    .sort();
}

async function cmdCheck() {
  const { evaluateProofCache } = await getEngine();
  const allFiles = getAllTestFiles();

  console.log("\n=======================================================");
  console.log("   AST Unit-Test Proof Cache: Verification Report");
  console.log("=======================================================\n");

  const summary = await evaluateProofCache(allFiles, "proof-cache/contracts.json", "proof-cache/manifest.json", TS_ROOT);

  console.log(`Evaluated ${summary.totalContracts} contract(s) across ${summary.totalTestFiles} test file(s):\n`);

  console.log("CONTRACTS STATUS:");
  for (const fileDec of summary.fileDecisions) {
    if (!fileDec.eligible) {
      console.log(`  ⚪ ${fileDec.testFile.padEnd(35)} [INELIGIBLE] (multi-unit/integration)`);
      continue;
    }

    const icon = fileDec.canSkip ? "✅" : "⚠️ ";
    const statusLabel = fileDec.canSkip ? "CACHED_PASS" : "STALE/DIRTY";
    console.log(`  ${icon} ${fileDec.testFile.padEnd(35)} [${statusLabel}] (${fileDec.validContracts}/${fileDec.totalContracts} proofs valid)`);

    for (const c of fileDec.contracts) {
      const cIcon = c.status === "VALID_CACHED" ? "   ✔" : "   ✖";
      console.log(`     ${cIcon} ${c.contractId.padEnd(32)} ${c.status.padEnd(20)} ${c.reason}`);
    }
  }

  console.log("\nEXECUTION PLAN:");
  console.log(`  • Skippable files (cached proofs): ${summary.skippedTestFiles}`);
  console.log(`  • Required execution files:       ${summary.executedTestFiles}`);
  console.log(`  • Cache hit ratio:                 ${summary.totalContracts > 0 ? ((summary.validContracts / summary.totalContracts) * 100).toFixed(1) : 0}%\n`);

  if (summary.skippedTestFiles > 0) {
    console.log("Files to skip:");
    for (const f of summary.fileDecisions.filter((f) => f.canSkip)) {
      console.log(`  ⚡ ${f.testBuildFile}`);
    }
  }
}

async function cmdExplain(targetArg) {
  const { loadContracts, loadManifest } = await getEngine();
  const { fingerprintTargetUnit, fingerprintTestUnit, parseTypeScript } = await getFingerprint();

  const contractsManifest = loadContracts("proof-cache/contracts.json", TS_ROOT);
  const manifest = loadManifest("proof-cache/manifest.json", TS_ROOT);

  const filter = targetArg || "tests/validators.test.ts";
  console.log(`\n=== Explaining Proof Caching for: ${filter} ===\n`);

  const matchingContracts = contractsManifest.contracts.filter(
    (c) => c.testFile.includes(filter) || c.target.targetFile.includes(filter) || c.id.includes(filter),
  );

  if (matchingContracts.length === 0) {
    console.log(`No contracts found matching "${filter}".`);
    console.log("Registered contracts:", contractsManifest.contracts.map((c) => c.id).join(", "));
    return;
  }

  for (const c of matchingContracts) {
    console.log(`\n------------------------------------------------------------`);
    console.log(`Contract: ${c.id}`);
    console.log(`Description: ${c.description || "N/A"}`);
    console.log(`Test:   ${c.testFile} -> ${c.testKind}("${c.testPattern}")`);
    console.log(`Target: ${c.target.targetFile} -> ${c.target.targetKind}:${c.target.targetName}`);

    const testFullPath = path.join(TS_ROOT, c.testFile);
    const targetFullPath = path.join(TS_ROOT, c.target.targetFile);

    if (fs.existsSync(testFullPath) && fs.existsSync(targetFullPath)) {
      const testCode = fs.readFileSync(testFullPath, "utf8");
      const targetCode = fs.readFileSync(targetFullPath, "utf8");

      const testFp = await fingerprintTestUnit(testCode, c);
      const targetFp = await fingerprintTargetUnit(targetCode, c.target);

      console.log(`Current Test AST Fingerprint:   ${testFp?.fingerprint}`);
      console.log(`Current Target AST Fingerprint: ${targetFp?.fingerprint}`);

      const recorded = manifest.proofs[c.id];
      if (recorded) {
        console.log(`\nManifest Proof Record:`);
        console.log(`  Status:             ${recorded.status}`);
        console.log(`  Recorded Test FP:   ${recorded.testFingerprint}`);
        console.log(`  Recorded Target FP: ${recorded.targetFingerprint}`);
        console.log(`  Verified At:        ${recorded.provenance.verifiedAt}`);
        console.log(`  Runner:             ${recorded.provenance.runner} (${recorded.provenance.runtime})`);
        console.log(`  Git Commit:         ${recorded.provenance.gitCommit || "N/A"}`);

        const testMatch = recorded.testFingerprint === testFp?.fingerprint;
        const targetMatch = recorded.targetFingerprint === targetFp?.fingerprint;
        console.log(`\nVerification:`);
        console.log(`  Test AST match:   ${testMatch ? "✅ MATCH" : "❌ CHANGED"}`);
        console.log(`  Target AST match: ${targetMatch ? "✅ MATCH" : "❌ CHANGED"}`);
        console.log(`  Skip eligible:    ${testMatch && targetMatch ? "⚡ YES (SAFE TO SKIP)" : "⚠️ NO (MUST RUN)"}`);
      } else {
        console.log(`\nNo recorded proof in manifest for contract ${c.id}`);
      }
    }
  }
}

async function cmdUpdate() {
  const { recordPassingProofs } = await getEngine();
  console.log("\n[proof-cache] Re-pinning all passing contracts in manifest...");
  const res = await recordPassingProofs(["all"], "proof-cache/contracts.json", "proof-cache/manifest.json", TS_ROOT);
  console.log(`[proof-cache] ✅ Successfully updated ${res.updatedCount} proof records in proof-cache/manifest.json\n`);
}

async function cmdBench() {
  console.log("\n=======================================================");
  console.log("   AST Unit-Test Proof Cache: Timing Benchmark");
  console.log("=======================================================\n");

  // 1. Measure compile time
  const t0_compile = performance.now();
  spawnSync("pnpm", ["run", "build"], { cwd: TS_ROOT, stdio: "ignore" });
  spawnSync("pnpm", ["run", "build:tests"], { cwd: TS_ROOT, stdio: "ignore" });
  const t1_compile = performance.now();
  const compileMs = t1_compile - t0_compile;

  // 2. Measure proof validation time
  const { evaluateProofCache } = await getEngine();
  const allFiles = getAllTestFiles();
  const t0_val = performance.now();
  const summary = await evaluateProofCache(allFiles, "proof-cache/contracts.json", "proof-cache/manifest.json", TS_ROOT);
  const t1_val = performance.now();
  const valMs = t1_val - t0_val;

  // 3. Fast unit suite benchmark (validators, envelope, auth, followon, server, proof-cache)
  const fastFiles = allFiles.filter((f) =>
    ["validators", "envelope", "auth", "followon", "server", "proof-cache"].some((name) => f.includes(name)),
  );
  const fastFilesToRun = fastFiles.filter((f) => {
    const dec = summary.fileDecisions.find((d) => d.testBuildFile === f);
    return !dec?.canSkip;
  });

  console.log("Measuring Fast Unit & Smarts Suite (Fast dev feedback loop)...");
  const t0_fast_full = performance.now();
  spawnSync("bun", ["test", "--timeout", "120000", ...fastFiles], { cwd: TS_ROOT, stdio: "ignore" });
  const t1_fast_full = performance.now();
  const fastFullMs = t1_fast_full - t0_fast_full;

  const t0_fast_cached = performance.now();
  if (fastFilesToRun.length > 0) {
    spawnSync("bun", ["test", "--timeout", "120000", ...fastFilesToRun], { cwd: TS_ROOT, stdio: "ignore" });
  }
  const t1_fast_cached = performance.now();
  const fastCachedMs = t1_fast_cached - t0_fast_cached;

  const fastSavedMs = fastFullMs - (valMs + fastCachedMs);

  console.log("\n" + "=".repeat(65));
  console.log(" FAST SUITE TIMING (Unit & Smarts: 6 test files)");
  console.log("=".repeat(65));
  console.log(` 1. TypeScript Compilation (tsc):       ${compileMs.toFixed(1).padStart(8)} ms`);
  console.log(` 2. Proof Validation (ast-grep):        ${valMs.toFixed(1).padStart(8)} ms`);
  console.log(` 3. Test Execution (Uncached, 6 files): ${fastFullMs.toFixed(1).padStart(8)} ms`);
  console.log(` 4. Test Execution (Cached, 4 files):   ${fastCachedMs.toFixed(1).padStart(8)} ms`);
  console.log("-".repeat(65));
  console.log(` Total Fast Cycle (Uncached):           ${(compileMs + fastFullMs).toFixed(1).padStart(8)} ms`);
  console.log(` Total Fast Cycle (With Proof Cache):   ${(compileMs + valMs + fastCachedMs).toFixed(1).padStart(8)} ms`);
  console.log(` Fast Suite Wall-Clock Delta:           ${(fastSavedMs >= 0 ? "-" : "+") + Math.abs(fastSavedMs).toFixed(1).padStart(8)} ms (${((fastSavedMs / fastFullMs) * 100).toFixed(1)}% test exec reduction)`);
  console.log("=".repeat(65) + "\n");
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "check";

  if (command === "check") {
    await cmdCheck();
  } else if (command === "update") {
    await cmdUpdate();
  } else if (command === "explain") {
    await cmdExplain(args[1]);
  } else if (command === "bench") {
    await cmdBench();
  } else {
    console.log(`Unknown command: ${command}`);
    console.log("Usage: node scripts/proof-cache.mjs [check|update|explain|bench]");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
