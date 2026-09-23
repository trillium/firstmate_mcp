/**
 * Registry fragment: installs (slice 16 of the tools.ts folder split, task-8pqjb).
 *
 * Moved verbatim from the TOOLS literal in src/tools.ts. Key order
 * within this fragment matches the canonical order; index.ts spreads
 * fragments in canonical order so tools/list output is unchanged.
 */
import { toolLintVersions, toolToolUpdateCheck, toolVendorAuthProbe, toolStartupMemory, toolStartupNetworkReport, toolDocAudienceCheck, toolHomeSeedValidate, toolStowCascade } from "../installs.js";
import { toolTestIsolationList, toolTestRunList } from "../testlists.js";
import { toolTestRun } from "../testrun.js";
import { approvalSchema } from "./shared.js";
import type { ToolDef } from "./shared.js";

export const InstallsRegistry: Record<string, ToolDef> = {
  lint_versions: {
    description: "Read-only required ShellCheck/actionlint pins from the lint owners (actionlint degrades to an unsupported-probe record when its owning script is retired upstream).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolLintVersions,
  },
  tool_update_check: {
    description: "Read-only watched-tool update report; repairs nothing, installs nothing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolToolUpdateCheck,
  },
  vendor_auth_probe: {
    description: "Read-only bounded vendor auth probe; raw output is classified, never printed.",
    inputSchema: {
      type: "object",
      properties: { probe: { type: "string", enum: ["grok"] } },
      required: ["probe"],
      additionalProperties: false,
    },
    handler: toolVendorAuthProbe,
  },
  startup_memory: {
    description: "Read-only startup-memory budget read or local estimate; never creates config.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["read", "report"], default: "read" },
      },
      additionalProperties: false,
    },
    handler: toolStartupMemory,
  },
  startup_network_report: {
    description: "Read-only deferred startup-network stage report (state + last-run timings); start/run/harvest/wait stay out.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolStartupNetworkReport,
  },
  doc_audience_check: {
    description: "Read-only docs audience-inventory + local-link validation for one home-confined repo root (default: this home).",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Home-relative repo root to check" },
      },
      additionalProperties: false,
    },
    handler: toolDocAudienceCheck,
  },
  home_seed_validate: {
    description: "Read-only secondmate-registry validation; provisioning (clones, markers, leases) stays out.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolHomeSeedValidate,
  },
  stow_cascade: {
    description: "Read-only /stow cascade enumeration: per-home budget report + transport judgement; curation stays with the skill.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolStowCascade,
  },
  test_isolation_list: {
    description: "Read-only isolation-proof topology: proven concurrent candidates or kept-serial exclusions; proof runs stay out.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["candidates", "exclusions"], default: "candidates" },
        pool: { type: "string", description: "Candidate pool: portable or a test-runner family name", default: "portable" },
      },
      additionalProperties: false,
    },
    handler: toolTestIsolationList,
  },
  test_run_list: {
    description: "Read-only test-runner topology: families, lanes, concurrent-safe families, or the parallel coverage guard; suite runs stay out.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["families", "lanes", "concurrent_safe", "coverage"], default: "families" },
      },
      additionalProperties: false,
    },
    handler: toolTestRunList,
  },
  test_run: {
    description:
      "Authority write: run the firstmate behavior-test runner for one selection (all, family, changed, lane, proven-isolated, or explicit scripts); --list and --check-coverage inspect without executing.",
    inputSchema: approvalSchema(
      {
        mode: {
          type: "string",
          enum: ["all", "family", "changed", "lane", "proven-isolated", "scripts"],
          description: "What to run",
        },
        family: { type: "string", description: "Family name for mode=family" },
        lane: { type: "string", description: "Lane name for mode=lane" },
        base: { type: "string", description: "Git ref for mode=changed (defaults to the runner's own base)" },
        scripts: {
          type: "array",
          items: { type: "string" },
          description: "tests/<name>.test.sh paths for mode=scripts",
        },
        list: { type: "boolean", description: "Inspect the selection without executing it" },
        check_coverage: { type: "boolean", description: "Run the parallel coverage guard instead of a suite" },
      },
      ["mode"],
    ),
    handler: toolTestRun,
  },
};
