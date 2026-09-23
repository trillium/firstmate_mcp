/**
 * Target/test fingerprint entry points. (slice 26 of the proof/fingerprint.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/proof/fingerprint.ts. Exported there, re-exported
 * via fingerprint.ts so the `./proof/fingerprint.js` public surface (engine
 * slices + scripts) is unchanged.
 */
import { parseTypeScript, type AstGrepNode } from "./ast-parse.js";
import { findTargetUnitNode, findTestUnitNode } from "./find-units.js";
import { fingerprintAstNode, serializeAstNormalized, sha256Hex } from "./normalize.js";
import type { ProofContract, TargetUnitSpec } from "./types.js";

export async function fingerprintTargetUnit(
  sourceCode: string,
  spec: TargetUnitSpec,
): Promise<{ fingerprint: string; serialized: string } | null> {
  const root = await parseTypeScript(sourceCode);
  const targetNodeOrNodes = findTargetUnitNode(root, spec);

  if (!targetNodeOrNodes) {
    return null;
  }

  if (Array.isArray(targetNodeOrNodes)) {
    const serializedParts = targetNodeOrNodes.map(
      (node) => serializeAstNormalized(node) || "",
    );
    const combined = `multi_unit(${serializedParts.join(";")})`;
    return {
      fingerprint: sha256Hex(combined),
      serialized: combined,
    };
  }

  return fingerprintAstNode(targetNodeOrNodes);
}

/**
 * Computes the test unit fingerprint.
 */
export async function fingerprintTestUnit(
  testCode: string,
  contract: ProofContract,
): Promise<{ fingerprint: string; serialized: string } | null> {
  const root = await parseTypeScript(testCode);
  const testNode = findTestUnitNode(root, contract);

  if (!testNode) {
    return null;
  }

  return fingerprintAstNode(testNode);
}

