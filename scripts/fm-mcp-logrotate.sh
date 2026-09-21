#!/usr/bin/env bash
# Log rotation and retention management for firstmate_mcp.
#
# Server log ownership:
#   The TypeScript MCP server operates strictly in append-only mode:
#     - $FM_AUDIT_LOG ($FM_HOME/state/mcp-audit.jsonl): one JSON line per tools/call
#     - stderr ($FM_HOME/logs/mcp-stderr.log): server startup and error diagnostics
#     - stdout: preserved exclusively for stdio JSON-RPC framing (no logs)
#   The server NEVER rotates, truncates, or deletes logs.
#
# Rotation mechanism:
#   Uses copytruncate (copy active log to timestamped archive, then truncate
#   the active file to 0 bytes in place). This allows long-running Node/Bun
#   server processes to continue appending seamlessly without process restarts,
#   signal handling, or losing in-flight writes.
#
# Usage:
#   scripts/fm-mcp-logrotate.sh --home /path/to/firstmate [OPTIONS]
#
# Options:
#   --home PATH             Firstmate home directory (required or via FM_HOME)
#   --audit-log PATH        Audit JSONL log path (default: $FM_HOME/state/mcp-audit.jsonl)
#   --log-dir PATH          Log directory (default: $FM_HOME/logs)
#   --stderr PATH           Stderr log path (default: $LOG_DIR/mcp-stderr.log)
#   --max-size-mb MB        Rotate only if file exceeds size in MB (default: 50)
#   --retention-days DAYS   Delete archives older than N days (default: 14)
#   --compress              Compress rotated archives with gzip (default: true)
#   --no-compress           Do not compress rotated archives
#   --force                 Rotate immediately regardless of file size
#   --dry-run               Simulate rotation and cleanup without modifying files
#   --quiet                 Suppress non-error output
#   -h, --help              Show this help message
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

HOME_ARG="${FM_HOME:-}"
AUDIT_LOG_ARG="${FM_AUDIT_LOG:-}"
LOG_DIR_ARG="${FM_LOG_DIR:-}"
STDERR_ARG=""
MAX_SIZE_MB=50
RETENTION_DAYS=14
COMPRESS=1
FORCE=0
DRY_RUN=0
QUIET=0

fail() {
  printf 'fm-mcp-logrotate: %s\n' "$1" >&2
  exit "${2:-2}"
}

usage() {
  sed -n '2,27p' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --home) HOME_ARG="${2:-}"; shift 2 ;;
    --home=*) HOME_ARG="${1#--home=}"; shift ;;
    --audit-log) AUDIT_LOG_ARG="${2:-}"; shift 2 ;;
    --audit-log=*) AUDIT_LOG_ARG="${1#--audit-log=}"; shift ;;
    --log-dir) LOG_DIR_ARG="${2:-}"; shift 2 ;;
    --log-dir=*) LOG_DIR_ARG="${1#--log-dir=}"; shift ;;
    --stderr) STDERR_ARG="${2:-}"; shift 2 ;;
    --stderr=*) STDERR_ARG="${1#--stderr=}"; shift ;;
    --max-size-mb) MAX_SIZE_MB="${2:-}"; shift 2 ;;
    --max-size-mb=*) MAX_SIZE_MB="${1#--max-size-mb=}"; shift ;;
    --retention-days) RETENTION_DAYS="${2:-}"; shift 2 ;;
    --retention-days=*) RETENTION_DAYS="${1#--retention-days=}"; shift ;;
    --compress) COMPRESS=1; shift ;;
    --no-compress) COMPRESS=0; shift ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --quiet) QUIET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) fail "unknown flag: $1 (see --help)" 2 ;;
    *) fail "unexpected argument: $1 (see --help)" 2 ;;
  esac
done

