/**
 * Canonical TOOLS assembly (slice 16, task-8pqjb).
 *
 * Fragments spread in canonical key order, so tools/list output is
 * byte-identical to the single-literal era. TOOL_NAMES derives from the
 * assembled keys exactly as before.
 */
import { FleetRegistry } from "./fleet.js";
import { FleetViewsRegistry } from "./fleet-views.js";
import { RemoteRegistry } from "./remote.js";
import { SessionsRegistry } from "./sessions.js";
import { DigestsRegistry } from "./digests.js";
import { SpawnRegistry } from "./spawn.js";
import { DecisionsRegistry } from "./decisions.js";
import { RelayRegistry } from "./relay.js";
import { VoicemailRegistry } from "./voicemail.js";
import { InstallsRegistry } from "./installs.js";
import { DoctorPrRegistry } from "./doctor-pr.js";
import { PolicyRegistry } from "./policy.js";
import { TasksRegistry } from "./tasks.js";
import { SessionHerdrRegistry } from "./session-herdr.js";
import { MixedRegistry } from "./mixed.js";
import { LandingDaemonRegistry } from "./landing-daemon.js";
import { BeadsRegistry } from "./beads.js";
import { LifecycleGrantsRegistry } from "./lifecycle-grants.js";
import { ReapsRegistry } from "./reaps.js";
import { ArchaeologyRegistry } from "./archaeology.js";
import { ActivityRegistry } from "./activity.js";

import type { ToolDef } from "./shared.js";

export const TOOLS: Record<string, ToolDef> = {
  ...FleetRegistry,
  ...FleetViewsRegistry,
  ...RemoteRegistry,
  ...SessionsRegistry,
  ...DigestsRegistry,
  ...SpawnRegistry,
  ...DecisionsRegistry,
  ...RelayRegistry,
  ...VoicemailRegistry,
  ...InstallsRegistry,
  ...DoctorPrRegistry,
  ...PolicyRegistry,
  ...TasksRegistry,
  ...SessionHerdrRegistry,
  ...MixedRegistry,
  ...LandingDaemonRegistry,
  ...LifecycleGrantsRegistry,
  ...BeadsRegistry,
  ...ReapsRegistry,
  ...ArchaeologyRegistry,
  ...ActivityRegistry,
};

export const TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(TOOLS));
