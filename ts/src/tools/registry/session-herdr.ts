/**
 * Registry fragment: session-herdr (slice 16 of the tools.ts folder split, task-8pqjb).
 *
 * Moved verbatim from the TOOLS literal in src/tools.ts. Key order
 * within this fragment matches the canonical order; index.ts spreads
 * fragments in canonical order so tools/list output is unchanged.
 */
import { toolHerdrCiCleanup, toolSessionCleanup, toolClaudeTrust, toolAgyTrust, toolClaudeStopAutoarm, toolHerdrEventwait, toolHerdrWorkspaceMove } from "../herdr-trust.js";
import { toolSessionStart, toolSessionstartRun, toolSessionstartCursor, toolHerdrLab } from "../session-start.js";
import { approvalSchema } from "./shared.js";
import type { ToolDef } from "./shared.js";

export const SessionHerdrRegistry: Record<string, ToolDef> = {
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
};
