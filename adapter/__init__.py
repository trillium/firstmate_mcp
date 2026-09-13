"""Compatibility adapter: the ONLY layer allowed to know First Mate internals.

Boundary rule: every MCP tool calls the adapter, the adapter shells to the
owning firstmate script (never reimplements), validates ids/paths/text
limits, and returns a typed result/error envelope. Default path:
MCP tool -> adapter -> real operation.

Public surface:
  adapter.validators  id, project, note, approval, and text validation plus
                      state-path confinement to the served home.
  adapter.envelope     typed ok/error result envelope.
  adapter.dispatch     command dispatcher (tool name -> script + argv
                      builder) with an explicit deny-list for surfaces that
                      must never be reachable.
"""

from adapter.dispatch import Adapter, DENY_LIST, TOOL_NAMES
from adapter.envelope import err, is_err, is_ok, ok

__all__ = ["Adapter", "DENY_LIST", "TOOL_NAMES", "err", "is_err", "is_ok", "ok"]