[ -n "$HOME_ARG" ] || fail "missing required --home (or FM_HOME env var)" 2
case "$HOME_ARG" in
  /*) : ;;
  *) fail "--home must be an absolute path, got: $HOME_ARG" 2 ;;
esac

if [ -z "$AUDIT_LOG_ARG" ]; then
  AUDIT_LOG_ARG="$HOME_ARG/state/mcp-audit.jsonl"
fi
if [ -z "$LOG_DIR_ARG" ]; then
  LOG_DIR_ARG="$HOME_ARG/logs"
fi
if [ -z "$STDERR_ARG" ]; then
  STDERR_ARG="$LOG_DIR_ARG/mcp-stderr.log"
fi

log_info() {
  if [ "$QUIET" = 0 ]; then
    printf 'fm-mcp-logrotate: %s\n' "$1" >&2
  fi
}

rotate_file() {
  local target="$1"
  local label="$2"
  
  if [ ! -f "$target" ]; then
    log_info "skipping $label ($target): file does not exist"
    return 0
  fi

  local size_bytes
  size_bytes=$(python3 -c "import os; print(os.path.getsize('$target'))" 2>/dev/null || echo 0)
  local max_bytes=$((MAX_SIZE_MB * 1024 * 1024))

  if [ "$FORCE" = 0 ] && [ "$size_bytes" -lt "$max_bytes" ]; then
    log_info "$label ($target) is $((size_bytes / 1024))KB (< ${MAX_SIZE_MB}MB threshold); skipping rotation"
    return 0
  fi

  local timestamp
  timestamp=$(date -u +"%Y%m%d_%H%M%S")
  local archive="${target}.${timestamp}"

  log_info "rotating $label ($target, $((size_bytes / 1024))KB) -> $archive"

  if [ "$DRY_RUN" = 1 ]; then
    log_info "[dry-run] would copy $target -> $archive and truncate $target"
    if [ "$COMPRESS" = 1 ]; then
      log_info "[dry-run] would gzip $archive -> ${archive}.gz"
    fi
    return 0
  fi

  # Step 1: Copy active log to archive
  cp "$target" "$archive"

  # Step 2: Atomically truncate active log in place
  : > "$target"

  # Step 3: Compress archive if requested
  if [ "$COMPRESS" = 1 ] && command -v gzip >/dev/null 2>&1; then
    gzip -9 "$archive"
    log_info "compressed archive -> ${archive}.gz"
  fi
}

purge_old_archives() {
  local dir="$1"
  local pattern="$2"

  if [ ! -d "$dir" ]; then
    return 0
  fi

  python3 - <<PYEOF
import os
import time
import glob

directory = "$dir"
pattern = "$pattern"
retention_days = float("$RETENTION_DAYS")
dry_run = bool(int("$DRY_RUN"))
quiet = bool(int("$QUIET"))

cutoff = time.time() - (retention_days * 86400)
search_pattern = os.path.join(directory, pattern)

for path in glob.glob(search_pattern):
    if not os.path.isfile(path):
        continue
    try:
        mtime = os.path.getmtime(path)
        if mtime < cutoff:
            age_days = (time.time() - mtime) / 86400
            if dry_run:
                if not quiet:
                    print(f"fm-mcp-logrotate: [dry-run] would purge {path} (age: {age_days:.1f} days > {retention_days} days)", flush=True)
            else:
                os.remove(path)
                if not quiet:
                    print(f"fm-mcp-logrotate: purged old archive {path} (age: {age_days:.1f} days)", flush=True)
    except Exception as e:
        print(f"fm-mcp-logrotate [ERROR]: failed to check/purge {path}: {e}", file=sys.stderr, flush=True)
PYEOF
}

rotate_file "$AUDIT_LOG_ARG" "audit JSONL"
rotate_file "$STDERR_ARG" "stderr log"

# Purge archives older than retention threshold
audit_dir=$(dirname "$AUDIT_LOG_ARG")
audit_base=$(basename "$AUDIT_LOG_ARG")
purge_old_archives "$audit_dir" "${audit_base}.*"

stderr_dir=$(dirname "$STDERR_ARG")
stderr_base=$(basename "$STDERR_ARG")
purge_old_archives "$stderr_dir" "${stderr_base}.*"

log_info "log rotation and retention check complete"
exit 0
