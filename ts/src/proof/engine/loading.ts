/**
 * Manifest load/save + git provenance. (slice 24 of the proof/engine.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/proof/engine.ts. Exported there, re-exported via
 * engine.ts so the `./proof/engine.js` public surface (scripts + tests) is unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
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
