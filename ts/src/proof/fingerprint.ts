/**
 * AST Fingerprinting and Normalization Engine for Unit-Test Proof Caching.
 *
 * Uses ast-grep (via @ast-grep/napi) to parse TypeScript source and test files,
 * locate bounded code units, normalize trivia (comments, whitespace, semicolons,
 * trailing commas), and compute stable SHA-256 fingerprints.
 */

import crypto from "node:crypto";
import type { TargetUnitSpec, ProofContract } from "./types.js";

// SgNode interface subset from @ast-grep/napi
export interface AstGrepNode {
  kind(): string;
  isLeaf(): boolean;
  isNamed(): boolean;
  text(): string;
  children(): AstGrepNode[];
  find(query: unknown): AstGrepNode | null;
  findAll(query: unknown): AstGrepNode[];
}

export interface AstGrepRoot {
  root(): AstGrepNode;
}

export interface ParseApi {
  parse: (lang: unknown, code: string) => AstGrepRoot;
  Lang: { TypeScript: unknown; TSX: unknown };
}

let cachedNapi: ParseApi | null = null;

/**
 * Dynamically loads @ast-grep/napi.
 */
export async function getAstGrep(): Promise<ParseApi> {
  if (cachedNapi) return cachedNapi;
  try {
    const napi = await import("@ast-grep/napi");
    cachedNapi = napi as unknown as ParseApi;
    return cachedNapi;
  } catch (err) {
    throw new Error(`Failed to load @ast-grep/napi: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Synchronous or async parse helper.
 */
export async function parseTypeScript(code: string): Promise<AstGrepNode> {
  const sg = await getAstGrep();
  const tree = sg.parse(sg.Lang.TypeScript, code);
  return tree.root();
}

/**
 * Normalizes and recursively serializes an AST node to a canonical string representation.
 *
 * Invariants:
 * 1. Comments (single-line, multi-line, JSDoc) are excluded.
 * 2. Non-semantic statement terminators (semicolons) are excluded.
 * 3. Trailing commas in object/array/parameter lists before closing delimiters are normalized.
 * 4. Whitespace, newlines, and indentation between tokens do not affect the output.
 * 5. Semantic changes (identifiers, literals, operators, structure, types) produce distinct serializations.
 */
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
export function findTargetUnitNode(
  root: AstGrepNode,
  spec: TargetUnitSpec,
): AstGrepNode | AstGrepNode[] | null {
  const name = spec.targetName;

  switch (spec.targetKind) {
    case "function": {
      // Find function_declaration with matching name
      const fnNodes = root.findAll({
        rule: {
          kind: "function_declaration",
          has: {
            field: "name",
            regex: `^${escapeRegex(name)}$`,
          },
        },
      });
      if (fnNodes.length > 0) return fnNodes[0];

      // Fallback: look for export function or const fn = ...
      const varNodes = root.findAll({
        rule: {
          kind: "variable_declarator",
          has: {
            field: "name",
            regex: `^${escapeRegex(name)}$`,
          },
        },
      });
      if (varNodes.length > 0) return varNodes[0];
      return null;
    }

    case "arrow_function": {
      const varNodes = root.findAll({
        rule: {
          kind: "variable_declarator",
          has: {
            field: "name",
            regex: `^${escapeRegex(name)}$`,
          },
        },
      });
      return varNodes.length > 0 ? varNodes[0] : null;
    }

    case "class": {
      const classNodes = root.findAll({
        rule: {
          kind: "class_declaration",
          has: {
            field: "name",
            regex: `^${escapeRegex(name)}$`,
          },
        },
      });
      return classNodes.length > 0 ? classNodes[0] : null;
    }

    case "method": {
      const methodNodes = root.findAll({
        rule: {
          kind: "method_definition",
          has: {
            field: "name",
            regex: `^${escapeRegex(name)}$`,
          },
        },
      });
      return methodNodes.length > 0 ? methodNodes[0] : null;
    }

    case "multi_function": {
      const names = [spec.targetName, ...(spec.additionalNames || [])];
      const matched: AstGrepNode[] = [];
      for (const fnName of names) {
        const fns = root.findAll({
          rule: {
            kind: "function_declaration",
            has: {
              field: "name",
              regex: `^${escapeRegex(fnName)}$`,
            },
          },
        });
        if (fns.length > 0) {
          matched.push(fns[0]);
        } else {
          const varNodes = root.findAll({
            rule: {
              kind: "variable_declarator",
              has: {
                field: "name",
                regex: `^${escapeRegex(fnName)}$`,
              },
            },
          });
          if (varNodes.length > 0) matched.push(varNodes[0]);
        }
      }
      return matched.length === names.length ? matched : null;
    }

    default:
      return null;
  }
}

/**
 * Extracts a test unit node from the test file AST.
 */
export function findTestUnitNode(
  root: AstGrepNode,
  contract: ProofContract,
): AstGrepNode | null {
  const pattern = contract.testPattern;

  if (contract.testKind === "describe" || contract.testKind === "it") {
    const fnName = contract.testKind;
    const calls = root.findAll({
      rule: {
        kind: "call_expression",
        has: {
          field: "function",
          regex: `^${fnName}$`,
        },
      },
    });

    for (const call of calls) {
      const text = call.text();
      // Look for describe("pattern", ...) or describe('pattern', ...)
      const regex = new RegExp(`^${fnName}\\s*\\(\\s*["'\`]${escapeRegex(pattern)}["'\`]`);
      if (regex.test(text)) {
        return call;
      }
    }
    return null;
  }

  if (contract.testKind === "suite" || contract.testKind === "file") {
    return root;
  }

  return null;
}

/**
 * Computes the target code unit fingerprint.
 */
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

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
