/**
 * Proof Cache Engine: Evaluation, Verification, and Manifest Lifecycle.
 *
 * Provides the decision logic for the test runner:
 * - Computes fresh AST fingerprints for each bounded contract.
 * - Compares with the committed proof manifest.
 * - Determines which test files can be safely skipped vs which must execute.
 * - Records fresh PASS proofs when tests execute successfully.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  fingerprintTargetUnit,
  fingerprintTestUnit,
} from "./fingerprint.js";
import type {
  ProofContract,
  ProofContractsManifest,
  ProofManifest,
  ProofRecord,
  ProofEvaluation,
  FileProofDecision,
  ProofCacheEvaluationSummary,
  ProvenanceInfo,
} from "./types.js";

export const DEFAULT_CONTRACTS_PATH = "proof-cache/contracts.json";
export const DEFAULT_MANIFEST_PATH = "proof-cache/manifest.json";

/**
 * Loads the proof contracts manifest from disk.
 */
export function loadContracts(
  contractsPath: string = DEFAULT_CONTRACTS_PATH,
  baseDir: string = process.cwd(),
): ProofContractsManifest {
  const fullPath = path.isAbsolute(contractsPath)
    ? contractsPath
    : path.join(baseDir, contractsPath);

  if (!fs.existsSync(fullPath)) {
    return { version: 1, contracts: [] };
  }

  const content = fs.readFileSync(fullPath, "utf8");
  return JSON.parse(content) as ProofContractsManifest;
}

/**
 * Loads the committed proof manifest from disk.
 */
export function loadManifest(
  manifestPath: string = DEFAULT_MANIFEST_PATH,
  baseDir: string = process.cwd(),
): ProofManifest {
  const fullPath = path.isAbsolute(manifestPath)
    ? manifestPath
    : path.join(baseDir, manifestPath);

  if (!fs.existsSync(fullPath)) {
    return { version: 1, generatedAt: new Date().toISOString(), proofs: {} };
  }

  const content = fs.readFileSync(fullPath, "utf8");
  return JSON.parse(content) as ProofManifest;
}

/**
 * Saves the proof manifest to disk with stable JSON formatting.
 */
export function saveManifest(
  manifest: ProofManifest,
  manifestPath: string = DEFAULT_MANIFEST_PATH,
  baseDir: string = process.cwd(),
): void {
  const fullPath = path.isAbsolute(manifestPath)
    ? manifestPath
    : path.join(baseDir, manifestPath);

  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Sort proofs by contract ID for deterministic diffs
  const sortedProofs: Record<string, ProofRecord> = {};
  for (const key of Object.keys(manifest.proofs).sort()) {
    sortedProofs[key] = manifest.proofs[key];
  }

  const output: ProofManifest = {
    version: manifest.version || 1,
    generatedAt: manifest.generatedAt || new Date().toISOString(),
    proofs: sortedProofs,
  };

  fs.writeFileSync(fullPath, JSON.stringify(output, null, 2) + "\n", "utf8");
}

/**
 * Helper to get current git commit hash.
 */
