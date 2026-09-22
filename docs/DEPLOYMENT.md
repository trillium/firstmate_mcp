# Supervised Deployment

This document defines the supervised deployment package, operational lifecycle, smoke gate verification, log rotation, restart semantics, and safe cutover procedures for `firstmate_mcp`.

---

## 1. Architectural Overview

`firstmate_mcp` is a TypeScript MCP (Model Context Protocol) server composing tools and fleet smarts over **stdio** (newline-delimited JSON-RPC 2.0).

- **Supervisor**: macOS `launchd` in user agent scope (`~/Library/LaunchAgents/com.firstmate.mcp.plist`).
- **Transport**: Standard I/O (`stdin`/`stdout`). Local-only transport ensures zero network attack surface.
- **Runtime**: Native **Bun** (default) or **Node.js** (>= 20) with TypeScript artifacts compiled to `ts/dist/server.js`.
- **Health & Gate Signals**: Fail-closed smoke gate (`scripts/fm-mcp-smoke.sh`) executing `initialize` → `ping` → `tools/list` (with version assertion) → Tier-1 read.
- **Log Ownership**: Server operates strictly append-only on stderr and audit JSONL (`$FM_HOME/state/mcp-audit.jsonl`). External rotation is handled via copytruncate (`scripts/fm-mcp-logrotate.sh`).
- **Receipts & State Continuity**: Durably confined to `$FM_HOME/state/mcp-receipts/`.

---

## 2. Configuration & Parameterization Reference

All paths, binaries, log destinations, and tokens are parameterized via environment variables and CLI flags with safe defaults. **Never hardcode machine-specific paths.**

| Variable | CLI Flag | Default Value | Description |
| :--- | :--- | :--- | :--- |
| `FM_HOME` | `--home` | *(Required)* | Absolute path to the firstmate home directory |
| `FIRSTMATE_MCP_DIR` | `--mcp-dir` | Repository root | Root directory of the `firstmate_mcp` checkout |
| `FM_MCP_SERVER` | `--server` | `ts` | Server implementation (`ts`) |
| `FM_MCP_RUNTIME` | `--runtime` | `bun` (fallback: `node`) | Runtime executable (`bun` or `node`) |
| `FM_AUDIT_LOG` | `--audit-log` | `$FM_HOME/state/mcp-audit.jsonl` | Append-only JSONL audit log path |
| `FM_ACTOR` | `--actor` | `mcp-agent` | Calling actor identity for audit attribution |
| `FM_LOG_DIR` | `--log-dir` | `$FM_HOME/logs` | Base directory for supervisor and stderr logs |
| `STDERR_LOG` | `--stderr` | `$FM_LOG_DIR/mcp-stderr.log` | Destination for server stderr output |
| `STDOUT_LOG` | `--stdout` | `/dev/null` | Destination for stdout (managed by MCP client pipe) |
| `PATH` | `--path` | Shim-free (runtime dir + `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`) | PATH environment variable provided to launchd unit. Never inherit an interactive PATH: pyenv shims hang under launchd (2026-09-22). |
| `FMX_PAIRING_TOKEN` | `--pairing-token` | *(None)* | Optional pairing token for relay tools |
| `FM_RELEASE_GRANT` | `--release-grant` | `0` | Captain-hold release grant flag (`1` enables 3rd-party release) |
| `SMOKE_TIMEOUT_S` | `--timeout` | `15` | Timeout in seconds for the smoke gate run |
| `SMOKE_TIER1_TOOL` | `--tool` | `status_tail` | Tier-1 tool executed during smoke verification |
| `MAX_SIZE_MB` | `--max-size-mb` | `50` | Maximum log size before rotation triggers |
| `RETENTION_DAYS` | `--retention-days`| `14` | Archive retention window in days |

---

## 3. Step-by-Step Installation Procedure

### Prerequisites
- macOS 12+ with `launchd`
- **Bun** (>= 1.0) or **Node.js** (>= 20.0.0)
- **pnpm** (>= 9.0)
- A valid firstmate fleet home directory containing `$FM_HOME/bin/fm-fleet-snapshot.sh`

### Step 1: Build the Server Artifact
```bash
cd /path/to/firstmate_mcp/ts
pnpm install
pnpm run build
pnpm run build:tests
```
Verify compilation output: `ts/dist/server.js` must exist.

### Step 2: Run Pre-Flight Smoke Gate
Before registering with the supervisor, verify protocol compliance against the fleet home:
```bash
cd /path/to/firstmate_mcp
./scripts/fm-mcp-smoke.sh --home /path/to/firstmate --runtime bun
```
Expected output: exit code `0` and `=== Smoke Gate PASSED ===` on stderr.

### Step 3: Render the launchd Plist
Render the user agent plist template to your user's LaunchAgents directory:
```bash
mkdir -p ~/Library/LaunchAgents
./scripts/fm-mcp-render-plist.sh \
  --home /path/to/firstmate \
  --runtime bun \
  --output ~/Library/LaunchAgents/com.firstmate.mcp.plist
```

Validate plist syntax:
```bash
plutil -lint ~/Library/LaunchAgents/com.firstmate.mcp.plist
```

### Step 4: Load and Start the Service
Bootstrap the service into the user GUI domain:
```bash
# macOS 11+ recommended:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.firstmate.mcp.plist

# Or legacy load:
launchctl load ~/Library/LaunchAgents/com.firstmate.mcp.plist
```

