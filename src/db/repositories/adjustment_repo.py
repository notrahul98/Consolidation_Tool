import sqlite3
from datetime import datetime, timezone

from src.db.repositories import period_repo
from src.services import audit_service

VALID_TYPES = {"reclassification", "accrual", "provision", "depreciation", "tax", "management",
               "ic_elimination", "opening_correction", "inventory_movement", "other"}


def create_or_replace(conn: sqlite3.Connection, period_id: int, external_ref: str, adjustment_type: str,
                        narration: str, lines: list[dict], user: str | None = None,
                        copied_from_period_id: int | None = None) -> int:
    """Upsert by (period_id, external_ref): if it exists, replace its lines wholesale
    (matches how the Mapping.xlsx round-trip treats re-imports) and log to the audit trail."""
    existing = conn.execute(
        "SELECT adjustment_id FROM adjustments WHERE period_id = ? AND external_ref = ?",
        (period_id, external_ref),
    ).fetchone()

    if existing:
        adjustment_id = existing["adjustment_id"]
        conn.execute("DELETE FROM adjustment_lines WHERE adjustment_id = ?", (adjustment_id,))
        conn.execute(
            """UPDATE adjustments SET adjustment_type = ?, narration = ?, status = 'draft'
               WHERE adjustment_id = ?""",
            (adjustment_type, narration, adjustment_id),
        )
        audit_service.log(conn, "update", "adjustments", str(adjustment_id), new_value=narration, user=user)
    else:
        cur = conn.execute(
            """INSERT INTO adjustments
               (period_id, external_ref, adjustment_type, narration, created_at, created_by,
                copied_from_period_id, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')""",
            (period_id, external_ref, adjustment_type, narration,
             datetime.now(timezone.utc).isoformat(), user, copied_from_period_id),
        )
        adjustment_id = cur.lastrowid
        audit_service.log(conn, "create", "adjustments", str(adjustment_id), new_value=narration, user=user)

    for line in lines:
        conn.execute(
            """INSERT INTO adjustment_lines
               (adjustment_id, entity_id, group_account_id, debit_amount, credit_amount, line_narration)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (adjustment_id, line.get("entity_id"), line["group_account_id"],
             line.get("debit_amount", 0.0), line.get("credit_amount", 0.0), line.get("line_narration")),
        )

    return adjustment_id


def get_lines(conn: sqlite3.Connection, adjustment_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM adjustment_lines WHERE adjustment_id = ?", (adjustment_id,)
    ).fetchall()


def list_for_period(conn: sqlite3.Connection, period_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM adjustments WHERE period_id = ? ORDER BY adjustment_id", (period_id,)
    ).fetchall()


def apply_all(conn: sqlite3.Connection, period_id: int, user: str | None = None) -> int:
    period_repo.require_open(conn, period_id, "apply adjustments")
    rows = conn.execute(
        "SELECT adjustment_id FROM adjustments WHERE period_id = ? AND status = 'draft'", (period_id,)
    ).fetchall()
    for r in rows:
        conn.execute("UPDATE adjustments SET status = 'applied' WHERE adjustment_id = ?", (r["adjustment_id"],))
        audit_service.log(conn, "apply", "adjustments", str(r["adjustment_id"]), user=user)
    return len(rows)


def delete(conn: sqlite3.Connection, period_id: int, adjustment_id: int, user: str | None = None) -> None:
    period_repo.require_open(conn, period_id, "delete an adjustment")
    conn.execute("DELETE FROM adjustment_lines WHERE adjustment_id = ?", (adjustment_id,))
    conn.execute("DELETE FROM adjustments WHERE adjustment_id = ?", (adjustment_id,))
    audit_service.log(conn, "delete", "adjustments", str(adjustment_id), user=user)