export function getGitCommit(): string | undefined {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Evaluates all proof contracts against the current source code and manifest.
 */
export async function evaluateContracts(
  contracts: ProofContract[],
  manifest: ProofManifest,
  baseDir: string = process.cwd(),
): Promise<ProofEvaluation[]> {
  const evaluations: ProofEvaluation[] = [];

  // Cache source/test file contents in memory during evaluation
  const fileCache = new Map<string, string>();
  function readFile(relPath: string): string | null {
    if (fileCache.has(relPath)) return fileCache.get(relPath)!;
    const fullPath = path.isAbsolute(relPath) ? relPath : path.join(baseDir, relPath);
    if (!fs.existsSync(fullPath)) return null;
    const content = fs.readFileSync(fullPath, "utf8");
    fileCache.set(relPath, content);
    return content;
  }

  for (const contract of contracts) {
    if (!contract.bounded) {
      evaluations.push({
        contractId: contract.id,
        contract,
        status: "INELIGIBLE",
        canSkip: false,
        reason: "Contract is explicitly marked unbounded or ineligible",
      });
      continue;
    }

    const testContent = readFile(contract.testFile);
    if (testContent === null) {
      evaluations.push({
        contractId: contract.id,
        contract,
        status: "MISSING_TEST",
        canSkip: false,
        reason: `Test file not found: ${contract.testFile}`,
      });
      continue;
    }

    const targetContent = readFile(contract.target.targetFile);
    if (targetContent === null) {
      evaluations.push({
        contractId: contract.id,
        contract,
        status: "MISSING_SOURCE",
        canSkip: false,
        reason: `Target source file not found: ${contract.target.targetFile}`,
      });
      continue;
    }

    // Compute fresh fingerprints
    const targetFpResult = await fingerprintTargetUnit(targetContent, contract.target);
    if (!targetFpResult) {
      evaluations.push({
        contractId: contract.id,
        contract,
        status: "MISSING_SOURCE",
        canSkip: false,
        reason: `Failed to extract AST node for target unit: ${contract.target.targetName} (${contract.target.targetKind}) in ${contract.target.targetFile}`,
      });
      continue;
    }

    const testFpResult = await fingerprintTestUnit(testContent, contract);
    if (!testFpResult) {
      evaluations.push({
        contractId: contract.id,
        contract,
        status: "MISSING_TEST",
        canSkip: false,
        reason: `Failed to extract AST node for test unit: ${contract.testPattern} (${contract.testKind}) in ${contract.testFile}`,
      });
      continue;
    }

    const currentTestFp = testFpResult.fingerprint;
    const currentTargetFp = targetFpResult.fingerprint;

    const recordedProof = manifest.proofs[contract.id];
    if (!recordedProof) {
      evaluations.push({
        contractId: contract.id,
        contract,
        status: "STALE_NEW_CONTRACT",
        canSkip: false,
        currentTestFingerprint: currentTestFp,
        currentTargetFingerprint: currentTargetFp,
        reason: `No recorded proof in manifest for contract ${contract.id}`,
      });
      continue;
    }

    if (recordedProof.status !== "PASS") {
      evaluations.push({
        contractId: contract.id,
        contract,
        status: "STALE_CODE_CHANGED",
        canSkip: false,
        currentTestFingerprint: currentTestFp,
        currentTargetFingerprint: currentTargetFp,
        manifestTestFingerprint: recordedProof.testFingerprint,
        manifestTargetFingerprint: recordedProof.targetFingerprint,
        reason: `Recorded proof status is ${recordedProof.status}, not PASS`,
      });
      continue;
    }

    const testMatch = recordedProof.testFingerprint === currentTestFp;
    const targetMatch = recordedProof.targetFingerprint === currentTargetFp;

    if (testMatch && targetMatch) {
      evaluations.push({
        contractId: contract.id,
        contract,
        status: "VALID_CACHED",
        canSkip: true,
        currentTestFingerprint: currentTestFp,
        currentTargetFingerprint: currentTargetFp,
        manifestTestFingerprint: recordedProof.testFingerprint,
        manifestTargetFingerprint: recordedProof.targetFingerprint,
        reason: `AST fingerprints match committed PASS proof verified at ${recordedProof.provenance.verifiedAt}`,
      });
    } else if (!targetMatch) {
      evaluations.push({
        contractId: contract.id,
        contract,
        status: "STALE_CODE_CHANGED",
        canSkip: false,
        currentTestFingerprint: currentTestFp,
        currentTargetFingerprint: currentTargetFp,
        manifestTestFingerprint: recordedProof.testFingerprint,
        manifestTargetFingerprint: recordedProof.targetFingerprint,
        reason: `Target code unit AST changed (manifest: ${recordedProof.targetFingerprint.slice(0, 12)}..., current: ${currentTargetFp.slice(0, 12)}...)`,
      });
    } else {
      evaluations.push({
        contractId: contract.id,
        contract,
        status: "STALE_TEST_CHANGED",
        canSkip: false,
        currentTestFingerprint: currentTestFp,
        currentTargetFingerprint: currentTargetFp,
        manifestTestFingerprint: recordedProof.testFingerprint,
        manifestTargetFingerprint: recordedProof.targetFingerprint,
        reason: `Test AST changed (manifest: ${recordedProof.testFingerprint.slice(0, 12)}..., current: ${currentTestFp.slice(0, 12)}...)`,
      });
    }
  }

  return evaluations;
}

/**
 * Computes skip decisions per test file.
 *
 * Rule: A test file can only be skipped if:
 * 1. It has at least one registered contract.
 * 2. 100% of its registered contracts are VALID_CACHED.
 * 3. None of its contracts are ineligible or stale.
 */
export function computeFileDecisions(
  allTestFiles: string[],
  evaluations: ProofEvaluation[],
): FileProofDecision[] {
  // Map testFile or testbuild path to evaluations
  const evaluationsByTestFile = new Map<string, ProofEvaluation[]>();

  for (const ev of evaluations) {
    const norm = ev.contract.testFile.replace(/\\/g, "/");
    if (!evaluationsByTestFile.has(norm)) {
      evaluationsByTestFile.set(norm, []);
    }
    evaluationsByTestFile.get(norm)!.push(ev);
  }

  const decisions: FileProofDecision[] = [];

  for (const rawFile of allTestFiles) {
    const normFile = rawFile.replace(/\\/g, "/");
    // Normalize path to source test file path (e.g. testbuild/tests/foo.test.js -> tests/foo.test.ts)
    let srcTestFile = normFile;
    if (srcTestFile.startsWith("testbuild/")) {
      srcTestFile = srcTestFile.replace(/^testbuild\//, "");
    }
    if (srcTestFile.endsWith(".js")) {
      srcTestFile = srcTestFile.replace(/\.js$/, ".ts");
    }

    const fileEvals = evaluationsByTestFile.get(srcTestFile) || [];

    if (fileEvals.length === 0) {
      // Ineligible file: no contracts registered (integration, system, or unbounded)
      decisions.push({
        testFile: srcTestFile,
        testBuildFile: normFile,
        eligible: false,
        canSkip: false,
        totalContracts: 0,
        validContracts: 0,
        staleContracts: 0,
        contracts: [],
        reason: "Ineligible for proof caching (multi-unit, integration, or no explicit contracts registered)",
      });
      continue;
    }

    const total = fileEvals.length;
    const valid = fileEvals.filter((e) => e.status === "VALID_CACHED").length;
    const stale = total - valid;
    const canSkip = total > 0 && stale === 0;

    let reason = "";
    if (canSkip) {
      reason = `All ${valid}/${total} unit proofs valid from cache`;
    } else {
      const staleReasons = fileEvals
        .filter((e) => e.status !== "VALID_CACHED")
        .map((e) => `${e.contract.id}: ${e.reason}`)
        .join("; ");
      reason = `${stale}/${total} contracts stale or invalid: ${staleReasons}`;
    }

    decisions.push({
      testFile: srcTestFile,
      testBuildFile: normFile,
      eligible: true,
      canSkip,
      totalContracts: total,
      validContracts: valid,
      staleContracts: stale,
      contracts: fileEvals,
      reason,
    });
  }

  return decisions;
}

/**
 * Full proof evaluation pipeline returning a complete summary.
 */
export async function evaluateProofCache(
  allTestFiles: string[],
  contractsPath: string = DEFAULT_CONTRACTS_PATH,
  manifestPath: string = DEFAULT_MANIFEST_PATH,
  baseDir: string = process.cwd(),
): Promise<ProofCacheEvaluationSummary> {
  const contractsManifest = loadContracts(contractsPath, baseDir);
  const proofManifest = loadManifest(manifestPath, baseDir);

  const evaluations = await evaluateContracts(
    contractsManifest.contracts,
    proofManifest,
    baseDir,
  );

  const fileDecisions = computeFileDecisions(allTestFiles, evaluations);

  const eligibleTestFiles = fileDecisions.filter((f) => f.eligible).length;
  const skippedTestFiles = fileDecisions.filter((f) => f.canSkip).length;
  const executedTestFiles = fileDecisions.filter((f) => !f.canSkip).length;

  const totalContracts = evaluations.length;
  const validContracts = evaluations.filter((e) => e.status === "VALID_CACHED").length;
  const staleContracts = totalContracts - validContracts;

  return {
    evaluatedAt: new Date().toISOString(),
    totalTestFiles: allTestFiles.length,
    eligibleTestFiles,
    skippedTestFiles,
    executedTestFiles,
    totalContracts,
    validContracts,
    staleContracts,
    fileDecisions,
  };
}

/**
 * Updates the proof manifest for passed test files.
 */
export async function recordPassingProofs(
  passedSrcTestFiles: string[],
  contractsPath: string = DEFAULT_CONTRACTS_PATH,
  manifestPath: string = DEFAULT_MANIFEST_PATH,
  baseDir: string = process.cwd(),
  provenanceOverrides: Partial<ProvenanceInfo> = {},
): Promise<{ updatedCount: number; manifest: ProofManifest }> {
  const contractsManifest = loadContracts(contractsPath, baseDir);
  const proofManifest = loadManifest(manifestPath, baseDir);

  const passedSet = new Set(
    passedSrcTestFiles.map((f) =>
      f
        .replace(/\\/g, "/")
        .replace(/^testbuild\//, "")
        .replace(/\.js$/, ".ts"),
    ),
  );

  let updatedCount = 0;
  const gitCommit = getGitCommit();
  const now = new Date().toISOString();

  for (const contract of contractsManifest.contracts) {
    const normTestFile = contract.testFile.replace(/\\/g, "/");
    if (!passedSet.has(normTestFile) && !passedSet.has("all")) {
      continue;
    }

    const testFullPath = path.isAbsolute(contract.testFile)
      ? contract.testFile
      : path.join(baseDir, contract.testFile);
    const targetFullPath = path.isAbsolute(contract.target.targetFile)
      ? contract.target.targetFile
      : path.join(baseDir, contract.target.targetFile);

    if (!fs.existsSync(testFullPath) || !fs.existsSync(targetFullPath)) {
      continue;
    }

    const testContent = fs.readFileSync(testFullPath, "utf8");
    const targetContent = fs.readFileSync(targetFullPath, "utf8");

    const targetFp = await fingerprintTargetUnit(targetContent, contract.target);
    const testFp = await fingerprintTestUnit(testContent, contract);

    if (!targetFp || !testFp) {
      continue;
    }

    const record: ProofRecord = {
      status: "PASS",
      testFingerprint: testFp.fingerprint,
      targetFingerprint: targetFp.fingerprint,
      testFile: contract.testFile,
      testUnit: `${contract.testKind}:${contract.testPattern}`,
      targetFile: contract.target.targetFile,
      targetUnit: `${contract.target.targetKind}:${contract.target.targetName}`,
      provenance: {
        runner: provenanceOverrides.runner || "bun test",
        runtime:
          provenanceOverrides.runtime ||
          `node ${process.version} (bun ${process.versions.bun || "compat"})`,
        verifiedAt: now,
        gitCommit: provenanceOverrides.gitCommit || gitCommit,
        astGrepVersion: provenanceOverrides.astGrepVersion || "0.45.3",
      },
    };

    proofManifest.proofs[contract.id] = record;
    updatedCount++;
  }

  proofManifest.generatedAt = now;
  saveManifest(proofManifest, manifestPath, baseDir);

  return { updatedCount, manifest: proofManifest };
}
