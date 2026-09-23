/**
 * Contract-script resolution: schema file lookup + owning-script index
 * (split from doctor.ts to keep both under the 250-line limit, task-8pqjb).
 */
import fs from "node:fs";
import path from "node:path";
import { CHECKOUT_ROOT } from "../constants.js";

function findSchemaFile(name: string): string | null {
  const candidates = [
    path.join(CHECKOUT_ROOT, "schema", name),
    path.join(CHECKOUT_ROOT, "..", "schema", name),
    path.join(CHECKOUT_ROOT, "..", "..", "schema", name),
    path.join(process.cwd(), "schema", name),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Tool -> owning script, parsed from schema/matrix.md (the dependency-free
 * contract view doctor also uses). Memoized per process: the file changes only
 * when the repo changes, and a refusal path should not re-read it per call.
 */
let contractScripts: Map<string, string> | null = null;

export function contractScriptIndex(): Map<string, string> {
  if (contractScripts !== null) return contractScripts;
  const index = new Map<string, string>();
  const indexPath = findSchemaFile("contracts.index.json");
  if (indexPath !== null) {
    try {
      const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8")) as {
        contracts?: Record<string, string>;
      };
      for (const [surface, command] of Object.entries(parsed.contracts ?? {})) {
        const match = /^bin\/([A-Za-z0-9._-]+)$/.exec(command);
        if (match) index.set(surface, match[1]);
      }
    } catch {
      /* an unreadable index means no pre-flight, never a broken call */
    }
  }
  contractScripts = index;
  return index;
}

/**
 * The owning script a declared contract needs but this home does not have, or
 * null when the tool may run.
 *
 * 18 of 55 contracts have no implementation on the served fork line (the fork
 * predates them: it ships fm-decision-hold.sh, not fm-captain-hold.sh, and has
 * no mail, voice, inbox, lease or extension scripts at all). Without this check
 * those tools reach a handler that shells out to a missing path and reports a raw
 * ENOENT, which reads like a bug rather than "this line cannot do that". Refusing
 * up front names the script and points at doctor.
 */
export function missingContractScript(tool: string, binDir: string): string | null {
  const script = contractScriptIndex().get(tool);
  if (!script) return null;
  return fs.existsSync(path.join(binDir, script)) ? null : script;
}
