/**
 * Live context constructors (slice 29 finale, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. liveContext is imported across the
 * doorway; re-exported via tools.ts so the `./tools.js` public surface is unchanged.
 */
import { Effect } from "effect";
import {
  binDir as defaultBinDir,
  dataDir as defaultDataDir,
  stateDir as defaultStateDir,
} from "../constants.js";
import { runScript } from "../runner.js";
import { ConfigService } from "../config.js";
import type { ToolContext } from "../tools.js";

export function liveContext(): ToolContext {
  return {
    binDir: defaultBinDir(),
    stateDir: defaultStateDir(),
    dataDir: defaultDataDir(),
    run: runScript,
  };
}

export function liveContextEffect(): Effect.Effect<ToolContext, never, ConfigService> {
  return Effect.gen(function* () {
    const config = yield* ConfigService;
    return {
      binDir: config.binDir,
      stateDir: config.stateDir,
      dataDir: config.dataDir,
      run: runScript,
    };
  });
}
