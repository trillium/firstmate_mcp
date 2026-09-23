import { Effect } from "effect";
import { runScript } from "./runner.js";
import { DeniedFlagError } from "./errors.js";

/**
 * The 63 smarts-only tools, in feature-manifest order.
 *
 * SUPPORTED (no approval): fleet_snapshot, backlog, crew_state,
 * status_tail, send_message (+ fleet_poll, the read-only poller, peek,
 * fleet_view, review_diff, bearings_snapshot, wake_drain, guard_check,
 * remote_doctor, remote_file, remote_delta, extension_list,
 * extension_inspect, handoff_status,
 * harness_detect, project_mode, lock_status, lease_check,
 * bearings_board_path, inbox_status, inbox_list, home_summary,
 * home_summary_refresh, contributions_snapshot, contributions_pending,
 * mail_status, mail_read, mail_check, dispatch_resolve, sessionstart_nudge,
 * voice_status, lint_versions, tool_update_check, vendor_auth_probe,
 * startup_memory, startup_network_report, doc_audience_check,
 * home_seed_validate, stow_cascade, test_isolation_list, test_run_list,
 * pr_state, pr_poll, pr_reviewers, arm_policy_check, cd_policy_check,
 * subagent_policy_check, supervision_instructions, quota_choose, relay_poll,
 * plus receipt_submit/receipt_status, the fail-closed async receipts).
 * CHANGED (approval-gated): decision_hold, decision_resolve,
 * lifecycle_interrupt/exit/relaunch/suspend/resume, relay_reply/dismiss/
 * followup, review_decision, scaffold_brief, spawn_crew,
 * secondmate_nudge/restart/report, remote_control, handoff_move,
 * voice_queue, mail_send, session_start, sessionstart_run/cursor,
 * herdr_lab, herdr_ci_cleanup, session_cleanup, claude_trust,
 * agy_trust, claude_stop_autoarm, herdr_eventwait/workspace_move.
 *
 * Refused by the deny-list (no tool, answered unknown): promote_scout,
 * teardown_crew, arm_pr_check, merge_pr, merge_local, daemon_start/stop/
 * restart, watch_start/stop, repo_edit/commit/push/merge, backend_select
 * (the sourced backend-provider library and its backends/*.sh adapters),
 * on_execute, config_push, remote_entrypoint, remote_herdr_guard,
 * remote_provision, remote_seed, inherit_push, remote_inherit,
 * reap_orphans, remote_worker, bootstrap, check_register,
 * check_unregister, agents_md_ensure, install_actionlint, install_herdr,
 * install_shellcheck, install_treehouse, update, workflow_lint,
 * afk_contract, afk_launch, afk_return, afk_start, branch_outcome,
 * branch_prompt, busy_event, kimi_turnend_hook, operational_input,
 * procevent_run, procevent_lavish, procevent_quota, procevent_remote_reply,
 * procevent_when, turnend_guard, turnend_guard_cursor, turnend_guard_grok,
 * wake_grant, watch_checkpoint.
 *
 * Every tool shells to its owning bin/fm-*.sh script and never reimplements
 * firstmate behavior. Wire payloads match the Python server exactly so the
 * shared conformance checks are the referee between the two paths.
 */

export type ToolArgs = Record<string, unknown>;

export interface ToolResult {
  payload: Record<string, unknown>;
  isError: boolean;
}

export type ToolHandler = (args: ToolArgs, ctx: ToolContext) => Promise<ToolResult>;

export interface ToolContext {
  binDir: string;
  stateDir: string;
  dataDir: string;
  run: typeof runScript;
}


// --- Fail-closed async receipts ---
//
// Every tool call returns within SUBPROCESS_TIMEOUT_S (30s): a script that
// cannot finish in time is killed as a whole process group and answered
// with a typed timeout error. Calls that need longer work go through
// receipt_submit, which detaches the run (RECEIPT_TIMEOUT_S budget) and
// returns a pending receipt immediately; receipt_status reports
// running/done/failed with the result attached on completion. Receipt
// records live under the serving home's state dir with RECEIPT_TTL_S expiry,
// so they never leak across homes.

/** Tools whose schemas carry a required per-call approval string. */
// Public re-exports (slice 29 finale, task-8pqjb): the only handler
// names imported from ./tools.js anywhere in the repo. Everything else
// resolves directly from its slice file; the registry assembles itself.
export { toolTestRun } from "./tools/testrun.js";
export { toolPrOpen } from "./tools/landing.js";
export { toolDoctor, missingContractScript } from "./tools/doctor.js";
export { toolFleetSnapshot } from "./tools/fleet-snapshot.js";
import { liveContext, liveContextEffect } from "./tools/context.js";
export { liveContext, liveContextEffect };

// --- Deny-list: empty (all surfaces admitted) ---

export const DENY_LIST: ReadonlySet<string> = new Set([]);

/** Flags no argv builder may ever emit. */
export const DENIED_FLAGS: ReadonlySet<string> = new Set([
  "--key",
  "--raw",
  "--force",
  "--yes",
  "--force-with-lease",
]);

export function argv(...parts: string[]): string[] {
  for (const flag of parts) {
    if (DENIED_FLAGS.has(flag)) throw new Error(`denied flag: ${flag}`);
  }
  return [...parts];
}

/**
 * Effect core for argv: fails with a typed DeniedFlagError instead of
 * throwing. Legacy argv() above delegates to the same check so the
 * thrown message stays byte-identical for existing callers.
 */
export function argvEffect(
  ...parts: string[]
): Effect.Effect<string[], DeniedFlagError> {
  for (const flag of parts) {
    if (DENIED_FLAGS.has(flag)) {
      return Effect.fail(new DeniedFlagError({ flag }));
    }
  }
  return Effect.succeed([...parts]);
}









/** Check if deploy-level release grant is enabled via FM_RELEASE_GRANT. */






// --- Sessions gap area: denied-by-design lifecycle verbs ---
//
// Every verb below spawns, launches, trusts, cleans up, arms, or switches a
// real session/backend, so each stays OUT of doorway ownership: approval-
// gated, classified denied-by-design in manifest/COVERAGE.md, and never
// dispatched in conformance. The backend adapters (backends/*.sh) are
// sourced libraries with no CLI surface, so they are denied without a tool
// under backend_select (see scripts/gen_coverage.py DENY_ALSO) rather than
// behind an invented no-op invocation.







// Canonical registry lives in ./tools/registry/index.ts (slice 16, task-8pqjb).
// Re-exported here so the ./tools.js public surface is unchanged.
export { TOOLS, TOOL_NAMES } from "./tools/registry/index.js";

