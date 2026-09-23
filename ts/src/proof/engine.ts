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

// Manifest load/save + provenance live in ./engine/loading.ts (slice 24, task-8pqjb).
import {
  DEFAULT_CONTRACTS_PATH,
  DEFAULT_MANIFEST_PATH,
  loadContracts,
  loadManifest,
  saveManifest,
  getGitCommit,
} from "./engine/loading.js";
export {
  DEFAULT_CONTRACTS_PATH,
  DEFAULT_MANIFEST_PATH,
  loadContracts,
  loadManifest,
  saveManifest,
  getGitCommit,
};
// Per-contract evaluation live in ./engine/evaluate.ts (slice 24, task-8pqjb).
import {
  evaluateContracts,
} from "./engine/evaluate.js";
export {
  evaluateContracts,
};
// File-level decisions live in ./engine/decisions.ts (slice 24, task-8pqjb).
import {
  computeFileDecisions,
} from "./engine/decisions.js";
export {
  computeFileDecisions,
};
// Cache evaluation + PASS recording live in ./engine/cache.ts (slice 24, task-8pqjb).
import {
  evaluateProofCache,
  recordPassingProofs,
} from "./engine/cache.js";
export {
  evaluateProofCache,
  recordPassingProofs,
};
