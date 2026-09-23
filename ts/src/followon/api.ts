/**
 * In-memory API + layers (interface moved with its implementations). (slice 19 of the followon.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/followon.ts. Exported there, re-exported via
 * followon.ts so the `./followon.js` public surface is unchanged.
 */
import { Effect, Layer } from "effect";
import fs from "node:fs";
import path from "node:path";
import { AuditService } from "../auth.js";
import { executeFollowOnsEffect } from "../followon.js";
import type { ToolContext } from "../tools.js";
import type {
  FollowOnChainSummary,
  FollowOnContext,
  FollowOnOptions,
  FollowOnRule,
  OriginContext,
} from "./types.js";

export interface FollowOnApi {
  readonly registerRule: (rule: FollowOnRule) => Effect.Effect<void>;
  readonly registerRules: (rules: readonly FollowOnRule[]) => Effect.Effect<void>;
  readonly getRules: () => Effect.Effect<readonly FollowOnRule[]>;
  readonly clearRules: () => Effect.Effect<void>;
  readonly loadConfigFile: (configPath?: string) => Effect.Effect<number>;
  readonly executeFollowOns: (
    origin: OriginContext,
    ctx: ToolContext,
    options?: FollowOnOptions,
  ) => Effect.Effect<FollowOnChainSummary, never, AuditService>;
}
/** In-memory store + config loader implementation of FollowOnService. */
export function makeFollowOnApi(initialRules: readonly FollowOnRule[] = []): FollowOnApi {
  const rulesStore: FollowOnRule[] = [...initialRules];

  return {
    registerRule: (rule) =>
      Effect.sync(() => {
        rulesStore.push(rule);
      }),
    registerRules: (rules) =>
      Effect.sync(() => {
        rulesStore.push(...rules);
      }),
    getRules: () => Effect.sync(() => [...rulesStore]),
    clearRules: () =>
      Effect.sync(() => {
        rulesStore.length = 0;
      }),
    loadConfigFile: (configPath) =>
      Effect.sync(() => {
        const targetPath =
          configPath ??
          process.env.FM_FOLLOWON_CONFIG ??
          (process.env.FM_HOME
            ? path.join(process.env.FM_HOME, "config", "followons.json")
            : undefined);

        if (!targetPath || !fs.existsSync(targetPath)) return 0;

        try {
          const raw = fs.readFileSync(targetPath, "utf8");
          const parsed = JSON.parse(raw);
          const loaded: FollowOnRule[] = Array.isArray(parsed) ? parsed : parsed.rules ?? [];
          rulesStore.push(...loaded);
          return loaded.length;
        } catch {
          return 0;
        }
      }),
    executeFollowOns: (origin, toolCtx, options) =>
      executeFollowOnsEffect(origin, toolCtx, rulesStore, options),
  };
}
