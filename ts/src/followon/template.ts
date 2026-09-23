/**
 * Argument templating + trigger matching. (slice 19 of the followon.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/followon.ts. Exported there, re-exported via
 * followon.ts so the `./followon.js` public surface is unchanged.
 */
import { extractFromContext } from "./conditions.js";
import type {
  FollowOnContext,
  FollowOnTrigger,
} from "./types.js";

const TEMPLATE_EXACT_RE = /^\$\{([^}]+)\}$/;
const TEMPLATE_EMBEDDED_RE = /\$\{([^}]+)\}/g;

/** Interpolate a single value against FollowOnContext. */
export function interpolateValue(value: unknown, ctx: FollowOnContext): unknown {
  if (typeof value === "string") {
    // Exact single substitution preserves native type (boolean, number, object, array)
    const exactMatch = value.match(TEMPLATE_EXACT_RE);
    if (exactMatch) {
      const extracted = extractFromContext(ctx, exactMatch[1].trim());
      return extracted !== undefined ? extracted : value;
    }
    // Embedded string interpolation
    if (value.includes("${")) {
      return value.replace(TEMPLATE_EMBEDDED_RE, (match, pathKey) => {
        const extracted = extractFromContext(ctx, pathKey.trim());
        if (extracted === undefined || extracted === null) return "";
        if (typeof extracted === "object") return JSON.stringify(extracted);
        return String(extracted);
      });
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => interpolateValue(item, ctx));
  }

  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = interpolateValue(v, ctx);
    }
    return result;
  }

  return value;
}

/** Interpolate an entire arguments dictionary. */
export function interpolateArgs(
  argsDef: Record<string, unknown> | undefined,
  ctx: FollowOnContext,
): Record<string, unknown> {
  if (!argsDef) return {};
  const interpolated = interpolateValue(argsDef, ctx);
  return (interpolated as Record<string, unknown>) ?? {};
}

// --- Trigger Matcher ---

export function matchesTrigger(
  trigger: FollowOnTrigger,
  tool: string,
  isError: boolean,
): boolean {
  // 1. Check tool name match
  const targets = Array.isArray(trigger.tool) ? trigger.tool : [trigger.tool];
  const toolMatches = targets.includes("*") || targets.includes(tool);
  if (!toolMatches) return false;

  // 2. Check outcome match
  const on = trigger.on ?? "success";
  if (on === "always" || on === "complete") return true;
  if (on === "success" && !isError) return true;
  if ((on === "failure" || on === "error") && isError) return true;

  return false;
}

