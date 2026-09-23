/**
 * Authorization tiers + JSON-lines audit log.
 *
 * Contract (shared with auth/tiers.py and auth/audit.py):
 * - Tier 1 (open reads): fleet_snapshot, backlog, crew_state, status_tail,
 *   fleet_poll, peek, fleet_view, review_diff, bearings_snapshot,
 *   wake_drain, guard_check, remote_doctor, remote_file, remote_delta,
 *   handoff_status, harness_detect, project_mode, lock_status,
 *   lease_check, bearings_board_path, inbox_status, inbox_list,
 *   home_summary, home_summary_refresh, contributions_snapshot, contributions_pending,
 *   mail_status, mail_read, mail_check, voice_status, lint_versions,
 *   tool_update_check, vendor_auth_probe, startup_memory,
 *   startup_network_report, doc_audience_check, home_seed_validate,
 *   stow_cascade, test_isolation_list, test_run_list, pr_state,
 *   pr_poll, pr_reviewers, arm_policy_check, cd_policy_check,
 *   subagent_policy_check, supervision_instructions, quota_choose,
 *   relay_poll, public_followup_pending, public_followup_collect,
 *   tasks_list, tasks_show, tasks_ready, dispatch_resolve, sessionstart_nudge,
 *   extension_list, extension_inspect,
 *   receipt_submit, receipt_status — no approval.
 *   (receipt_submit detaches one call past the 30s budget; authority
 *   targets still need their own nested approval string.)
 * - Tier 2 (reversible steer): send_message — no approval, validated text.
 * - Tier 3 (launch-authorized writes): lifecycle_*, spawn_crew,
 *   scaffold_brief, decision_hold, decision_resolve, decision_release,
 *   decision_complete, review_decision,
 *   secondmate_nudge, secondmate_restart, secondmate_report,
 *   remote_control, handoff_move, voice_queue, session_start,
 *   sessionstart_run, sessionstart_cursor, herdr_lab, herdr_ci_cleanup,
 *   session_cleanup, claude_trust, agy_trust, claude_stop_autoarm,
 *   herdr_eventwait, herdr_workspace_move, bootstrap, check_register,
 *   check_unregister, agents_md_ensure, install_actionlint, install_herdr,
 *   install_shellcheck, install_treehouse, update, workflow_lint,
 *   afk_contract, afk_launch, afk_return, afk_start, branch_outcome,
 *   branch_prompt, busy_event, kimi_turnend_hook, operational_input,
 *   procevent_run, procevent_lavish, procevent_quota,
 *   procevent_remote_reply, procevent_when, turnend_guard,
 *   turnend_guard_cursor, turnend_guard_grok, wake_grant,
 *   watch_checkpoint —
 *   explicit per-call approval required.
 * - Tier 4 (external sends): relay_reply, relay_dismiss, relay_followup,
 *   mail_send —
 *   approval plus relay consent inside the owning scripts.
 * - Forbidden: promote_scout, teardown_crew, arm_pr_check, merge_pr,
 *   merge_local, public_followup_emit, relay_link, fleet_sync,
 *   inactive_reconcile, backlog_receive, session_start, sessionstart_run,
 *   sessionstart_cursor, herdr_lab, herdr_ci_cleanup, session_cleanup,
 *   claude_trust, agy_trust, claude_stop_autoarm, herdr_eventwait,
 *   herdr_workspace_move, backend_select, on_execute, config_push,
 *   remote_entrypoint, remote_herdr_guard, remote_provision, remote_seed,
 *   inherit_push, remote_inherit, reap_orphans, remote_worker,
 *   bootstrap, check_register, check_unregister, agents_md_ensure,
 *   install_actionlint, install_herdr, install_shellcheck,
 *   install_treehouse, update, workflow_lint, afk_contract, afk_launch,
 *   afk_return, afk_start, branch_outcome, branch_prompt, busy_event,
 *   kimi_turnend_hook, operational_input, procevent_run, procevent_lavish,
 *   procevent_quota, procevent_remote_reply, procevent_when,
 *   turnend_guard, turnend_guard_cursor, turnend_guard_grok, wake_grant,
 *   watch_checkpoint — no tool,
 *   refused as unknown.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Context, Effect, Layer } from "effect";
import {
  ApprovalInvalidError,
  ApprovalRequiredError,
  AuditError,
  ForbiddenToolError,
  UnknownToolError,
} from "./errors.js";

// Tier/approval/forbidden tables live in ./auth/tiers.ts (slice 23, task-8pqjb).
import {
  APPROVAL_PREFIX,
  APPROVAL_MAX_CHARS,
  TIER_OPEN,
  TIER_STEER,
  TIER_AUTHORITY,
  TIER_EXTERNAL,
  TIER_FORBIDDEN,
  Tier,
  TOOL_TIERS,
  FORBIDDEN_TOOLS,
  TIER_NAMES,
} from "./auth/tiers.js";
export {
  APPROVAL_PREFIX,
  APPROVAL_MAX_CHARS,
  TIER_OPEN,
  TIER_STEER,
  TIER_AUTHORITY,
  TIER_EXTERNAL,
  TIER_FORBIDDEN,
  Tier,
  TOOL_TIERS,
  FORBIDDEN_TOOLS,
  TIER_NAMES,
};

// Tier queries + check() live in ./auth/tier-check.ts (slice 23, task-8pqjb).
import {
  tierOf,
  requiresApproval,
  validApproval,
  approvalRef,
  CheckReason,
  check,
} from "./auth/tier-check.js";
export {
  tierOf,
  requiresApproval,
  validApproval,
  approvalRef,
  CheckReason,
  check,
};

// --- Audit log (JSON lines) ---

// Audit log primitives live in ./auth/audit-log.ts (slice 23, task-8pqjb).
import {
  AUDIT_VERSION,
  AUDIT_KEYS,
  TransportType,
  AuditLine,
  buildLine,
  formatLine,
  appendAudit,
  readAuditLines,
} from "./auth/audit-log.js";
export {
  AUDIT_VERSION,
  AUDIT_KEYS,
  TransportType,
  AuditLine,
  buildLine,
  formatLine,
  appendAudit,
  readAuditLines,
};
// Effect service + layers live in ./auth/audit-service.ts (slice 23, task-8pqjb).
import {
  AuthCheckError,
  checkEffect,
  appendAuditEffect,
  AuditApi,
  AuditService,
  AuditLive,
  makeTestAuditLayer,
} from "./auth/audit-service.js";
export {
  AuthCheckError,
  checkEffect,
  appendAuditEffect,
  AuditApi,
  AuditService,
  AuditLive,
  makeTestAuditLayer,
};
