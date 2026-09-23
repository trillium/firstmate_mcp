/**
 * Cache evaluation + PASS recording. (slice 24 of the proof/engine.ts folder split, task-8pqjb; pattern: brain-ws6lr).
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
import {
  DEFAULT_CONTRACTS_PATH,
  DEFAULT_MANIFEST_PATH,
  getGitCommit,
  loadContracts,
  loadManifest,
  saveManifest,
} from "./loading.js";
import { evaluateContracts } from "./evaluate.js";
import { computeFileDecisions } from "./decisions.js";
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
