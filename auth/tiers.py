import hashlib

APPROVAL_PREFIX = "I authorize"
APPROVAL_MAX_CHARS = 500

TIER_OPEN = 1
TIER_STEER = 2
TIER_AUTHORITY = 3
TIER_EXTERNAL = 4
TIER_FORBIDDEN = "forbidden"

TOOL_TIERS = {
    "fleet_snapshot": TIER_OPEN,
    "backlog": TIER_OPEN,
    "crew_state": TIER_OPEN,
    "status_tail": TIER_OPEN,
    "fleet_poll": TIER_OPEN,
    "receipt_submit": TIER_OPEN,
    "receipt_status": TIER_OPEN,
    "send_message": TIER_STEER,
    "lifecycle_interrupt": TIER_AUTHORITY,
    "lifecycle_exit": TIER_AUTHORITY,
    "lifecycle_relaunch": TIER_AUTHORITY,
    "lifecycle_suspend": TIER_AUTHORITY,
    "lifecycle_resume": TIER_AUTHORITY,
    "spawn_crew": TIER_AUTHORITY,
    "scaffold_brief": TIER_AUTHORITY,
    "decision_hold": TIER_AUTHORITY,
    "decision_resolve": TIER_AUTHORITY,
    "review_decision": TIER_AUTHORITY,
    "relay_reply": TIER_EXTERNAL,
    "relay_dismiss": TIER_EXTERNAL,
    "relay_followup": TIER_EXTERNAL,
}

FORBIDDEN_TOOLS = (
    "promote_scout",
    "teardown_crew",
    "arm_pr_check",
    "merge_pr",
    "merge_local",
)

TIER_NAMES = {
    TIER_OPEN: "open reads",
    TIER_STEER: "reversible steers",
    TIER_AUTHORITY: "authority writes",
    TIER_EXTERNAL: "external sends",
    TIER_FORBIDDEN: "code-forbidden",
}


def tier_of(tool):
    if tool in TOOL_TIERS:
        return TOOL_TIERS[tool]
    if tool in FORBIDDEN_TOOLS:
        return TIER_FORBIDDEN
    return None


def requires_approval(tool):
    return tier_of(tool) in (TIER_AUTHORITY, TIER_EXTERNAL, TIER_FORBIDDEN, None)


def valid_approval(value):
    return (
        isinstance(value, str)
        and value.startswith(APPROVAL_PREFIX)
        and len(value) <= APPROVAL_MAX_CHARS
    )


def approval_ref(approval):
    if not isinstance(approval, str) or not approval:
        return None
    return hashlib.sha256(approval.encode("utf-8")).hexdigest()[:16]


def check(tool, approval=None):
    tier = tier_of(tool)
    if tier is None:
        return False, "unknown-tool"
    if tier == TIER_FORBIDDEN:
        return False, "forbidden"
    if tier in (TIER_OPEN, TIER_STEER):
        return True, "ok"
    if valid_approval(approval):
        return True, "ok"
    if approval is None:
        return False, "approval-required"
    return False, "approval-invalid"
