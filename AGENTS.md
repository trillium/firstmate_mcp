# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

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