### Step 5: Verify Running Service
Check service status with `launchctl`:
```bash
launchctl list | grep com.firstmate.mcp
```
Check stderr log:
```bash
tail -n 20 /path/to/firstmate/logs/mcp-stderr.log
```

---

## 4. Smoke Gate Verification (`scripts/fm-mcp-smoke.sh`)

The smoke gate provides a fast, deterministic, fail-closed verification of server integrity over stdio:

### Protocol Sequence
1. **`initialize`**: Sends protocol version negotiation (`2024-11-05`), asserts `serverInfo.name` is present, and asserts `serverInfo.version` matches the expected release pin.
2. **`notifications/initialized`**: Dispatches MCP client initialization acknowledgement.
3. **`ping`**: Sends an unauthenticated `ping` probe and asserts empty `{}` result.
4. **`tools/list`**: Queries all registered tools, asserting tool count (>= 50 tools) and presence of core tools (`fleet_snapshot`, `backlog`, `status_tail`, `guard_check`, `receipt_submit`, `receipt_status`).
5. **Tier-1 Read (`tools/call`)**: Executes an unauthenticated open read tool (`status_tail` by default) and asserts valid envelope structure.

### Fail-Closed Exit Codes
- `0`: Smoke gate passed (all 4 stages verified).
- `1`: Assertion or protocol failure (version mismatch, missing tool, bad envelope).
- `2`: Configuration or environment error (missing home, invalid arguments, runtime unavailable).
- `3`: Timeout or unexpected process termination.

### Stdout-Pristine Guarantee
All diagnostic messages and timings are written strictly to **stderr**. When invoked with `--json`, a single machine-readable JSON object is emitted on **stdout**:
```json
{"status": "pass", "server_name": "firstmate_mcp", "server_version": "0.3.0", "tools_count": 84, "tier1_tool": "status_tail", "duration_ms": 320.5}
```

---

## 5. Log Ownership & Rotation Strategy (`scripts/fm-mcp-logrotate.sh`)

### Server Log Ownership
- **Append-Only Guarantee**: The TypeScript server opens logs with append flags and never performs truncation, rotation, or deletion.
- **Audit JSONL** (`$FM_HOME/state/mcp-audit.jsonl`): Exactly one JSON record per `tools/call` with execution timestamp, tool name, actor, approval hash, duration, and decision digest.
- **Stderr Log** (`$FM_HOME/logs/mcp-stderr.log`): Unstructured diagnostics, fatal errors, and startup telemetry.

### Rotation Mechanism: `copytruncate`
Because long-running Node/Bun processes maintain open file descriptors, `fm-mcp-logrotate.sh` uses **copytruncate**:
1. Copies active log to a timestamped archive: `mcp-audit.jsonl.YYYYMMDD_HHMMSS`.
2. Truncates the active log file in place to `0` bytes (`: > file`).
3. Compresses the archive using `gzip -9` (`mcp-audit.jsonl.YYYYMMDD_HHMMSS.gz`).
4. Prunes archives older than `RETENTION_DAYS` (default: 14 days).

### Running Log Rotation
Manually, by the maintenance agent (`com.firstmate.mcp.maintenance`, which runs
`scripts/fm-mcp-maintenance.sh` on a 24h interval: smoke gate first, rotation
only if it passes), or in cron:
```bash
./scripts/fm-mcp-logrotate.sh --home /path/to/firstmate --max-size-mb 50 --retention-days 14
```

Dry-run simulation:
```bash
./scripts/fm-mcp-logrotate.sh --home /path/to/firstmate --dry-run
```

---

## 6. Restart Semantics & State Continuity

| Subsystem | Behavior on Restart | Continuity Guarantee |
| :--- | :--- | :--- |
| **In-Flight Tool Calls** | Terminated immediately | Subprocess process groups are killed via SIGTERM/SIGKILL; no orphan processes remain. |
| **Async Receipts** | Preserved across restarts | Receipts live in `$FM_HOME/state/mcp-receipts/`. As long as `$FM_HOME` is unchanged, pending/done/failed receipts remain queryable via `receipt_status`. |
| **Audit Log** | Preserved across restarts | Server re-opens `$FM_AUDIT_LOG` in append mode; historical records are never overwritten. |
| **Fleet State & Locks** | Preserved | Fleet backlogs and locks in `$FM_HOME/state/` remain authoritative. |

---

## 7. Update Procedure (Zero-Risk Cutover)

To deploy an updated release of `firstmate_mcp`:

```bash
# Step 1: Navigate to repository checkout
cd /path/to/firstmate_mcp

# Step 2: Fetch and checkout target revision
git fetch origin
git checkout v0.x.y  # or target commit

# Step 3: Rebuild TypeScript server distribution
cd ts
pnpm install
pnpm run build
pnpm run build:tests
cd ..

# Step 4: Run pre-cutover smoke gate
./scripts/fm-mcp-smoke.sh --home /path/to/firstmate --runtime bun

# Step 5: Execute atomic cutover in launchd
launchctl kickstart -k gui/$(id -u)/com.firstmate.mcp

# Step 6: Verify post-cutover health
./scripts/fm-mcp-smoke.sh --home /path/to/firstmate --runtime bun
```

### Rollback Procedure
If the post-cutover smoke test fails:
```bash
# Roll back git reference
git checkout PREVIOUS_KNOWN_GOOD_TAG

# Rebuild
cd ts && pnpm run build && cd ..

# Restart service
launchctl kickstart -k gui/$(id -u)/com.firstmate.mcp

# Verify
./scripts/fm-mcp-smoke.sh --home /path/to/firstmate
```
