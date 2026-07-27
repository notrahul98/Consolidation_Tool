"""Structured double-entry adjustments — replaces manually editing TB numbers.
Validation rules per the source plan Section 6.3: debits must equal credits, no line
may carry both a debit and a credit, at least 2 lines, narration required."""

import sqlite3

from src.db.repositories import adjustment_repo, period_repo

TOLERANCE_IDR = 0


def validate(narration: str, lines: list[dict], adjustment_type: str | None = None) -> list[str]:
    errors = []
    if not narration or not narration.strip():
        errors.append("Adjustment narration is required")
    if adjustment_type is not None and adjustment_type not in adjustment_repo.VALID_TYPES:
        errors.append(f"Unknown adjustment type '{adjustment_type}' — must be one of {sorted(adjustment_repo.VALID_TYPES)}")
    if len(lines) < 2:
        errors.append("An adjustment needs at least 2 lines")
    total_dr = sum(l.get("debit_amount", 0.0) for l in lines)
    total_cr = sum(l.get("credit_amount", 0.0) for l in lines)
    if abs(total_dr - total_cr) > TOLERANCE_IDR:
        errors.append(f"Adjustment does not balance: debits={total_dr:,.2f} credits={total_cr:,.2f}")
    for i, l in enumerate(lines, start=1):
        if l.get("debit_amount", 0.0) and l.get("credit_amount", 0.0):
            errors.append(f"Line {i}: cannot carry both a debit and a credit")
    return errors


def create_adjustment(conn: sqlite3.Connection, period_id: int, external_ref: str, adjustment_type: str,
                        narration: str, lines: list[dict], user: str | None = None) -> int:
    period = conn.execute("SELECT * FROM periods WHERE period_id = ?", (period_id,)).fetchone()
    if period["status"] == "locked":
        raise ValueError(f"Period {period['year']}-{period['month']:02d} is locked; cannot add adjustments")

    errors = validate(narration, lines, adjustment_type)
    if errors:
        raise ValueError(f"Adjustment '{external_ref}' is invalid:\n" + "\n".join(errors))

    return adjustment_repo.create_or_replace(conn, period_id, external_ref, adjustment_type, narration,
                                               lines, user=user)


def copy_prior_month(conn: sqlite3.Connection, target_period_id: int, user: str | None = None) -> int:
    """Copies every adjustment from the chronologically prior period into the target
    period as new drafts, narration tagged '(copied from [period])' per the source plan's
    acceptance criterion — matching the user's existing copy-prior-month habit."""
    period_repo.require_open(conn, target_period_id, "copy adjustments into it")

    prior = period_repo.get_prior(conn, target_period_id)
    if prior is None:
        raise ValueError("No prior period exists to copy adjustments from")

    source_adjustments = adjustment_repo.list_for_period(conn, prior["period_id"])
    copied = 0
    for adj in source_adjustments:
        lines = [
            {
                "entity_id": l["entity_id"],
                "group_account_id": l["group_account_id"],
                "debit_amount": l["debit_amount"],
                "credit_amount": l["credit_amount"],
                "line_narration": l["line_narration"],
            }
            for l in adjustment_repo.get_lines(conn, adj["adjustment_id"])
        ]
        narration = adj["narration"]
        tag = f"(copied from {prior['year']}-{prior['month']:02d})"
        if tag not in narration:
            narration = f"{narration} {tag}"
        adjustment_repo.create_or_replace(
            conn, target_period_id, adj["external_ref"], adj["adjustment_type"], narration, lines,
            user=user, copied_from_period_id=prior["period_id"],
        )
        copied += 1
    return copied
