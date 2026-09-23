/**
 * ast-grep loading + TypeScript parsing. (slice 26 of the proof/fingerprint.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/proof/fingerprint.ts. Exported there, re-exported
 * via fingerprint.ts so the `./proof/fingerprint.js` public surface (engine
 * slices + scripts) is unchanged.
 */
import crypto from "node:crypto";

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
