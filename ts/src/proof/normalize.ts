/**
 * AST normalization, serialization + hashing. (slice 26 of the proof/fingerprint.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/proof/fingerprint.ts. Exported there, re-exported
 * via fingerprint.ts so the `./proof/fingerprint.js` public surface (engine
 * slices + scripts) is unchanged.
 */
import crypto from "node:crypto";
import type { AstGrepNode } from "./ast-parse.js";

export function serializeAstNormalized(node: AstGrepNode): string | null {
  const kind = node.kind();

  // Exclude comment nodes and bare semicolon nodes
  if (kind === "comment" || kind === ";") {
    return null;
  }

  const children = node.children();
  if (children.length === 0 || node.isLeaf()) {
    return `${kind}:${node.text()}`;
  }

  const serializedChildren: string[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const childKind = child.kind();

    // Skip comments and semicolons
    if (childKind === "comment" || childKind === ";") {
      continue;
    }

    // Skip trailing commas before closing braces/brackets/parentheses
    if (childKind === ",") {
      const nextNonTrivia = children
        .slice(i + 1)
        .find((c) => c.kind() !== "comment" && c.kind() !== ";");
      if (nextNonTrivia && ["}", "]", ")"].includes(nextNonTrivia.kind())) {
        continue;
      }
    }

    const res = serializeAstNormalized(child);
    if (res !== null) {
      serializedChildren.push(res);
    }
  }

  return `${kind}(${serializedChildren.join(",")})`;
}

/**
 * Computes a SHA-256 fingerprint from a serialized canonical AST.
 */
export function sha256Hex(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Fingerprint a single AST node.
 */
export function fingerprintAstNode(node: AstGrepNode): { fingerprint: string; serialized: string } {
  const serialized = serializeAstNormalized(node) || "";
  const fingerprint = sha256Hex(serialized);
  return { fingerprint, serialized };
}

/**
 * Extracts a target code unit node from the source AST.
 */
