"""Typed result/error envelope for adapter returns.

Every dispatch returns exactly one shape so MCP tool handlers never branch
on ad-hoc script output:

  ok:  {"ok": True, ...fields}
  err: {"ok": False, "error": {"code": ..., "message": ..., ...extra}}

The error code is a stable machine-readable slug; message is human-readable
and may carry the PoC-style "expect" hint naming the valid shape.
"""


def ok(**fields):
    """Success envelope carrying the tool result fields."""
    result = {"ok": True}
    result.update(fields)
    return result


def err(code, message, **extra):
    """Error envelope with a stable code, a message, and optional detail."""
    detail = {"code": code, "message": message}
    detail.update(extra)
    return {"ok": False, "error": detail}


def is_ok(envelope):
    """True when the envelope is a success result."""
    return isinstance(envelope, dict) and envelope.get("ok") is True


def is_err(envelope):
    """True when the envelope is an error result."""
    return isinstance(envelope, dict) and envelope.get("ok") is False
