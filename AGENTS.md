# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

## Posture (owner-set, 2026-09-22)

Personal software, one owner, no external users. Standing owner instruction:

- **Yolo forward on AI choice.** When a decision is not the owner's (policy,
  taste, reversibility trade-off), pick the option you would recommend and
  execute it in the same turn. Do not hand a decision back with "say the word",
  and do not ask permission for reversible work.
- **Never hold a green PR for the CI matrix.** `main` is not branch-protected
  and nothing blocks a merge; the full matrix (`ts-slow`, `upstream
  preservation`, conformance shards) takes ~3 minutes and is **advisory**.
  Merge on your own judgment once the local proof you can actually run is
  green, then verify live. `gh pr merge --squash --delete-branch` merges
  immediately; `--auto` is unavailable (`allow_auto_merge: false`) and is not
  the posture anyway.
- **We test things live.** A red advisory job is a to-do, not a stop sign — but
  state what you verified and what you merged past, so the red is owned rather
  than buried (see the `drift-baseline freshness` incident below).
- **Reversible = recoverable; stalling is not.** Delete dead branches, rewrite
  your own work, repin pins — record the before-state (SHAs, original config)
  so it can be undone.
- The doorway's own safety core is the exception: default-deny, tier bounds, and
  audit logging stay load-bearing regardless of this posture.
- The code-forbidden set is real (`FORBIDDEN_TOOLS`, `ts/src/auth.ts`): 48 surfaces
  — the captain's landing/merge levers, daemon and watch control, un-gated public
  emission, fleet sync, session machinery, every cross-machine verb, every
  installs mutator — carry **no tier entry** and are refused before approval or
  grant is considered. `repo_edit`/`repo_commit`/`repo_push`/`pr_open` are
  deliberately allowed (Tier 3, the delivery chain is the point of the doorway);
  `repo_merge` is forbidden because a local merge into a default branch bypasses
  the pull request the chain exists to open. A committed test used to pin
  `FORBIDDEN_TOOLS` as **empty** — that is how the docs and the code disagreed for
  so long; it now pins the invariant instead. The adapter's deny list is
  client-side and bypassable by any direct caller, so treat it as defence in
  depth, never as the guard.
- **Standing loop (infinite directive, 2026-09-22): "repin upstream, eval
  features, yolo forward."** Repeat indefinitely. One cycle is:
  1. `scripts/fm-mcp-repin.sh --check` — fetches upstream main, reports the
     shift, exits 1 when the pin is behind.
  2. `scripts/fm-mcp-repin.sh --apply` — bumps `gitlink_at_seed` and
     `provenance.upstream.gitlink`, stages the gitlink, regenerates
     `manifest/COVERAGE.md`, and runs every gate CI runs (including the
     `drift-baseline freshness` snippet, extracted from the workflow so it
     cannot drift from CI).
  3. **Evaluate** the radar's "Depended-on surfaces that moved" list: port what a
     contract actually depends on, call the rest noise, and write that judgement
     into the commit message next to the diff it explains.
  4. Merge immediately (see the posture above); the daily `mcp-shift-schedule`
     job also opens an issue on a shift, so a cycle can start from that too.
  A wrapper-only contract needs no code port — the pin bump carries the fix
  (verified 2026-09-22 with `fm-crew-state.sh`). The pin of record is the
  **parent repo's gitlink**, never the submodule checkout: comparing the checkout
  reports phantom shifts (and `fm-mcp-repin.sh` says so when they disagree).

## Beads and the store registry

