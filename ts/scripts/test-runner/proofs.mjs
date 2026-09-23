/**
 * Proof evaluation + PASS recording. (slice 27 of the test-runner.mjs folder split, task-8pqjb).
 *
 * Moved verbatim from scripts/test-runner.mjs. Imported by test-runner.mjs;
 * CLI surface (`--bun/--node/--all/--no-cache/--failed-only`) is unchanged.
 */
import { spawnSync } from "node:child_process";
import { CONTRACTS_FILE, MANIFEST_FILE, TS_ROOT } from "./config.mjs";

/**
 * Runs AST proof cache evaluation.
 * Spawns node if currently executing under bun (due to Bun N-API tree-sitter compatibility).
 */
export async function evaluateProofs(testFiles) {
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
export async function updatePassingProofs(passedFiles) {
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
