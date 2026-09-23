/**
 * Home-path helpers (slice 17, task-8pqjb). Moved verbatim from src/tools.ts.
 * Shared by installs + herdr-trust slices.
 */
import path from "node:path";
import type { ToolContext } from "../tools.js";

export function homeRoot(ctx: ToolContext): string {
  return path.resolve(ctx.stateDir, "..");
}

export function confineHomePath(ctx: ToolContext, relPath: string): string | null {
  const home = homeRoot(ctx);
  const resolved = path.resolve(home, relPath);
  if (resolved !== home && resolved.startsWith(home + path.sep)) return resolved;
  return null;
}