- "Beads" (the captain's word for issues) are the `bd`-backed stores, but they
  are addressed by their own CLI name, never by bare `bd`: `projects list`,
  `task ready`, `review show`, `robots ...`. Each name is a wrapper that pins
  `BEADS_DIR` + `BD_NAME` and execs `bd "$@"`.
- Shared registry of every store: `~/.config/pai/stores.yaml` — list with
  `brain stores list`; wrappers consume `~/.config/pai/stores.env`. Do not
  hand-edit; use `brain stores add/remove/create/alias`.
- This repo has no `.beads`, so bare `bd` fails here. firstmate_mcp's tracking
  lives in the `projects` store, epic `project-2od`; query it as
  `projects ...` from any cwd.
- Cross-store ids in notes (`task-*`, `brain-*`, `review-*`) live in other
  registered stores; resolve them with the matching CLI.

## Client wiring (how agents reach the doorway)

- Pi has no built-in MCP; the fleet client is the `pi-mcp-adapter` package (in
  `~/.pi/agent/settings.json` `packages`). Servers live in `~/.pi/agent/mcp.json`
  (adapter-owned; `~/.config/mcp/mcp.json` is the cross-host shared file).
- The doorway is served by **mcpjungle**, never spawned by the client: the Pi
  entry `firstmate` points at the scoped tool group endpoint
  `http://127.0.0.1:8338/v0/groups/firstmate/mcp` (`toolPrefix: none`,
  `lifecycle: lazy`). The group (`included_servers: [firstmate_mcp]`) is what
  keeps the gateway's other namespaces (interceptor, apple-notes, beads-bridge)
  out of the client: 190 aggregate tools -> 125 doorway tools, named
  `firstmate_mcp__<tool>`. Add/refresh it with
  `mcpjungle --registry http://127.0.0.1:8338 create group --conf <file>`.
- Reach tools lazily through the proxy surface — `mcp` (`search` -> `describe`
  -> `call`) and `mcpScript` — not by flooding the client with 125 direct tools.
  A freshly written config needs a Pi `/reload`/new session, but
  `mcp({action:"install", url})` registers a server live with no reload.
- The adapter's approval layer is separate from the doorway's own tiers: Tier 3+
  calls still need the tool's `approval` string or a minted standing grant.
- Sharp edge: the served child is `ts/dist/server.js`, gitignored and never
  built by a fresh checkout or by a merge — run `cd ts && pnpm run build` after
  pulling. mcpjungle also **caches tool metadata at register time**, so a
  rebuilt `dist` is invisible until
  `mcpjungle --registry http://127.0.0.1:8338 register --conf <export> --force`
  (`mcpjungle export -d <dir>`); the CLI defaults to :8080, so always pass
  `--registry http://127.0.0.1:8338`. Adding a tool is exactly this case: the
  registry keeps serving the old count until it is re-registered.
- `pr_open` (Tier 3) completes the delivery chain: `repo_edit`/`repo_commit`/
  `repo_push` existed and nothing could open the pull request, so landing work
  meant shelling out to `gh` outside the doorway. It runs `gh pr create`
  directly, the way `repo_commit`/`repo_push` run `git`, behind validators that
  refuse a default-branch head, a multi-line or oversized title, an empty body
  (never a bodyless PR) and a traversal-shaped base; `merge_pr` stays forbidden
  by design, so opening is the last step an agent takes alone. Sharp edge: the
  serving process needs its own gh credentials — a launchd/mcpjungle-spawned
  server does not inherit an interactive shell's keychain session, so `pr_open`
  can fail with `not authenticated` while `gh` works by hand in a terminal.
  Measured 2026-09-22: the failure was resolution, not credentials — the launchd
  PATH is `/usr/bin:/bin:/usr/sbin:/sbin`, so a bare `gh` returned
  `Executable not found in $PATH: gh`. `resolveGhBin()` (FM_GH_BIN > the usual
  install locations > PATH) covers the server's direct calls, and the gateway
  registration now carries a PATH so scripts that shell out to gh work too.
  Credentials come from the environment the gateway runs in; verified live by a
  probe that reached the API and failed on a nonexistent head ref without
  creating anything.
- Whole-home reads (`backlog`, `bearings_snapshot`, `fleet_snapshot`) exceed the
  30s envelope on a real home and return a typed `{"error":"timed out"}`; that
  is the envelope working, not a client bug — use the receipt path.

## Build, test, and envelope

- Server proof: `cd ts && bun test` (or `pnpm test`) is the full standalone
  proof of the TypeScript MCP server (validators, envelope, auth with duration_ms timing and decision_digest audit logging,
  standing approval grants, 85-tool server suite, and conformance fixtures); run it before shipping server changes.
  It includes fixtures covering >30s timeout kill, >128KB snapshots, and receipt lifecycle.
  Other suites: `bash tests/mcp-adapter.test.sh`, `tests/fm-mcp-authz.test.sh`,
  `tests/mcp-schema.test.sh`, `tests/drift-check.test.sh`,
  `tests/fm-manifest.test.sh` (`manifest/validate.py` validates dual provenance,
  honesty, contract coverage, and kinds `upstream-mirror`, `local`, and `fork`),
  `tests/fm-coverage.test.sh` (support-coverage view: `scripts/gen_coverage.py` renders every
  upstream command area with its mirror status into `manifest/COVERAGE.md`; the gate fails
  on any unclassified command), `tests/mcp-hooks.test.sh` (commit-msg hook and setup proof),
  `tests/conformance/ts-parity.sh` (multi-runtime Bun + Node proof),
  `tests/upstream/run_upstream.sh` (preservation proof against TS server).
  Coverage/manifest gates need `sources/firstmate` checked out
  (`git submodule update --init`); without it `gen_coverage.py` falls back
  to the fork snapshot in `drift/baseline.json` and mis-reports upstream
  commands newer than that pin.
- Adding a mirrored tool touches a fixed set of registries of record, and the
  gates fail when any drift apart: `ts/src/{auth,tools,validators}.ts`,
  `schema/contracts.yaml` **plus** its `schema/matrix.md` row and its
  `schema/validate.py` `CURRENT_PINS` entry, `manifest/FEATURES.yaml`,
  `scripts/gen_readme_lists.py` (its `TOOLS` map and tier map), and the
  regenerated README `GENERATED` block. Four checks prove it:
  `python3 manifest/validate.py`, `python3 schema/validate.py`,
  `python3 scripts/gen_readme_lists.py --check`, and the `drift-baseline
  freshness` snippet in `.github/workflows/mcp-ci.yml` — run that one locally
  too, because it is a required `ci-gate` job while a direct `gh pr merge` can
  still slip past branch protection. Doorway-native tools with no upstream
  script (`repo_push`, `pr_open`) are exempt from the contract/manifest side;
  that exemption is why `pr_open` needed no registry edits while `test_run`,
  which wraps `fm-test-run.sh`, needed six.
- The repo tree has no `bin/`; the server resolves scripts through `FM_HOME/bin`
  (`ts/src/constants.ts:resolveBinDir`), defaulting to the live firstmate checkout.
  Line binding (line, pinned revs, full resolution order with example):
  README.md "Line binding and checkout resolution". Line is the
  `trillium/firstmate` fork, fork-pinned; checkout pin is the
  `sources/firstmate` gitlink, drift inventory rev is
  `drift/baseline.json: firstmate_revision`; server order is
  `CHECKOUT_BIN` > `FM_HOME/bin`, with `FIRSTMATE_HOME` > `FM_REAL_HOME` >
  `FM_CHECKOUT` for reference lookup.
- Ledger-backed orientation (`ts/src/tools.ts` `publishHomeSummary`):
  `home_summary` reads `state/home-summary.json` in O(1) — 3ms live, against
  110s for the full `fm-fleet-snapshot.sh --json` walk that used to serve it —
  while the publisher stays out of band. The served fork line does not ship
  `bin/fm-home-summary-refresh.sh`, so the doorway publishes from the bounded
  `fm-fleet-snapshot.sh --secondmate-home-summary` the line does ship (65s live:
  submit it through `receipt_submit`, a direct call hits the 30s envelope and
  returns a hint saying so). The publish must bypass `ownedCall()` — that tails
  stdout at `TAIL_CAP_BYTES` (8 KiB) while the document is ~32 KiB, so the JSON
  would be truncated mid-document. Publish is atomic: mode-0600 temp on the
  state filesystem, then rename, so a killed refresh leaves the prior complete
  document. Sharp edge: the served line's document carries no `generated_epoch`
  (a declared field), so freshness has to come from `generated`.
- Warm-cache orientation (`latestCachedSnapshotId`): `fleet_snapshot` and
  `backlog` serve the newest unexpired cached snapshot when the caller names
  none (measured 7-18ms live; the same calls were envelope-killed at 30s an
  hour earlier) and report `from_cache`. A snapshot is only cached by a call
  that can finish, so warm it out of band: `receipt_submit(fleet_snapshot)`
  (95s against the 180s budget), then paginate with `limit`/`cursor`. An
  explicitly named id still fails loudly rather than silently serving a
  different snapshot, and an expired cache is skipped so the caller recomputes.
  Orientation recipe: `home_summary` for the O(1) ledger, receipt-warm then
  paginate for ground truth.
- Envelope (ts/src/constants.ts): `SUBPROCESS_TIMEOUT_S=30`, `MAX_OUTPUT_BYTES=1MB`.
  No call blocks past 30s: `runScript` starts children in their own session
  and kills the whole process group on timeout, auditing a typed timeout
  error. Calls needing longer (live `fm-fleet-snapshot.sh` takes ~110s)
  go through `receipt_submit`/`receipt_status` (receipts under
  `state/mcp-receipts/`, `RECEIPT_TIMEOUT_S=180`, `RECEIPT_TTL_S=3600`,
  per-home confinement).
- TypeScript server (`ts/`, stdio sole server, Effect composition): pnpm is the
  package manager (`pnpm install`), bun is the sole runtime (`bun test` / `pnpm test`
  is the full TS proof). Test runner is native Bun test.
- Decision-closing release & attestation mechanics (`ts/src/tools.ts`, `AUTH.md`):
  `decision_release`, `decision_resolve`, and `review_decision` (with `--release`)
  enforce the SAFETY CORE: default scope allows releasing/resolving ONLY holds the calling agent
  opened itself (matching `FM_ACTOR` to hold author/origin metadata); captain-opened or third-party
  holds refuse without an explicit per-deploy grant (`FM_RELEASE_GRANT=1`, default OFF).
  Mandatory non-empty decision records are required and every release is audit-logged with
  `decision_digest` (SHA-256).
  Attestation tools `decision_complete` (Tier 3 write), `decision_verify` (Tier 1 read),
  `decision_open` (Tier 1 read), and `decision_diverged` (Tier 1 read) mirror the completion
  and verification surfaces from `bin/fm-captain-hold.sh`.
- Test optimization (split-then-hash hybrid):
  Targets split into fast hermetic unit/smarts (`test:fast` / `test:fast:bun`, <3s)
  vs slow timing/envelope/receipt proofs (`test:slow` / `test:slow:bun`, `timeout.test.ts`,
  `receipt.test.ts`, NEVER-cached). Conformance fixtures are sharded across 3 files
  (`conformance-read`, `conformance-remote`, `conformance-system`) and run via
  `ts/scripts/conformance-runner.mjs` with per-runtime input hashing (`ts/.cache/conformance/`)
  and hash-skipping on byte-identical inputs. CI parallelizes shards across matrix jobs
  (`ts-conformance`), while `.github/workflows/mcp-nightly.yml` runs scheduled full uncached
  proofs across both runtimes.
- Standing approval (`ts/src/grants.ts`, contract `AUTH.md`):
  scoped standing grants (mint/store/revoke in `state/mcp-grants/`) for autonomous loops;
  hashes on disk, plaintext tokens never logged; satisfies approval gate within stated scope;
  preserves default-deny, tier bounds, fail-closed expiry, and explicit-grant-only captain-hold release.
- Follow-on actions (`ts/src/followon.ts`, design `docs/FOLLOWON_DESIGN.md`):
  generalized hook engine for MCP actions; auth tiers enforced per action
  (never launders authority from open reads to Tier 3/4 writes), bounded
  DAG loop termination (depth cap + cycle detection + action budget).
- Paginated fleet reads (`ts/src/tools.ts`, bead `task-auxer`):
  `fleet_snapshot` and `backlog` accept optional `cursor` (`<snapshot_id>:<offset>` or integer offset)
  and `limit` (default 50, 1..200); return summary-first payload (`summary`, `page[]`, `next_cursor`, `truncated`)
  with snapshots computed once and cached under `state/mcp-snapshots/` (`SNAPSHOT_TTL_S=3600`, per-home confinement);
  unpaginated calls preserve canonical backwards compatibility.
- Test runner: `pnpm run test:dev` selectively reruns
  recorded failing test files during local development, while CI and PR
  always run the full suite (`bun test` / `pnpm test`).
- Never gate on the exit status of a *piped* command: `pnpm test 2>&1 | tail -n`
  reports tail's status, so a failing suite can surface as exit 0 (observed
  2026-09-22: a background run reported exit 0 while its own output said
  "423 pass, 13 fail"). Read the summary line, or avoid the pipe.
