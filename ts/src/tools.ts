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

// Canonical registry lives in ./tools/registry/index.ts (slice 16, task-8pqjb).
// Re-exported here so the ./tools.js public surface is unchanged.
export { TOOLS, TOOL_NAMES } from "./tools/registry/index.js";

void APPROVAL_PREFIX;
