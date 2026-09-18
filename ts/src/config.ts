/**
 * Config Service for the Effect composition.
 *
 * Single source for the served-home resolution the whole server shares:
 * binDir/stateDir derived from FM_HOME (or the repo checkout fallback),
 * exactly as constants.ts defines. The Layer reads the environment at
 * acquisition time so stub FM_HOME homes in tests keep working.
 */
import { Context, Layer } from "effect";
import {
  CHECKOUT_ROOT,
  binDir as defaultBinDir,
  dataDir as defaultDataDir,
  homeDir as defaultHomeDir,
  stateDir as defaultStateDir,
} from "./constants.js";

export interface Config {
  readonly homeDir: string;
  readonly binDir: string;
  readonly stateDir: string;
  readonly dataDir: string;
  readonly checkoutRoot: string;
}

export class ConfigService extends Context.Tag("ConfigService")<
  ConfigService,
  Config
>() {}

/** Resolve the live config from the current environment. */
export function resolveConfig(): Config {
  return {
    homeDir: defaultHomeDir(),
    binDir: defaultBinDir(),
    stateDir: defaultStateDir(),
    dataDir: defaultDataDir(),
    checkoutRoot: CHECKOUT_ROOT,
  };
}

/** Live layer: reads FM_HOME / FM_STATE_OVERRIDE at startup. */
export const ConfigLive: Layer.Layer<ConfigService> = Layer.succeed(
  ConfigService,
  ConfigService.of(resolveConfig()),
);

/** Fresh live layer (re-reads env per build — preferred for servers/tests). */
export const makeConfigLive = (): Layer.Layer<ConfigService> =>
  Layer.sync(ConfigService, () => resolveConfig());

/** Test layer with pinned dirs (hermetic stub homes). */
export function makeTestConfig(
  overrides: Partial<Config> = {},
): Layer.Layer<ConfigService> {
  const base = resolveConfig();
  return Layer.succeed(
    ConfigService,
    ConfigService.of({
      homeDir: overrides.homeDir ?? base.homeDir,
      binDir: overrides.binDir ?? base.binDir,
      stateDir: overrides.stateDir ?? base.stateDir,
      dataDir: overrides.dataDir ?? base.dataDir,
      checkoutRoot: overrides.checkoutRoot ?? base.checkoutRoot,
    }),
  );
}