- AST proof caching (`ts/src/proof/`, `ts/proof-cache/`): content-addressed AST proof caching for explicitly bounded unit tests (`ts/proof-cache/contracts.json`, `ts/proof-cache/manifest.json`). Uses ast-grep to fingerprint AST nodes normalized against formatting and comments. Runner skips passing bounded unit suites while ineligible tests (integration/timing/conformance) always execute; inspect via `pnpm run proof:check` and `pnpm run proof:explain`.
- CI path filters (`.github/workflows/mcp-ci.yml`): non-code and docs-only changes
  skip heavy proof suites (`ts-server`, `upstream`) while fast validators
  (`schema`, `unit`, `manifest`, `drift`) and the anchor `ci-gate` merge gate always run.
- Upstream-shift watch: `drift/shift.py` polls the upstream Atom feed
  first (`drift/atom.py`: feed SHA vs the pin as cached SHA, quiet when
  unchanged, loud `ATOM PARSE FAILURE` on malformed feeds, fail-open to
  the full `ls-remote` + `bin/` diff); gate
  `scripts/mcp-shift-schedule.sh`, daily job
  `.github/workflows/mcp-shift-schedule.yml`, fake-feed proof
  `tests/mcp-shift-atom.test.sh` (plus `tests/mcp-shift-schedule.test.sh`).
  Repin: fetch+checkout the new sha in `sources/firstmate`, then update
  `upstream.gitlink_at_seed` (`manifest/FEATURES.yaml`) and
  `provenance.upstream.gitlink` (`schema/contracts.yaml`) in the same commit —
  both validators compare them to the live gitlink — and re-run
  `scripts/gen_coverage.py`. Drift compares content only: checkout `mtime` and
  the executed-help family (`flags`, `help_*`, `schema_hint`) are recorded as
  triage evidence but never compared (see `drift/diff.py` IGNORED_FIELDS),
  because they are not pure functions of the file. Comparing them once
  reported 177/177 surfaces changed for a single unchanged revision; one
  surface's help printed a live watcher pid, another timed out under load.
  `tests/fm-manifest.test.sh` derives the gitlink shape from the manifest, so
  a repin needs no fixture edit. The issue-filing step runs through
  `scripts/mcp-shift-schedule.sh --file-issue` (hermetically tested; it creates
  the `upstream-shift` label on demand and dedups on the short SHA) — never
  inline `gh` logic in the workflow: an untested `gh issue list --jq` without
  `--json`, plus a label that did not exist, failed the scheduled job on every
  run for five days (2026-09-18..22) while reporting nothing.
