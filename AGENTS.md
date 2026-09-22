# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

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
  `--registry http://127.0.0.1:8338`.
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
- The repo tree has no `bin/`; the server resolves scripts through `FM_HOME/bin`
  (`ts/src/constants.ts:resolveBinDir`), defaulting to the live firstmate checkout.
  Line binding (line, pinned revs, full resolution order with example):
  README.md "Line binding and checkout resolution". Line is the
  `trillium/firstmate` fork, fork-pinned; checkout pin is the
  `sources/firstmate` gitlink, drift inventory rev is
  `drift/baseline.json: firstmate_revision`; server order is
  `CHECKOUT_BIN` > `FM_HOME/bin`, with `FIRSTMATE_HOME` > `FM_REAL_HOME` >
  `FM_CHECKOUT` for reference lookup.
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
