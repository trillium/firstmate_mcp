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
import { randomBytes, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import {
  APPROVAL_PREFIX,
  BEARINGS_SCHEMA,
  BRIEF_MODES,
  HANDOFF_DEFAULT_LINES,
  HANDOFF_KEYS_MAX,
  HARNESS_MODES,
  HOME_SUMMARY_SCHEMA,
  MAX_OUTPUT_BYTES,
  MODES,
  CHECKOUT_ROOT,
  SUBPROCESS_TIMEOUT_S,
  ARTIFACT_DIRNAME,
  ARTIFACT_TTL_S,
  DEFAULT_PR_BASE,
  PR_BODY_MAX_BYTES,
  PR_TITLE_MAX_CHARS,
  PR_URL_RE,
  resolveGhBin,
  RECEIPT_DIRNAME,
  RECEIPT_TIMEOUT_S,
  RECEIPT_TTL_S,
  REMOTE_CONTROL_VERBS,
  REMOTE_FILE_DEFAULT_MAX_BYTES,
  RESTART_IDS_MAX,
  SEND_TEXT_MAX_CHARS,
  SNAPSHOT_DEFAULT_LIMIT,
  SNAPSHOT_DIRNAME,
  SNAPSHOT_MAX_LIMIT,
  SNAPSHOT_MIN_LIMIT,
  SNAPSHOT_SCHEMA,
  SNAPSHOT_TTL_S,
  VERDICTS,
  YOLO,
  binDir as defaultBinDir,
  dataDir as defaultDataDir,
  stateDir as defaultStateDir,
} from "./constants.js";
import { ownedCall, runScript, truncate, byteLength, isRunResult } from "./runner.js";
import {
  TIER_AUTHORITY,
  tierOf,
  TIER_STEER,
  TIER_OPEN,
  TIER_EXTERNAL,
  TOOL_TIERS,
  requiresApproval,
  TIER_FORBIDDEN,
  FORBIDDEN_TOOLS,
  type Tier,
} from "./auth.js";
import {
  approvalError,
  checkAuthorization,
  listGrants,
  mintGrant,
  requireAuth,
  revokeGrant,
  getGrantStatus,
  type MintGrantParams,
  type GrantTier,
} from "./grants.js";
import {
  confineHandoffPath,
  confineStatePath,
  validApproval,
  validBranchName,
  validCommitMessage,
  validCorr,
  validDeltaWait,
  validExtensionId,
  validFileContent,
  validHandoffLines,
  validId,
  validIdList,
  validMailBody,
  validMailSubject,
  validMailTo,
  validMergeMethod,
  validNonnegInt,
  validNote,
  validPageLimit,
  parseSnapshotCursor,
  validPeekLines,
  validProbe,
  validProject,
  validPrUrl,
  validPolicyCommand,
  validQuotaCandidates,
  validQuotaSnapshot,
  validRelpath,
  validBaseBranch,
  validGitRef,
  validPrBody,
  validPrTitle,
  validSubagentTool,
  validTestFamily,
  validTestLane,
  validTestRunMode,
  validTestScriptPath,
  validSupervisionAfkMode,
  validSupervisionHarness,
  validRemoteMaxBytes,
  validSha256,
  validStartupMode,
  validStatusLines,
  validTestIsolationMode,
  validTestRunListMode,
  validIsolationPool,
  validVoiceQueueText,
  validVoiceScope,
} from "./validators.js";
import { DeniedFlagError } from "./errors.js";
import { ConfigService } from "./config.js";

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

export function liveContext(): ToolContext {
  return {
    binDir: defaultBinDir(),
    stateDir: defaultStateDir(),
    dataDir: defaultDataDir(),
    run: runScript,
  };
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
// Receipt store + submit/status live in ./tools/receipts.ts (slice 15, task-8pqjb).
// Imported for the TOOLS registry below; module-private as before.
import {
  toolReceiptSubmit,
  toolReceiptStatus,
} from "./tools/receipts.js";
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

// approvalError + requireAuth live in ./grants.js (slice 3, task-8pqjb).
// Snapshot cache primitives live in ./tools/fleet-cache.ts (slice 10, task-8pqjb).
// Imported by sibling slices and the doctor freshness read.
import {
  latestCachedSnapshotId,
  readCachedSnapshot,
} from "./tools/fleet-cache.js";
// Snapshot fetch + read live in ./tools/fleet-snapshot.ts (slice 10, task-8pqjb).
// Imported for the TOOLS registry below; module-private as before.
import {
  toolFleetSnapshot,
} from "./tools/fleet-snapshot.js";
export { toolFleetSnapshot };
// Backlog read lives in ./tools/fleet-backlog.ts (slice 10, task-8pqjb).
// Imported for the TOOLS registry below; module-private as before.
import {
  toolBacklog,
} from "./tools/fleet-backlog.js";

// Crew/status/steer/peek reads live in ./tools/fleet-reads.ts (slice 10, task-8pqjb).
// Imported for the TOOLS registry below; module-private as before.
import {
  toolCrewState,
  toolStatusTail,
  toolSendMessage,
  toolPeek,
} from "./tools/fleet-reads.js";

// Cached whole-home projections live in ./tools/fleet-views.ts (slice 11, task-8pqjb).
// Imported for the TOOLS registry below; module-private as before.
import {
  toolFleetView,
  toolReviewDiff,
  toolBearingsSnapshot,
} from "./tools/fleet-views.js";
// Wake/guard, remote, extension, handoff reads live in ./tools/remote-reads.ts (slice 11, task-8pqjb).
// Imported for the TOOLS registry below; module-private as before.
import {
  toolWakeDrain,
  toolGuardCheck,
  toolRemoteDoctor,
  toolRemoteFile,
  toolRemoteDelta,
  toolExtensionList,
  toolExtensionInspect,
  toolHandoffStatus,
} from "./tools/remote-reads.js";

// --- Wave 3: session + digest reads (Tier 1, no approval) ---
//
// Pure status projections only. Session-start orchestration
// (fm-session-start.sh, fm-sessionstart-run.sh and its transports),
// Herdr lifecycle (fm-herdr-lab.sh, *-cleanup.sh), spawn trust
// preregistration (fm-claude-trust.sh, fm-agy-trust.sh), the networked
// dispatch resolver, watcher checkpoint runs, and lock/lease acquisition
// all stay out; the owning scripts still fail closed on anything refused.
// Session handlers live in ./tools/sessions.ts (slice 8, task-8pqjb).
// Imported for the TOOLS registry below; module-private as before.
import {
  toolHarnessDetect,
  toolProjectMode,
  toolLockStatus,
  toolLeaseCheck,
} from "./tools/sessions.js";
// Bearings/inbox/home-summary reads live in ./tools/digests.ts (slice 9, task-8pqjb).
// Imported for the TOOLS registry below; module-private as before.
import {
  toolBearingsBoardPath,
  toolInboxStatus,
  toolInboxList,
  toolHomeSummary,
} from "./tools/digests.js";

// Home-summary refresh + contributions live in ./tools/digests-write.ts (slice 9, task-8pqjb).
// Imported for the TOOLS registry below; module-private as before.
import {
  lifecycleTool,
  toolHomeSummaryRefresh,
  toolContributionsSnapshot,
  toolContributionsPending,
} from "./tools/digests-write.js";

// Crew spawn + brief scaffolding live in ./tools/spawn.ts (slice 12, task-8pqjb).
// Imported for the TOOLS registry below; module-private as before.
import {
  toolSpawnCrew,
  toolScaffoldBrief,
} from "./tools/spawn.js";

// Decision hold lives in ./tools/decisions-hold.ts (slice 7, task-8pqjb).
// Imported for the TOOLS registry below; module-private as before.
import {
  toolDecisionHold,
} from "./tools/decisions-hold.js";

let tmpCounter = 0;
export function writeTempFile(content: string): string {
  tmpCounter += 1;
  const tmp = path.join(
    os.tmpdir(),
    `fm-mcp-ts-${process.pid}-${Date.now()}-${tmpCounter}.md`,
  );
  fs.writeFileSync(tmp, content, "utf8");
  return tmp;
}

export function removeTempFile(tmp: string): void {
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* best effort */
  }
}

/** Compute SHA-256 hex digest for decision text. */
export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Check if deploy-level release grant is enabled via FM_RELEASE_GRANT. */
export function isReleaseGrantEnabled(): boolean {
  const grant = process.env.FM_RELEASE_GRANT;
  if (!grant) return false;
  const normalized = grant.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "on" ||
    normalized === "yes" ||
    normalized === "all" ||
    normalized === "enable" ||
    normalized === "enabled"
  );
}