- Dual provenance: the Kun fingerprint (submodule gitlink + drift baseline,
  radar watched by drift/shift.py) and the trillium/firstmate working-copy pin
  (proven commit + date) live together in manifest/FEATURES.yaml
  (`upstream` + `fork` blocks) and schema/contracts.yaml (`provenance`);
  both validators fail loudly on missing/stale pins. Standing reconciliation
  policy: the radar stays current; each Kun shift is ported into our mirrors
  with divergences preserved; shift reports dispatch port work.
- Coverage provenance outside `bin/fm-*.sh` (e.g. `bin/fm_voice_records.py`)
  needs a `bin/` key in `scripts/gen_coverage.py` COMMAND_AREAS; it renders
  via the special-rows path, never the upstream `.sh` enumeration.
  Sourced-library surfaces with no CLI (e.g. `backends/*.sh` adapters) are
  denied toolless via `DENY_ALSO` under one named deny (no invented no-op
  tool); local-danger DENY names with a real CLI keep their approval-gated
  tool + tier.
- Gap-mirror deny shapes (`scripts/gen_coverage.py` DENY_REASONS + `ts/src/auth.ts`
  TOOL_TIERS + `tests/fm-coverage.test.sh`): a command cannot be both mirrored
  and denied (the gate fails) — excluded facets of a mirrored command live in
  the FEATURES.yaml divergence reason (precedent: `remote_doctor --fix`,
  `remote_file put`). Verbs that would reach another machine over SSH
  (execute/provision/push/launch/reap) get a Tier 3 name but NO handler in
  `ts/src/tools.ts`, so tools/call refuses them as unknown even with approval
  (`ts/tests/server.test.ts` asserts the refusal). Same no-handler shape
  covers installs mutators (bootstrap/seed/install/update/lint-run); mixed
  read+mutating scripts (home-seed validate, startup-network report,
  test topology lists) mirror the read with the kept-out verb in the
  divergence reason and no DENY entry.
