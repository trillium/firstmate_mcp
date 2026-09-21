/**
 * Core type definitions for AST-based unit-test proof caching.
 *
 * Proof caching provides content-addressed, AST-fingerprinted proof records
 * for explicitly bounded unit tests. A test that previously passed against an
 * identical AST representation of a code unit does not need to re-execute.
 */

export type TargetKind =
  | "function"
  | "arrow_function"
  | "class"
  | "method"
  | "multi_function";

export type TestKind = "describe" | "it" | "suite" | "file";

export interface TargetUnitSpec {
  /** Target file path relative to repo ts/ root (e.g. "src/validators.ts") */
  targetFile: string;
  /** Kind of code unit */
  targetKind: TargetKind;
  /** Name of function, class, or method */
  targetName: string;
  /** Optional secondary function/method names if a block verifies a small cluster */
  additionalNames?: string[];
}

export interface ProofContract {
  /** Unique contract identifier (e.g. "validators.validId") */
  id: string;
  /** Test file path relative to repo ts/ root (e.g. "tests/validators.test.ts") */
  testFile: string;
  /** Test block name or pattern (e.g. "validId" for describe("validId", ...)) */
  testPattern: string;
  /** Test block kind */
  testKind: TestKind;
  /** Target code unit specifications */
  target: TargetUnitSpec;
  /** Human-readable description of what this contract asserts */
  description?: string;
  /** Whether this contract is bounded and eligible for proof caching (fail-closed) */
  bounded: boolean;
}

export interface ProofContractsManifest {
  version: number;
  description?: string;
  contracts: ProofContract[];
}

export interface ProvenanceInfo {
  /** Runner used when proof was established (e.g. "bun test", "node --test") */
  runner: string;
  /** Runtime engine and version (e.g. "bun 1.3.11", "node 24.12.0") */
  runtime: string;
  /** ISO-8601 UTC timestamp when proof was verified */
  verifiedAt: string;
  /** Git commit SHA when proof was established, if available */
  gitCommit?: string;
  /** ast-grep / tool version */
  astGrepVersion?: string;
}

export interface ProofRecord {
  /** Verified outcome */
  status: "PASS";
  /** SHA-256 fingerprint of the normalized test AST */
  testFingerprint: string;
  /** SHA-256 fingerprint of the normalized code unit AST */
  targetFingerprint: string;
  /** Test file and unit descriptor */
  testFile: string;
  testUnit: string;
  /** Target file and unit descriptor */
  targetFile: string;
  targetUnit: string;
  /** Provenance metadata explaining how and when the proof was established */
  provenance: ProvenanceInfo;
}

export interface ProofManifest {
  version: number;
  generatedAt: string;
  proofs: Record<string, ProofRecord>;
}

export type ProofStatus =
  | "VALID_CACHED"
  | "STALE_CODE_CHANGED"
  | "STALE_TEST_CHANGED"
  | "STALE_NEW_CONTRACT"
  | "MISSING_SOURCE"
  | "MISSING_TEST"
  | "INELIGIBLE";

export interface ProofEvaluation {
  contractId: string;
  contract: ProofContract;
  status: ProofStatus;
  canSkip: boolean;
  currentTestFingerprint?: string;
  currentTargetFingerprint?: string;
  manifestTestFingerprint?: string;
  manifestTargetFingerprint?: string;
  reason: string;
}

export interface FileProofDecision {
  testFile: string;
  testBuildFile: string;
  eligible: boolean;
  canSkip: boolean;
  totalContracts: number;
  validContracts: number;
  staleContracts: number;
  contracts: ProofEvaluation[];
  reason: string;
}

export interface ProofCacheEvaluationSummary {
  evaluatedAt: string;
  totalTestFiles: number;
  eligibleTestFiles: number;
  skippedTestFiles: number;
  executedTestFiles: number;
  totalContracts: number;
  validContracts: number;
  staleContracts: number;
  fileDecisions: FileProofDecision[];
}

export interface TimingBreakdown {
  compileMs: number;
  validateProofsMs: number;
  executeMs: number;
  totalWallClockMs: number;
  skippedFileCount: number;
  executedFileCount: number;
  totalFileCount: number;
  cacheHitRatio: number;
}