/**
 * Determine if release of a hold is authorized under the SAFETY CORE:
 * Default scope permits releasing ONLY holds the calling agent opened itself.
 * Captain-opened or third-party holds refuse unless explicit deploy release grant is ON.
 */
export async function isReleaseAuthorized(
  callerActor: string,
  originId: string | undefined,
  taskId: string | undefined,
  ctx: ToolContext,
): Promise<{ authorized: boolean; reason?: string; author?: string | null }> {
  if (isReleaseGrantEnabled()) {
    return { authorized: true, author: "(grant-enabled)" };
  }

  // If originId was provided explicitly:
  if (originId) {
    if (callerActor === originId) {
      return { authorized: true, author: originId };
    }
    return {
      authorized: false,
      author: originId,
      reason: `release refused: caller '${callerActor}' did not author hold for origin '${originId}' (default scope permits self-holds only; captain-opened or third-party holds require FM_RELEASE_GRANT=1)`,
    };
  }

  // If taskId was provided:
  if (taskId) {
    // Check if taskId matches <origin>-decision-<key> format:
    const match = taskId.match(/^([a-zA-Z0-9._-]+)-decision-[a-zA-Z0-9._-]+$/);
    if (match) {
      const author = match[1];
      if (callerActor === author) {
        return { authorized: true, author };
      }
      return {
        authorized: false,
        author,
        reason: `release refused: caller '${callerActor}' did not author hold '${taskId}' (authored by '${author}'; default scope permits self-holds only; captain-opened or third-party holds require FM_RELEASE_GRANT=1)`,
      };
    }

    // Otherwise check if task metadata or task body carries Origin: <origin>
    // 1. Check if state/<taskId>.meta has origin=
    const metaPath = path.join(ctx.stateDir, `${taskId}.meta`);
    try {
      if (fs.existsSync(metaPath)) {
        const content = fs.readFileSync(metaPath, "utf8");
        const originMatch = content.match(/^origin=([a-zA-Z0-9._-]+)/m);
        if (originMatch) {
          const author = originMatch[1];
          if (callerActor === author) {
            return { authorized: true, author };
          }
          return {
            authorized: false,
            author,
            reason: `release refused: caller '${callerActor}' did not author hold '${taskId}' (authored by '${author}'; default scope permits self-holds only; captain-opened or third-party holds require FM_RELEASE_GRANT=1)`,
          };
        }
      }
    } catch {
      /* ignore file read error, fall through to task check */
    }

    // 2. Query task show
    try {
      const res = await ctx.run(argv(path.join(ctx.binDir, "fm-tasks-axi.sh"), "show", taskId, "--full"));
      if (isRunResult(res) && res.exitCode === 0) {
        const bodyMatch = res.stdout.match(/Origin:\s*([a-zA-Z0-9._-]+)/);
        if (bodyMatch) {
          const author = bodyMatch[1];
          if (callerActor === author) {
            return { authorized: true, author };
          }
          return {
            authorized: false,
            author,
            reason: `release refused: caller '${callerActor}' did not author hold '${taskId}' (authored by '${author}'; default scope permits self-holds only; captain-opened or third-party holds require FM_RELEASE_GRANT=1)`,
          };
        }
      }
    } catch {
      /* task query failed */
    }

    // No origin found -> captain-opened hold
    return {
      authorized: false,
      author: null,
      reason: `release refused: captain-opened hold '${taskId}' cannot be released by caller '${callerActor}' (default scope permits self-holds only; captain-opened holds require FM_RELEASE_GRANT=1)`,
    };
  }

  return {
    authorized: false,
    author: null,
    reason: "release refused: cannot determine hold authorship (origin_id or task id required)",
  };
}

// Decision resolve/release live in ./tools/decisions-release.ts (slice 7, task-8pqjb).
// Imported for the TOOLS registry below; module-private as before.
import {
  toolDecisionResolve,
  toolDecisionRelease,
} from "./tools/decisions-release.js";

// Review-decision lives in ./tools/decisions-review.ts (slice 7, task-8pqjb).
// Imported for the TOOLS registry below; module-private as before.
import {
  toolReviewDecision,
} from "./tools/decisions-review.js";