- Supervised deployment (`docs/DEPLOYMENT.md`): launchd unit template (`deploy/com.firstmate.mcp.plist.template`), fail-closed stdio smoke gate (`scripts/fm-mcp-smoke.sh`, `tests/fm-mcp-smoke.test.sh`), plist renderer (`scripts/fm-mcp-render-plist.sh`, `tests/fm-mcp-deploy.test.sh`), and copytruncate log rotation (`scripts/fm-mcp-logrotate.sh`, `tests/fm-mcp-logrotate.test.sh`).
  Installed 2026-09-22 on this host: `com.firstmate.mcp` (the server unit) plus
  `com.firstmate.mcp.maintenance` (daily `scripts/fm-mcp-maintenance.sh`,
  `tests/fm-mcp-maintenance.test.sh`), which smoke-gates the live home and then
  rotates logs under a hard watchdog. Two things learned by deploying, not by
  reading:
  - The **server unit is an idle anchor, not a serving process**. It is a stdio
    server: under launchd it reads EOF, exits 0, and
    `KeepAlive{SuccessfulExit:false}` deliberately leaves it stopped
    (`runs=1, last exit code=0, state=not running`). Serving is done by whatever
    spawns the server (mcpjungle here); the unit exists so
    `launchctl kickstart -k gui/$(id -u)/com.firstmate.mcp` is a real cutover
    target.
  - **Never let a launchd unit inherit an interactive PATH.** A rendered unit
    carried pyenv shims, and `pyenv-exec python3` hung indefinitely under
    launchd — the smoke gate calls python3 — parking the maintenance job in
    "running" with an empty log. `fm-mcp-render-plist.sh` now defaults to a
    shim-free PATH (runtime dir + homebrew + system dirs); the maintenance
    script also avoids python3 entirely (bash-native `EPOCHREALTIME`), uses temp
    files instead of command substitution (a `$( )` capture waits for EOF, which
    a surviving grandchild can hold open forever), and bounds every stage.
