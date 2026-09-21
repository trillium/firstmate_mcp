/**
 * Composition root for the Effect server.
 *
 * MainLive merges the four service layers so main() provides a single
 * graph: Config (served-home resolution) + Runner (scope-managed
 * subprocess lifecycle) + Audit (tier checks + JSON-lines log) +
 * Envelope (internal ok/err construction). Tool handlers stay
 * Promise-compatible for the stdio wire; the Effect graph is the single
 * source of truth underneath via handleToolsCallEffect/dispatchMessageEffect.
 */
import { Layer } from "effect";
import { AuditLive, AuditService } from "./auth.js";
import { ConfigService, makeConfigLive } from "./config.js";
import { EnvelopeLive, EnvelopeService } from "./envelope.js";
import { FollowOnLive, FollowOnService } from "./followon.js";
import { GrantLive, GrantService } from "./grants.js";
import { RunnerLive, RunnerService } from "./runner.js";

export type AppServices =
  | ConfigService
  | RunnerService
  | AuditService
  | EnvelopeService
  | FollowOnService
  | GrantService;

export const MainLive: Layer.Layer<AppServices, never, never> = Layer.mergeAll(
  makeConfigLive(),
  RunnerLive,
  AuditLive,
  EnvelopeLive,
  FollowOnLive,
  GrantLive,
);

/** Narrower graph for dispatch (config is read eagerly into ToolContext). */
export const DispatchLive: Layer.Layer<AuditService | FollowOnService | GrantService, never, never> =
  Layer.mergeAll(AuditLive, FollowOnLive, GrantLive);