// Decision complete/verify/open/diverged live in ./tools/decisions-attest.ts (slice 7, task-8pqjb).
// Imported for the TOOLS registry below; module-private as before.
import {
  toolDecisionComplete,
  toolDecisionVerify,
  toolDecisionOpen,
  toolDecisionDiverged,
} from "./tools/decisions-attest.js";
// Relay handlers live in ./tools/relay.ts (slice 5, task-8pqjb).
// Imported for the TOOLS registry below; module-private as before.
import {
  toolRelayReply,
  toolRelayDismiss,
  toolRelayFollowup,
} from "./tools/relay.js";
// --- CHANGED: secondmate / remote authority writes (Tier 3, approval) ---
// Secondmate/remote/handoff handlers live in ./tools/secondmate.ts (slice 6, task-8pqjb).
// Imported for the TOOLS registry below; module-private as before.
import {
  toolSecondmateNudge,
  toolSecondmateRestart,
  toolSecondmateReport,
  toolRemoteControl,
  toolHandoffMove,
  toolFleetPoll,
} from "./tools/secondmate.js";
// --- Wave 4: installs, voice/mail, and small PR/relay gaps ---
// Voice/mail handlers live in ./tools/voicemail.ts (slice 3, task-8pqjb).
// Imported for the TOOLS registry below; module-private as before.
import {
  toolMailStatus,
  toolMailRead,
  toolMailCheck,
  toolMailSend,
  toolVoiceStatus,
  toolVoiceQueue,
} from "./tools/voicemail.js";// Installs handlers live in ./tools/installs.ts (slice 4, task-8pqjb).
// Imported for the TOOLS registry below; module-private as before.
import {
  toolLintVersions,
  toolToolUpdateCheck,
  toolVendorAuthProbe,
  toolStartupMemory,
  toolStartupNetworkReport,
  toolDocAudienceCheck,
  toolHomeSeedValidate,
  toolStowCascade,
} from "./tools/installs.js";
import {
  toolTestIsolationList,
  toolTestRunList,
} from "./tools/testlists.js";
// Test-run execution lives in ./tools/testrun.ts (slice 15, task-8pqjb).
// Imported for the TOOLS registry below and re-exported, public as before.
import {
  toolTestRun,
} from "./tools/testrun.js";
export {
  toolTestRun,
};
// Doctor read + contract resolution live in ./tools/doctor.ts (slice 15, task-8pqjb).
// Imported for the TOOLS registry below and re-exported, public as before.
import {
  toolDoctor,
  missingContractScript,
} from "./tools/doctor.js";
export {
  toolDoctor,
  missingContractScript,
};
import {
  classifyCall,
  toolPrState,
  toolPrPoll,
  toolRelayPoll,
  toolPrReviewers,
} from "./tools/pr-reads.js";

// Policy/quota/followup reads live in ./tools/policy.ts (slice 13, task-8pqjb).
// Imported for the TOOLS registry below; module-private as before.
import {
  toolArmPolicyCheck,
  toolCdPolicyCheck,
  toolSubagentPolicyCheck,
  toolSupervisionInstructions,
  toolQuotaChoose,
  toolPublicFollowupPending,
  toolPublicFollowupCollect,
} from "./tools/policy.js";

// Denied-by-design handlers live in ./tools/denied.ts (slice 13, task-8pqjb).
// Imported for the TOOLS registry below; re-exported, public as before.
import {
  toolPublicFollowupEmit,
  toolRelayLink,
  toolFleetSync,
  toolInactiveReconcile,
} from "./tools/denied.js";
export {
  toolPublicFollowupEmit,
  toolRelayLink,
  toolFleetSync,
  toolInactiveReconcile,
};

// Task-store reads + backlog receive/dispatch/nudge live in ./tools/tasks.ts (slice 13, task-8pqjb).
// Imported for the TOOLS registry below; re-exported, public as before.
import {
  toolTasksList,
  toolTasksShow,
  toolTasksReady,
  toolBacklogReceive,
  toolDispatchResolve,
  toolSessionstartNudge,
} from "./tools/tasks.js";
export {
  toolTasksList,
  toolTasksShow,
  toolTasksReady,
  toolBacklogReceive,
  toolDispatchResolve,
  toolSessionstartNudge,
};
// --- Sessions gap area: denied-by-design lifecycle verbs ---
//
// Every verb below spawns, launches, trusts, cleans up, arms, or switches a
// real session/backend, so each stays OUT of doorway ownership: approval-
// gated, classified denied-by-design in manifest/COVERAGE.md, and never
// dispatched in conformance. The backend adapters (backends/*.sh) are
// sourced libraries with no CLI surface, so they are denied without a tool
// under backend_select (see scripts/gen_coverage.py DENY_ALSO) rather than
// behind an invented no-op invocation.

export function homeRoot(ctx: ToolContext): string {
  return path.resolve(ctx.stateDir, "..");
}

export function confineHomePath(ctx: ToolContext, relPath: string): string | null {
  const home = homeRoot(ctx);
  const resolved = path.resolve(home, relPath);
  if (resolved !== home && resolved.startsWith(home + path.sep)) return resolved;
  return null;
}

// Session start/run/cursor + lab live in ./tools/session-start.ts (slice 14, task-8pqjb).
// Imported for the TOOLS registry below and re-exported, public as before.
import {
  toolSessionStart,
  toolSessionstartRun,
  toolSessionstartCursor,
  toolHerdrLab,
} from "./tools/session-start.js";
export {
  toolSessionStart,
  toolSessionstartRun,
  toolSessionstartCursor,
  toolHerdrLab,
};

// Herdr cleanup/trust/event/workspace live in ./tools/herdr-trust.ts (slice 14, task-8pqjb).
// Imported for the TOOLS registry below and re-exported, public as before.
import {
  toolHerdrCiCleanup,
  toolSessionCleanup,
  toolClaudeTrust,
  toolAgyTrust,
  toolClaudeStopAutoarm,
  toolHerdrEventwait,
  toolHerdrWorkspaceMove,
} from "./tools/herdr-trust.js";
export {
  toolHerdrCiCleanup,
  toolSessionCleanup,
  toolClaudeTrust,
  toolAgyTrust,
  toolClaudeStopAutoarm,
  toolHerdrEventwait,
  toolHerdrWorkspaceMove,
};

// --- Registry (schemas match the Python server's tools/list exactly) ---

export interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

function approvalSchema(extra: Record<string, unknown>, required?: string[]): Record<string, unknown> {
  const properties = { ...extra };
  (properties as Record<string, unknown>)["approval"] = {
    type: "string",
    description: "Explicit authorization starting with 'I authorize'",
  };
  return {
    type: "object",
    properties,
    required: required !== undefined ? [...required, "approval"] : [...Object.keys(extra), "approval"],
    additionalProperties: false,
  };
}

function idApprovalSchema(idField = "id"): Record<string, unknown> {
  return approvalSchema({ [idField]: { type: "string", description: "Task id" } });
}
// Landing-chain handlers live in ./tools/landing.ts (slice 2, task-8pqjb).
// Imported for the TOOLS registry below and re-exported so the ./tools.js
// public surface is unchanged.
import {
  toolPromoteScout,
  toolTeardownCrew,
  toolArmPrCheck,
  toolMergePr,
  toolMergeLocal,
  toolRepoEdit,
  toolRepoCommit,
  toolRepoPush,
  toolRepoMerge,
  toolPrOpen,
} from "./tools/landing.js";
export {
  toolPromoteScout,
  toolTeardownCrew,
  toolArmPrCheck,
  toolMergePr,
  toolMergeLocal,
  toolRepoEdit,
  toolRepoCommit,
  toolRepoPush,
  toolRepoMerge,
  toolPrOpen,
};
// Daemon & watch handlers live in ./tools/daemon.ts (slice 1, task-8pqjb).
// Imported for the TOOLS registry below and re-exported so the ./tools.js
// public surface is unchanged.
import {
  toolDaemonRestart,
  toolDaemonStart,
  toolDaemonStatus,
  toolDaemonStop,
  toolWatchStart,
  toolWatchStop,
} from "./tools/daemon.js";
export {
  toolDaemonRestart,
  toolDaemonStart,
  toolDaemonStatus,
  toolDaemonStop,
  toolWatchStart,
  toolWatchStop,
};