- Commit hooks: `bash scripts/setup-hooks.sh` configures `core.hooksPath = .githooks`
  (enforcing conventional commits `feat|fix|chore|docs|refactor|test|ci|perf|build|revert|style`
  matching observed history, shared across checkouts and linked worktrees; escape hatch `--no-verify`
  or `FM_SKIP_HOOKS=1`; test suite `tests/mcp-hooks.test.sh`).
- Cutover: `scripts/fm-mcp-launch.sh --home $FM_HOME` serves the fleet
  local-only over stdio via the TypeScript server (`ts/dist/server.js`); pins
  `FM_HOME`, refuses network flags, never add a repo-root `bin/` (it would
  shadow `$FM_HOME/bin` in server resolution). The server appends one
  JSON-lines audit record per tools/call with `duration_ms` timing (default
  `$FM_HOME/state/mcp-audit.jsonl`; override `FM_AUDIT_LOG`, actor via
  `FM_ACTOR`; approval stored as hash only). Live proof:
  `python3 scripts/cutover_prove.py` writes `CUTOVER-PROOF.md` from a fixed
  scratch home — never the live fleet.
- Autonomous loop runner: `python3 scripts/fm-mcp-loop.py` (and test
  `bash tests/fm-mcp-loop.test.sh`) proves the end-to-end unattended MCP loop
  (scout discovery read chain, Tier 2 plain steer, Tier 3 authority writes under
  standing approval grant without human strings, async receipt submit/poll,
  decision attestation, and mid-run kill-switch revocation) against a dedicated
  scratch home, writing `LOOP-PROOF.md`.
