#!/usr/bin/env python3
"""Thin Python-boundary adapter: one MCP tools/call over stdio, no assertions.

Usage:
  FM_HOME=/tmp/stub python3 tests/upstream/adapters/mcp_call.py fleet_snapshot '{}'
"""
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent.parent
SERVER = ROOT / "fm_mcp_server.py"


def main():
    if len(sys.argv) != 3:
        print("usage: mcp_call.py <tool> '<json-args>'", file=sys.stderr)
        return 2
    tool, args = sys.argv[1], json.loads(sys.argv[2])
    proc = subprocess.Popen(
        ["python3", str(SERVER)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        bufsize=1,
        env=dict(os.environ),
    )
    assert proc.stdin is not None and proc.stdout is not None
    proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                 "params": {"name": tool, "arguments": args}}) + "\n")
    proc.stdin.flush()
    line = proc.stdout.readline()
    print(line.strip())
    try:
        proc.stdin.close()
    except Exception:
        pass
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
