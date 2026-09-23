/**
 * File-level skip/execute decisions. (slice 24 of the proof/engine.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/proof/engine.ts. Exported there, re-exported via
 * engine.ts so the `./proof/engine.js` public surface (scripts + tests) is unchanged.
 */
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
