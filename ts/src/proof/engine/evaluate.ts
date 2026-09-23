/**
 * Per-contract AST evaluation. (slice 24 of the proof/engine.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/proof/engine.ts. Exported there, re-exported via
 * engine.ts so the `./proof/engine.js` public surface (scripts + tests) is unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import {
  fingerprintTargetUnit,
  fingerprintTestUnit,
} from "../fingerprint.js";
import type {
  ProofContract,
  ProofContractsManifest,
  ProofManifest,
  ProofRecord,
  ProofEvaluation,
  FileProofDecision,
  ProofCacheEvaluationSummary,
  ProvenanceInfo,
} from "../types.js";

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
