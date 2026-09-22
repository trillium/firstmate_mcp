/**
 * MCP resources: read-only views of this home, addressed by URI.
 *
 * The doorway has been tools-only, which is a third of the protocol. Resources
 * are the right shape for the things a client wants to *watch* rather than invoke:
 * the published ledger, the cached fleet projections, the self-check report. They
 * are also the honest answer to "what does this home look like right now" without
 * teaching every client a recipe of tool calls and freshness fields.
 *
 * Hard rule: every resource is backed by a **Tier 1 open read**. MCP resource
 * reads carry no approval channel, so a resource must never expose anything the
 * tier model gates — `resources.test.ts` asserts the backing tool is open, and
 * that is why `doctor`, the ledger and the caches are here while every authority
 * write is not.
 */
import { TOOLS, type ToolContext, type ToolResult } from "./tools.js";
import { TIER_OPEN, TIER_STEER, tierOf } from "./auth.js";

export interface ResourceDef {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  /** Backing tool: the resource is a different shape over the same read. */
  tool: string;
  /** Arguments handed to the backing tool. */
  args?: Record<string, unknown>;
}

export const RESOURCES: readonly ResourceDef[] = [
  {
    uri: "firstmate://doctor",
    name: "Doorway self-check",
    description:
      "Whether this doorway can work on this home: contract resolution, envelope budgets, cache and ledger freshness, grants, audit trail, gh availability, with a verdict and reasons.",
    mimeType: "application/json",
    tool: "doctor",
  },
  {
    uri: "firstmate://home-summary",
    name: "Home summary ledger",
    description:
      "The published state/home-summary.json document: counts, holds, decisions, endpoints. Zero exit means a published ledger was parsed.",
    mimeType: "application/json",
    tool: "home_summary",
  },
  {
    uri: "firstmate://fleet/snapshot",
    name: "Fleet snapshot",
    description:
      "The cached whole-fleet snapshot with its freshness stamp (from_cache, stale, snapshot_age_s). Paginated through the fleet_snapshot tool.",
    mimeType: "application/json",
    tool: "fleet_snapshot",
    args: { limit: 200 },
  },
  {
    uri: "firstmate://fleet/bearings",
    name: "Fleet bearings",
    description:
      "The compact bearings projection: in-flight work, open decisions, landed, gates, secondmate freshness.",
    mimeType: "application/json",
    tool: "bearings_snapshot",
  },
  {
    uri: "firstmate://fleet/view",
    name: "Fleet view",
    description: "The rendered human fleet view.",
    mimeType: "text/plain",
    tool: "fleet_view",
  },
  {
    uri: "firstmate://backlog",
    name: "Backlog",
    description: "The backlog projection with task counts and its freshness stamp.",
    mimeType: "application/json",
    tool: "backlog",
  },
];

export function resourceList(): Array<{ uri: string; name: string; description: string; mimeType: string }> {
  return RESOURCES.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType }));
}

/** Resources may only expose ungated reads; the test suite enforces it. */
export function resourceBackingIsOpen(def: ResourceDef): boolean {
  const tier = tierOf(def.tool);
  return tier === TIER_OPEN || tier === TIER_STEER;
}

export type ResourceReadResult =
  | { text: string; mimeType: string }
  | { error: string; expect: string };

export async function readResource(uri: unknown, ctx: ToolContext): Promise<ResourceReadResult | null> {
  if (typeof uri !== "string") return null;
  const def = RESOURCES.find((candidate) => candidate.uri === uri);
  if (def === undefined) return null;
  if (!resourceBackingIsOpen(def)) {
    return {
      error: "resource not readable",
      expect: `a resource backed by an open read; ${def.tool} is gated and has no resource form`,
    };
  }
  const handler = TOOLS[def.tool]?.handler;
  if (handler === undefined) {
    return { error: "resource backing tool missing", expect: `tool ${def.tool} to exist` };
  }
  const result: ToolResult = await handler(def.args ?? {}, ctx);
  const payload = result.payload as Record<string, unknown>;
  if (result.isError) {
    // A resource read that fails (a stale-only cache, an unpublished ledger) still
    // returns text: the reason is the content a client needs to see.
    return { text: JSON.stringify(payload, null, 2), mimeType: def.mimeType };
  }
  if (def.mimeType === "text/plain") {
    const stdout = def.tool === "fleet_view" ? (payload["stdout"] as string | undefined) : undefined;
    return { text: stdout ?? String(payload["stdout"] ?? ""), mimeType: def.mimeType };
  }
  return { text: JSON.stringify(payload, null, 2), mimeType: def.mimeType };
}