// Lifecycle primitives live in ./tools/lifecycle.ts (slice 14, task-8pqjb).
// Imported for the TOOLS registry below and re-exported, public as before.
import {
  toolTaskIntake,
  toolWorktreeAllocate,
  toolLifecycleDrive,
  toolReviewGate,
  toolReconcileUpstream,
} from "./tools/lifecycle.js";
export {
  toolTaskIntake,
  toolWorktreeAllocate,
  toolLifecycleDrive,
  toolReviewGate,
  toolReconcileUpstream,
};

// Standing-grant mint/revoke/status live in ./tools/grant-tools.ts (slice 14, task-8pqjb).
// Imported for the TOOLS registry below and re-exported, public as before.
import {
  toolGrantMint,
  toolGrantRevoke,
  toolGrantStatus,
} from "./tools/grant-tools.js";
export {
  toolGrantMint,
  toolGrantRevoke,
  toolGrantStatus,
};

export const TOOLS: Record<string, ToolDef> = {
  fleet_snapshot: {
    description:
      "Read-only canonical fleet snapshot (backlog plus per-task state), with optional cursor pagination.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: {
          type: "string",
          description:
            "Optional pagination cursor (<snapshot_id>:<offset> or integer offset) into a cached snapshot",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          default: 50,
          description: "Maximum task rows per page",
        },
        snapshot_id: {
          type: "string",
          description:
            "Optional cached snapshot id to paginate across without re-running the snapshot script",
        },
      },
      additionalProperties: false,
    },
    handler: toolFleetSnapshot,
  },
  backlog: {
    description:
      "Read-only backlog records plus per-state task counts, derived from the fleet snapshot, with optional cursor pagination.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: {
          type: "string",
          description:
            "Optional pagination cursor (<snapshot_id>:<offset> or integer offset) into a cached snapshot",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          default: 50,
          description: "Maximum task rows per page",
        },
        snapshot_id: {
          type: "string",
          description:
            "Optional cached snapshot id to paginate across without re-running the snapshot script",
        },
      },
      additionalProperties: false,
    },
    handler: toolBacklog,
  },
  crew_state: {
    description:
      "Read-only deterministic current state of one crew; never infer state from the status log tail.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Task id" } },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolCrewState,
  },
  status_tail: {
    description: "Read-only tail of one task wake-event log; history only, not current state.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id" },
        lines: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolStatusTail,
  },
  peek: {
    description: "Read-only bounded tail of one crew endpoint for cheap diagnosis.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Exact task id" },
        lines: { type: "integer", minimum: 1, maximum: 100, default: 40 },
      },
      required: ["target"],
      additionalProperties: false,
    },
    handler: toolPeek,
  },
  fleet_view: {
    description: "Read-only human render of the fleet snapshot for operators.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolFleetView,
  },
  review_diff: {
    description: "Read-only branch-vs-base diff for one task worktree.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id" },
        stat: { type: "boolean", description: "Stat summary only", default: false },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolReviewDiff,
  },
  bearings_snapshot: {
    description:
      "Read-only compact pick-up digest projected from the fleet snapshot (local-only).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolBearingsSnapshot,
  },
  wake_drain: {
    description: "Read-only drained-wake records from the durable watcher queue.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolWakeDrain,
  },
  guard_check: {
    description: "Read-only watcher liveness and worktree-tangle verdict.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolGuardCheck,
  },
  remote_doctor: {
    description:
      "Read-only remote-home readiness diagnostic (check mode; repairs stay out).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolRemoteDoctor,
  },
  remote_file: {
    description:
      "Read-only bounded read of one home-relative file (get only; intake stays out).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Home-relative file path" },
        max_bytes: { type: "integer", minimum: 1, maximum: 262144, default: 8192 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: toolRemoteFile,
  },
  remote_delta: {
    description: "Read-only continuity-checked delta read of one append-only log.",
    inputSchema: {
      type: "object",
      properties: {
        log: { type: "string", description: "Home-relative log path" },
        offset: { type: "integer", minimum: 0, description: "Byte cursor", default: 0 },
        sha256: { type: "string", description: "64 hex chars of the exact prefix" },
        wait: { type: "integer", minimum: 0, maximum: 10, default: 0 },
      },
      required: ["log", "sha256"],
      additionalProperties: false,
    },
    handler: toolRemoteDelta,
  },
  extension_list: {
    description: "Read-only list of enabled home-local extension bindings (bind/retire/verify/process-event stay out).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolExtensionList,
  },
  extension_inspect: {
    description: "Read-only deterministic JSON for one enabled home-local extension binding.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Extension id [a-z0-9]+([.-][a-z0-9]+)*" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolExtensionInspect,
  },
  handoff_status: {
    description:
      "Read-only staged handoff outboxes: list staged moves, or read one outbox tail.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Secondmate id" },
        lines: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      },
      additionalProperties: false,
    },
    handler: toolHandoffStatus,
  },
  harness_detect: {
    description:
      "Read-only harness detection for this home; closed mode subset, never walks process ancestry.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["own", "crew", "secondmate", "secondmate-model", "secondmate-effort"],
          default: "own",
        },
      },
      additionalProperties: false,
    },
    handler: toolHarnessDetect,
  },
  project_mode: {
    description: "Read-only registered delivery posture (mode + yolo) for one project.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "Bare name or projects/<name>" } },
      required: ["project"],
      additionalProperties: false,
    },
    handler: toolProjectMode,
  },
  lock_status: {
    description: "Read-only per-home session lock status; acquiring stays out.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolLockStatus,
  },
  lease_check: {
    description: "Read-only per-task supervision lease check; claim/release/sweep stay out.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Task id" } },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolLeaseCheck,
  },
  bearings_board_path: {
    description:
      "Read-only stable path of the captain's bearings board; building/arming stays out.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolBearingsBoardPath,
  },
  inbox_status: {
    description: "Read-only captain inbox status from durable records; sends no wake.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolInboxStatus,
  },
  inbox_list: {
    description: "Read-only list of queued captain inbox notes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolInboxList,
  },
  home_summary: {
    description: "Read-only published home-summary ledger; refresh stays firstmate-owned.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolHomeSummary,
  },
  home_summary_refresh: {
    description:
      "Atomically refresh and publish state/home-summary.json for this FM_HOME.",
    inputSchema: {
      type: "object",
      properties: {
        best_effort: {
          type: "boolean",
          description: "Log failures to .home-summary-refresh.log and exit 0",
          default: false,
        },
      },
      additionalProperties: false,
    },
    handler: toolHomeSummaryRefresh,
  },
  contributions_snapshot: {
    description:
      "Read-only owned-contribution coverage projected from the fleet snapshot; never contacts a forge.",
    inputSchema: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "Include rows for supervisor inspection", default: false },
      },
      additionalProperties: false,
    },
    handler: toolContributionsSnapshot,
  },
  contributions_pending: {
    description: "Read-only pending contribution event tokens from saved records.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolContributionsPending,
  },
  send_message: {
    description:
      "Steer one crew with a single verified prose line; slash commands, keys, raw panes, and lifecycle verbs are refused.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Exact task id" },
        text: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["target", "text"],
      additionalProperties: false,
    },
    handler: toolSendMessage,
  },
  lifecycle_interrupt: {
    description:
      "Authority write: deliver the harness interrupt sequence to one crew; agent keeps running.",
    inputSchema: idApprovalSchema(),
    handler: (args, ctx) => lifecycleTool(args, ctx, "interrupt", false),
  },
  lifecycle_exit: {
    description:
      "Authority write: stop one agent, preserving its endpoint, worktree, and uncommitted changes.",
    inputSchema: idApprovalSchema(),
    handler: (args, ctx) => lifecycleTool(args, ctx, "exit", false),
  },
  lifecycle_relaunch: {
    description:
      "Authority write: transactionally replace one running agent in the same endpoint and worktree.",
    inputSchema: approvalSchema({
      id: { type: "string", description: "Task id" },
      note: { type: "string", description: "Progress note, single line 1..500 chars" },
    }),
    handler: (args, ctx) => lifecycleTool(args, ctx, "relaunch", true),
  },
  lifecycle_suspend: {
    description: "Authority write: park one persistent secondmate with a durable note.",
    inputSchema: approvalSchema({
      id: { type: "string", description: "Task id" },
      note: { type: "string", description: "Park note, single line 1..500 chars" },
    }),
    handler: (args, ctx) => lifecycleTool(args, ctx, "suspend", true),
  },
  lifecycle_resume: {
    description: "Authority write: restore one parked secondmate with a durable note.",
    inputSchema: approvalSchema({
      id: { type: "string", description: "Task id" },
      note: { type: "string", description: "Resume note, single line 1..500 chars" },
    }),
    handler: (args, ctx) => lifecycleTool(args, ctx, "resume", true),
  },
  spawn_crew: {
    description:
      "Authority write: spawn one direct report via fm-spawn.sh with an explicit delivery contract.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      project: { type: "string", description: "Bare name or projects/<name>" },
      mode: { type: "string", enum: [...MODES] },
      yolo: { type: "string", enum: ["on", "off"] },
    }),
    handler: toolSpawnCrew,
  },
  scaffold_brief: {
    description:
      "Authority write: scaffold one crewmate brief via fm-brief.sh; does not launch anything.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      project: { type: "string", description: "Bare name or projects/<name>" },
      mode: { type: "string", enum: [...BRIEF_MODES] },
    }),
    handler: toolScaffoldBrief,
  },
  decision_hold: {
    description:
      "Authority write: record one durable captain-held decision via fm-decision-hold.sh hold.",
    inputSchema: approvalSchema({
      origin_id: { type: "string" },
      decision_key: { type: "string", description: "Short slug" },
      title: { type: "string" },
      reason: { type: "string" },
    }),
    handler: toolDecisionHold,
  },
  decision_resolve: {
    description:
      "Authority write: resolve one held decision via fm-decision-hold.sh resolve with a decision file.",
    inputSchema: approvalSchema({
      origin_id: { type: "string" },
      decision_key: { type: "string" },
      routed_to: { type: "string", description: "Task id receiving the decision" },
      decision_text: { type: "string", description: "Decision record, 1..2000 chars" },
    }),
    handler: toolDecisionResolve,
  },
  decision_release: {
    description:
      "Authority write: release one captain hold via fm-decision-hold.sh resolve or fm-captain-hold.sh answer --release with a durable decision record.",
    inputSchema: approvalSchema({
      origin_id: { type: "string", description: "Origin task id for composed hold" },
      decision_key: { type: "string", description: "Short slug when origin_id is given" },
      id: { type: "string", description: "Direct task id to release" },
      routed_to: { type: "string", description: "Task id receiving the decision" },
      decision_text: { type: "string", description: "Decision record, 1..2000 chars" },
    }),
    handler: toolDecisionRelease,
  },
  decision_complete: {
    description:
      "Authority write: attest the reviewed inventory of captain-held tasks for an origin via fm-captain-hold.sh complete.",
    inputSchema: approvalSchema({
      origin_id: { type: "string", description: "Origin task id" },
      none: { type: "boolean", description: "Explicit attestation that no captain decisions remain" },
      task_ids: {
        type: "array",
        items: { type: "string" },
        description: "List of captain-held task ids or keys",
      },
    }),
    handler: toolDecisionComplete,
  },
  decision_verify: {
    description:
      "Open read: verify that an origin has completed its captain-call inventory and no open keyed decisions remain via fm-captain-hold.sh verify.",
    inputSchema: {
      type: "object",
      properties: {
        origin_id: { type: "string", description: "Origin task id" },
      },
      required: ["origin_id"],
      additionalProperties: false,
    },
    handler: toolDecisionVerify,
  },
  decision_open: {
    description:
      "Open read: check if a captain-held task is still open, optionally retrieving its lifecycle identity via fm-captain-hold.sh open.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id" },
        identity: { type: "boolean", description: "Retrieve lifecycle identity" },
        distinguish_absent: { type: "boolean", description: "Distinguish absent tasks from not-open tasks" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolDecisionOpen,
  },
  decision_diverged: {
    description:
      "Open read: check for divergence between status log decisions and durable captain holds via fm-captain-hold.sh diverged.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: toolDecisionDiverged,
  },
  review_decision: {
    description:
      "Authority write: record one captain approve, decline, or comment via fm-captain-hold.sh answer with a decision file.",
    inputSchema: approvalSchema({
      id: { type: "string" },
      verdict: { type: "string", enum: [...VERDICTS] },
      comment: { type: "string", description: "Optional single-line comment" },
      release: { type: "boolean", description: "Release hold so held work resumes (tasks-axi unhold) instead of closing task" },
    }),
    handler: toolReviewDecision,
  },
  relay_reply: {
    description: "External send: post one public-safe reply to the relay via fm-x-reply.sh.",
    inputSchema: approvalSchema({
      request_id: { type: "string" },
      text: { type: "string", description: "Reply text, 1..2000 chars" },
    }),
    handler: toolRelayReply,
  },
  relay_dismiss: {
    description:
      "External send: dismiss one pending relay mention without replying via fm-x-dismiss.sh.",
    inputSchema: idApprovalSchema("request_id"),
    handler: toolRelayDismiss,
  },
  relay_followup: {
    description:
      "External send: post one completion follow-up for a relay-linked task via fm-x-followup.sh.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      text: { type: "string", description: "Follow-up text, 1..2000 chars" },
      final: { type: "boolean", description: "Clear the link after this post" },
    }),
    handler: toolRelayFollowup,
  },
  secondmate_nudge: {
    description:
      "Authority write: ask mismatched secondmates to reconcile via the cooldown-guarded notify path.",
    inputSchema: approvalSchema({}),
    handler: toolSecondmateNudge,
  },
  secondmate_restart: {
    description:
      "Authority write: restart secondmates onto current wiring after persist; ids only.",
    inputSchema: approvalSchema({
      ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 },
    }),
    handler: toolSecondmateRestart,
  },
  secondmate_report: {
    description:
      "Authority write: append one correlated report to the parent channel; the helper resolves the destination.",
    inputSchema: approvalSchema({
      verb: { type: "string", description: "Report verb slug" },
      corr: { type: "string", description: "16 hex chars, optional corr= prefix" },
      note: { type: "string", description: "Report note, single line 1..500 chars" },
    }),
    handler: toolSecondmateReport,
  },
  remote_control: {
    description:
      "Authority write: closed state/route/observe/send subset of remote secondmate control.",
    inputSchema: approvalSchema({
      verb: { type: "string", enum: [...REMOTE_CONTROL_VERBS] },
      id: { type: "string", description: "Secondmate id" },
      text: { type: "string", description: "Prose steer for send, 1..500 chars" },
    }),
    handler: toolRemoteControl,
  },
  handoff_move: {
    description:
      "Authority write: hand queued backlog items to a secondmate, or resume pending wakes.",
    inputSchema: approvalSchema({
      id: { type: "string", description: "Secondmate id" },
      keys: { type: "array", items: { type: "string" }, description: "1..20 backlog item keys" },
      resume: {
        type: "boolean",
        description: "Resume pending wakes; takes no keys",
        default: false,
      },
    }),
    handler: toolHandoffMove,
  },
  mail_status: {
    description: "Read-only mail configuration and last poll cursor; no network, no wake.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolMailStatus,
  },
  mail_read: {
    description:
      "Read-only unseen-INBOX digest over BODY.PEEK; mail stays unseen until firstmate answers.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolMailRead,
  },
  mail_check: {
    description:
      "Read-only inbound received-mail check; arming/disarming the watcher check stays out of MCP.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolMailCheck,
  },
  mail_send: {
    description: "External send: one SMTP message via fm-mail.sh send; credentials live outside MCP.",
    inputSchema: approvalSchema({
      to: { type: "string", description: "Recipient address with @" },
      subject: { type: "string", description: "Subject, single line 1..200 chars" },
      body: { type: "string", description: "Body, 1..5000 chars, piped via stdin" },
    }),
    handler: toolMailSend,
  },
  voice_status: {
    description:
      "Read-only voice-agent status answer from durable records; no mic, no Bedrock, no audio.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["counts", "full"], default: "counts" },
      },
      additionalProperties: false,
    },
    handler: toolVoiceStatus,
  },
  voice_queue: {
    description: "Authority write: hand one request to firstmate through the voice handover queue.",
    inputSchema: approvalSchema({
      text: { type: "string", description: "Request text, single line 1..500 chars" },
    }),
    handler: toolVoiceQueue,
  },
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
  doctor: {
    description:
      "Read-only self-check for this home: contract resolution, envelope budgets, cache and ledger freshness, grant state, audit trail, and gh availability, with a verdict and reasons.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolDoctor,
  },
  pr_state: {
    description: "Read-only blockers on one GitHub pull request; never posts, requests, or merges.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "https://github.com/<owner>/<repo>/pull/<number>" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    handler: toolPrState,
  },
  pr_poll: {
    description: "Read-only static merge-poll watcher check source; returns merged when merged, silent otherwise.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "https://github.com/<owner>/<repo>/pull/<number>" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    handler: toolPrPoll,
  },
  pr_reviewers: {
    description: "Read-only advisory reviewer candidates from a PR's changed files and recent authorship; never requests or assigns reviews.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "https://github.com/<owner>/<repo>/pull/<number>" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    handler: toolPrReviewers,
  },
  pr_open: {
    description:
      "Authority write: open a pull request for an already-pushed non-default branch; never merges.",
    inputSchema: approvalSchema(
      {
        title: { type: "string", description: `PR title, 1..${PR_TITLE_MAX_CHARS} chars, single line` },
        body: { type: "string", description: `PR body, non-empty, <= ${PR_BODY_MAX_BYTES} bytes` },
        head: { type: "string", description: "Source branch (non-default, already pushed)" },
        base: { type: "string", description: `Target branch (default ${DEFAULT_PR_BASE})` },
        draft: { type: "boolean", description: "Open as a draft PR" },
      },
      ["title", "body", "head"],
    ),
    handler: toolPrOpen,
  },
  arm_policy_check: {
    description: "Read-only watcher-arm command-policy verdict (allow or deny) for one shell command; never executes it.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "shell text to classify, 1..4000 chars" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    handler: toolArmPolicyCheck,
  },
  cd_policy_check: {
    description: "Read-only cd-guard command-policy verdict (allow or deny) for one shell command; never executes it.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "shell text to classify, 1..4000 chars" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    handler: toolCdPolicyCheck,
  },
  subagent_policy_check: {
    description: "Read-only subagent-guard verdict (allow or deny) for one harness tool name; never delegates.",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "harness tool name to classify, single line" },
      },
      required: ["tool"],
      additionalProperties: false,
    },
    handler: toolSubagentPolicyCheck,
  },
  supervision_instructions: {
    description: "Read-only render of the tracked supervision operating block for one harness, or its one-line repair instruction.",
    inputSchema: {
      type: "object",
      properties: {
        harness: { type: "string", enum: ["claude", "codex", "opencode", "pi", "pi-signed", "grok", "cursor", "omp"] },
        read_only: { type: "boolean" },
        afk: { type: "boolean" },
        afk_mode: { type: "string", enum: ["away", "quiet"] },
        x_mode: { type: "boolean" },
        queue_pending: { type: "boolean" },
        repair_line: { type: "boolean" },
      },
      additionalProperties: false,
    },
    handler: toolSupervisionInstructions,
  },
  quota_choose: {
    description: "Deterministic first quota-eligible dispatch candidate from an already-captured quota snapshot; never takes a fresh snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        snapshot: { type: "string", description: "captured quota-axi JSON (schemaVersion 5) or TOON text, 1..65536 chars" },
        candidates: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16, description: "ordered <harness>:<model> tokens" },
      },
      required: ["snapshot", "candidates"],
      additionalProperties: false,
    },
    handler: toolQuotaChoose,
  },
  relay_poll: {
    description: "Read-only short-poll of the relay connector; hard no-op without relay consent.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolRelayPoll,
  },
  public_followup_pending: {
    description:
      "Open public-followup loop digest; reports unresolved and delivered public loops without mutating state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolPublicFollowupPending,
  },
  public_followup_collect: {
    description:
      "Non-destructively read typed terminal events staged in this home's outbox for an obligation.",
    inputSchema: {
      type: "object",
      properties: {
        obligation_id: {
          type: "string",
          description: "tasks-axi public-followup obligation id (short slug)",
        },
      },
      required: ["obligation_id"],
      additionalProperties: false,
    },
    handler: toolPublicFollowupCollect,
  },
  public_followup_emit: {
    description:
      "Authority write: emit a structured terminal event for work bound to a public commitment.",
    inputSchema: approvalSchema({
      obligation_id: { type: "string" },
      relation_id: { type: "string" },
      source_home: { type: "string" },
      work_id: { type: "string" },
      generation: { type: "integer", minimum: 1 },
      outcome: { type: "string" },
      outcome_text: { type: "string" },
    }),
    handler: toolPublicFollowupEmit,
  },
  relay_link: {
    description: "Authority write: link a task to the relay mention that triggered it.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      request_id: { type: "string" },
    }),
    handler: toolRelayLink,
  },
  fleet_sync: {
    description: "Authority write: refresh project clones with safe fast-forwards, self-heals, and branch pruning.",
    inputSchema: approvalSchema({
      project: { type: "string", description: "Optional project name or relative path" },
    }, []),
    handler: toolFleetSync,
  },
  inactive_reconcile: {
    description: "Authority write: run bounded reconciliation of inactive crewmate terminal outcomes.",
    inputSchema: approvalSchema({
      mode: { type: "string", enum: ["scan", "report", "acknowledge"], description: "Reconciliation mode" },
      startup: { type: "boolean", description: "Run startup scan immediately" },
      task_id: { type: "string", description: "Task ID for report mode" },
      fingerprint: { type: "string", description: "Outcome fingerprint for acknowledge mode" },
    }, []),
    handler: toolInactiveReconcile,
  },
  tasks_list: {
    description: "Read-only backlog item listing via fm-tasks-axi.sh list.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["queued", "in_flight", "done", "held", "all"], description: "Filter by task state" },
        repo: { type: "string", description: "Filter by repository name" },
        kind: { type: "string", description: "Filter by task kind" },
        blocked: { type: "boolean", description: "Filter to blocked tasks" },
        limit: { type: "integer", description: "Maximum number of items to list (1..1000)" },
        fields: { type: "string", description: "Comma-separated field list" },
      },
      additionalProperties: false,
    },
    handler: toolTasksList,
  },
  tasks_show: {
    description: "Read-only inspection of one task in the backlog via fm-tasks-axi.sh show.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task ID slug" },
        full: { type: "boolean", description: "Include full body notes" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolTasksShow,
  },
  tasks_ready: {
    description: "Read-only list of dependency-cleared ready queued work via fm-tasks-axi.sh ready.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Filter by repository name" },
        include_held: { type: "boolean", description: "Include held work in a separate section" },
      },
      additionalProperties: false,
    },
    handler: toolTasksReady,
  },
  dispatch_resolve: {
    description: "Read-only dispatch resolution for one task brief; prints a dispatch plan without launching anything.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task id whose data/<id>/brief.md is resolved" },
        project: { type: "string", description: "Bare name or projects/<name>" },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    handler: toolDispatchResolve,
  },
  sessionstart_nudge: {
    description: "Read-only session-start nudge read; prints the one-line start instruction or nothing, exits 0.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolSessionstartNudge,
  },
  session_start: {
    description: "Authority write: run the whole session-start bootstrap (lock, sweeps, digests).",
    inputSchema: approvalSchema({
      reemit: { type: "boolean", description: "Re-emit context only" },
      source: { type: "string", description: "Harness session-open source slug" },
    }, []),
    handler: toolSessionStart,
  },
  sessionstart_run: {
    description: "Authority write: run the session-open digest runner for one harness source.",
    inputSchema: approvalSchema({
      source: { type: "string", description: "Harness session-open source slug" },
    }, []),
    handler: toolSessionstartRun,
  },
  sessionstart_cursor: {
    description: "Authority write: run the Cursor session-open transport for one harness source.",
    inputSchema: approvalSchema({
      source: { type: "string", description: "Harness session-open source slug" },
    }, ["source"]),
    handler: toolSessionstartCursor,
  },
  herdr_lab: {
    description: "Authority write: operate one isolated Herdr lab session (never default).",
    inputSchema: approvalSchema({
      subcommand: { type: "string", enum: ["name", "prepare", "provision", "run", "viewer", "stop", "teardown"] },
      session: { type: "string", description: "fm-lab-<label> session name" },
      label: { type: "string", description: "Short label for the name subcommand" },
      action: { type: "string", enum: ["start", "stop"], description: "Viewer action" },
    }, ["subcommand"]),
    handler: toolHerdrLab,
  },
  herdr_ci_cleanup: {
    description: "Authority write: snapshot or tear down CI-owned Herdr lab sessions from a snapshot file.",
    inputSchema: approvalSchema({
      command: { type: "string", enum: ["snapshot", "teardown"] },
      path: { type: "string", description: "Home-relative snapshot file path" },
    }, ["command", "path"]),
    handler: toolHerdrCiCleanup,
  },
  session_cleanup: {
    description: "Authority write: retire stale restored-shell Herdr presentation children at locked session start.",
    inputSchema: approvalSchema({}, []),
    handler: toolSessionCleanup,
  },
  claude_trust: {
    description: "Authority write: pre-register Claude Code workspace trust for a spawn target.",
    inputSchema: approvalSchema({
      worktree: { type: "string", description: "Isolated task worktree this spawn launches into" },
      project: { type: "string", description: "Primary checkout that worktree belongs to" },
      home: { type: "string", description: "Seeded secondmate home this spawn launches into" },
      id: { type: "string", description: "Secondmate id that home is marked for" },
    }, []),
    handler: toolClaudeTrust,
  },
  agy_trust: {
    description: "Authority write: pre-register Antigravity workspace trust for a spawn worktree.",
    inputSchema: approvalSchema({
      worktree: { type: "string", description: "Isolated task worktree this spawn launches into" },
      project: { type: "string", description: "Primary checkout that worktree belongs to" },
    }, ["worktree", "project"]),
    handler: toolAgyTrust,
  },
  claude_stop_autoarm: {
    description: "Authority write: run the Claude Stop-owned watcher auto-arm hook path.",
    inputSchema: approvalSchema({}, []),
    handler: toolClaudeStopAutoarm,
  },
  herdr_eventwait: {
    description: "Authority write: wait on a Herdr session control socket for pane status transitions.",
    inputSchema: approvalSchema({
      socket: { type: "string", description: "Herdr session control socket path" },
      timeout_s: { type: "integer", description: "Bounded wait budget, 1..300 seconds" },
      pane_ids: { type: "array", items: { type: "integer" }, description: "Pane ids to subscribe (1..8)" },
    }, ["socket", "timeout_s", "pane_ids"]),
    handler: toolHerdrEventwait,
  },
  herdr_workspace_move: {
    description: "Authority write: send one workspace.move request to a Herdr session control socket.",
    inputSchema: approvalSchema({
      socket: { type: "string", description: "Herdr session control socket path" },
      workspace_id: { type: "integer", description: "Exact workspace id to move" },
      insert_index: { type: "integer", description: "Non-negative insert index" },
    }, ["socket", "workspace_id", "insert_index"]),
    handler: toolHerdrWorkspaceMove,
  },
  backlog_receive: {
    description: "Authority write: receive one delivered remote-secondmate outbox into this home's backlog.",
    inputSchema: approvalSchema({
      path: { type: "string", description: "Delivered outbox path (state/handoff/<id>.outbox.md)" },
      bytes: { type: "integer", description: "Expected byte size" },
      sha256: { type: "string", description: "Expected SHA-256 digest" },
      generation: { type: "integer", description: "Upload generation" },
    }, ["path", "bytes", "sha256", "generation"]),
    handler: toolBacklogReceive,
  },
  receipt_submit: {
    description:
      "Detach one tool call past the 30s fail-closed budget; returns a pending receipt to poll with receipt_status.",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "Name of the tool to run detached" },
        arguments: {
          type: "object",
          description:
            "Arguments for the named tool, including its approval when it requires one",
        },
      },
      required: ["tool", "arguments"],
      additionalProperties: false,
    },
    handler: toolReceiptSubmit,
  },
  receipt_status: {
    description:
      "Read-only check on one detached receipt; reports running, done with the result attached, failed, or expired.",
    inputSchema: {
      type: "object",
      properties: {
        receipt_id: {
          type: "string",
          description: "Receipt id from a receipt_submit pending response",
        },
      },
      required: ["receipt_id"],
      additionalProperties: false,
    },
    handler: toolReceiptStatus,
  },
  fleet_poll: {
    description:
      "Read-only convenience poller over fleet_snapshot for clients that need push-like updates.",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1, maximum: 3, default: 2 },
        interval_s: { type: "number", minimum: 0, maximum: 2, default: 0 },
      },
      additionalProperties: false,
    },
    handler: toolFleetPoll,
  },
  promote_scout: {
    description: "Authority write: promote a scout task to a ship task in place.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      mode: { type: "string", enum: [...MODES] },
      yolo: { type: "string", enum: ["on", "off"] },
    }),
    handler: toolPromoteScout,
  },
  teardown_crew: {
    description: "Authority write: tear down one completed crew and release resources.",
    inputSchema: idApprovalSchema("task_id"),
    handler: toolTeardownCrew,
  },
  arm_pr_check: {
    description: "Authority write: arm watcher PR check for a landed crew task.",
    inputSchema: idApprovalSchema("task_id"),
    handler: toolArmPrCheck,
  },
  merge_pr: {
    description: "Authority write: merge a task PR or MR via fm-pr-merge.sh.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      method: { type: "string", enum: ["squash", "merge", "rebase"], default: "squash" },
    }),
    handler: toolMergePr,
  },
  merge_local: {
    description: "Authority write: fast-forward local default branch for mode=local-only tasks.",
    inputSchema: idApprovalSchema("task_id"),
    handler: toolMergeLocal,
  },
  repo_edit: {
    description: "Authority write: edit or create a bounded file within the workspace.",
    inputSchema: approvalSchema({
      path: { type: "string", description: "Home-relative path" },
      content: { type: "string", description: "File content (<= 256KB)" },
    }),
    handler: toolRepoEdit,
  },
  repo_commit: {
    description: "Authority write: commit workspace changes with a single-line message.",
    inputSchema: approvalSchema({
      message: { type: "string", description: "Commit message 1..500 chars" },
    }),
    handler: toolRepoCommit,
  },
  repo_push: {
    description: "Authority write: push a non-default branch to origin.",
    inputSchema: approvalSchema({
      branch: { type: "string", description: "Target branch name" },
    }),
    handler: toolRepoPush,
  },
  repo_merge: {
    description: "Authority write: merge a branch with --no-ff.",
    inputSchema: approvalSchema({
      branch: { type: "string", description: "Branch to merge" },
    }),
    handler: toolRepoMerge,
  },
  daemon_start: {
    description: "Authority write: start the away-mode supervisor daemon.",
    inputSchema: approvalSchema({}),
    handler: toolDaemonStart,
  },
  daemon_stop: {
    description: "Authority write: stop the away-mode supervisor daemon by clearing .afk.",
    inputSchema: approvalSchema({}),
    handler: toolDaemonStop,
  },
  daemon_restart: {
    description: "External write: restart the away-mode supervisor daemon.",
    inputSchema: approvalSchema({}),
    handler: toolDaemonRestart,
  },
  daemon_status: {
    description: "Read-only check on the supervisor daemon state and away posture.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolDaemonStatus,
  },
  watch_start: {
    description: "Authority write: run one watcher polling cycle.",
    inputSchema: approvalSchema({}),
    handler: toolWatchStart,
  },
  watch_stop: {
    description: "Authority write: stop watcher cycle.",
    inputSchema: approvalSchema({}),
    handler: toolWatchStop,
  },
  task_intake: {
    description: "Authority composite: ingest task and scaffold brief.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      project: { type: "string", description: "Bare name or projects/<name>" },
      mode: { type: "string", enum: [...BRIEF_MODES], default: "no-mistakes" },
    }),
    handler: toolTaskIntake,
  },
  worktree_allocate: {
    description: "Authority write: allocate isolated worktree slot for task.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      project: { type: "string" },
    }),
    handler: toolWorktreeAllocate,
  },
  lifecycle_drive: {
    description: "Authority composite: spawn crew and capture initial state.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      project: { type: "string" },
      mode: { type: "string", enum: [...MODES], default: "no-mistakes" },
      yolo: { type: "string", enum: ["on", "off"], default: "off" },
    }),
    handler: toolLifecycleDrive,
  },
  review_gate: {
    description: "Authority composite: inspect diff and record captain review decision.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      verdict: { type: "string", enum: [...VERDICTS] },
      comment: { type: "string" },
    }),
    handler: toolReviewGate,
  },
  reconcile_upstream: {
    description: "Authority composite: run upstream drift/shift report for reconciliation.",
    inputSchema: approvalSchema({}),
    handler: toolReconcileUpstream,
  },
  grant_mint: {
    description:
      "Authority write: mint a new scoped standing approval grant for autonomous loops.",
    inputSchema: approvalSchema({
      grantee: { type: "string", description: "Identity receiving the grant (e.g. task id or agent name)" },
      tier_limit: { type: "integer", minimum: 1, maximum: 4, default: 3, description: "Maximum tier allowed by grant" },
      tools: { type: "array", items: { type: "string" }, description: "Optional allowlist of tool names" },
      projects: { type: "array", items: { type: "string" }, description: "Optional allowlist of projects" },
      ttl_s: { type: "integer", minimum: 1, maximum: 2592000, default: 3600, description: "Grant lifetime in seconds" },
      max_uses: { type: "integer", minimum: 1, description: "Optional maximum usage count" },
      note: { type: "string", description: "Optional description or note for the grant" },
    }),
    handler: toolGrantMint,
  },
  grant_revoke: {
    description: "Authority write: revoke an active standing approval grant immediately.",
    inputSchema: approvalSchema({
      grant_id: { type: "string", description: "Grant ID or grant_ref to revoke" },
      reason: { type: "string", description: "Optional revocation reason" },
    }),
    handler: toolGrantRevoke,
  },
  grant_status: {
    description:
      "Read-only inspection of standing approval grants (safe metadata only, never exposes secrets).",
    inputSchema: {
      type: "object",
      properties: {
        grant_id: { type: "string", description: "Optional grant ID or grant_ref to inspect" },
        grantee: { type: "string", description: "Optional grantee filter" },
      },
      additionalProperties: false,
    },
    handler: toolGrantStatus,
  },
};

export const TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(TOOLS));

void APPROVAL_PREFIX;
