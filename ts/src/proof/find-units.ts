/**
 * Target/test unit location. (slice 26 of the proof/fingerprint.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/proof/fingerprint.ts. Exported there, re-exported
 * via fingerprint.ts so the `./proof/fingerprint.js` public surface (engine
 * slices + scripts) is unchanged.
 */
import type { AstGrepNode } from "./ast-parse.js";
import type { ProofContract, TargetUnitSpec } from "./types.js";

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
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
