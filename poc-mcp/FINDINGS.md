First Mate MCP smarts-only findings (poc-trim)

## What changed

`poc-mcp/fm_mcp_server.py` is trimmed from 24 full-coverage tools to 19 smarts-only tools with no dependency beyond Python 3.
The 5 original tools (`fleet_snapshot`, `backlog`, `crew_state`, `status_tail`, `send_message`) are behavior-identical and their original checks still pass.
14 launch-authorized tools shell to the owning `bin/` scripts: 5 lifecycle verbs, `spawn_crew`, `scaffold_brief`, `decision_hold`, `decision_resolve`, `review_decision`, `relay_reply`, `relay_dismiss`, `relay_followup`, and the read-only `fleet_poll` convenience poller.
5 code-forbidden tools are removed with no stub: `promote_scout`, `teardown_crew`, `arm_pr_check`, `merge_pr`, `merge_local`.
`poc-mcp/AUTH.md` documents the smarts-only tiers: open reads, reversible steers, launch-authorized writes, external sends, and the code-forbidden list.
`poc-mcp/test_client.py` now runs 67 checks: the original 17 plus launch-tool refusal paths plus unknown-tool proof for every removed surface.
All 67 client checks pass, with sandbox-home isolation (`FM_HOME` pointed at a temp dir) for every side-effecting test.

## What smarts-only now requires

Launch ability yes and development ability no per the owner order of 2026-09-13 on task-5x79b.
Every authority-bearing or externally visible tool takes an explicit `approval` argument starting with `I authorize` and refuses without it.
Reads stay open and `send_message` keeps its PoC validation (500-char single line, no slash commands).
Lifecycle verbs are launch control only and never touch repos directly.
`spawn_crew` and `scaffold_brief` carry only the safe subset of flags with no repo-mutation options.
Decisions and Relay sends inherit the owning scripts' guards: decision-hold lifecycle, yolo posture, relay consent, and follow-up budgets.
The server inherits `FM_HOME` from its environment, so the launcher must pin it rather than passing it per call.
Base `fm/poc-full` ref stays untouched and this trim commits on `fm/poc-trim`.

## Residual risks

Authority laundering remains the largest risk: a convenient launch tool can feel routine while downstream work is destructive.
The mitigation is unchanged layering: the MCP schema narrows the flags, the server revalidates ids and approval, and the owning script still fails closed.
Relay consent lives outside this layer, so a compromised MCP caller with approval strings could still send public replies.
No merge authority lives in this layer after the trim, so a compromised caller cannot land code through MCP.
Recommendation: keep this local-only on a pinned `FM_HOME`, treat approval strings as per-action captain consent, and rescope before any networked or multi-user wiring.
