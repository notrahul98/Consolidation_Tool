import sqlite3
from datetime import datetime, timezone

from src.services import audit_service


def get_or_create(conn: sqlite3.Connection, year: int, month: int) -> int:
    row = conn.execute(
        "SELECT period_id FROM periods WHERE year = ? AND month = ?", (year, month)
    ).fetchone()
    if row:
        return row["period_id"]
    cur = conn.execute("INSERT INTO periods (year, month) VALUES (?, ?)", (year, month))
    return cur.lastrowid


def parse_period_str(period_str: str) -> tuple[int, int]:
    """'2026-06' -> (2026, 6)"""
    year_str, month_str = period_str.split("-")
    return int(year_str), int(month_str)


def get_by_str(conn: sqlite3.Connection, period_str: str) -> sqlite3.Row | None:
    year, month = parse_period_str(period_str)
    return conn.execute(
        "SELECT * FROM periods WHERE year = ? AND month = ?", (year, month)
    ).fetchone()


def list_all(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM periods ORDER BY year DESC, month DESC").fetchall()


def as_str(period_row: sqlite3.Row) -> str:
    return f"{period_row['year']}-{period_row['month']:02d}"


def get_prior(conn: sqlite3.Connection, period_id: int) -> sqlite3.Row | None:
    """The chronologically preceding period, if one has been imported."""
    current = conn.execute("SELECT * FROM periods WHERE period_id = ?", (period_id,)).fetchone()
    prior_year, prior_month = (current["year"], current["month"] - 1) if current["month"] > 1 \
        else (current["year"] - 1, 12)
    return conn.execute(
        "SELECT * FROM periods WHERE year = ? AND month = ?", (prior_year, prior_month)
    ).fetchone()


def require_open(conn: sqlite3.Connection, period_id: int, action: str = "modify this period") -> None:
    """Guard for every write path that touches a period's data. Raises if locked — the
    single enforcement point all 5 write paths (TB import, mapping changes, consolidate,
    adjustment apply, adjustment delete) call through, so 'locked means immutable' is
    actually true everywhere, not just for creating new adjustments."""
    period = conn.execute("SELECT * FROM periods WHERE period_id = ?", (period_id,)).fetchone()
    if period is not None and period["status"] == "locked":
        raise ValueError(f"Period {period['year']}-{period['month']:02d} is locked; cannot {action}")


def lock(conn: sqlite3.Connection, period_id: int, user: str | None = None) -> None:
    conn.execute(
        "UPDATE periods SET status = 'locked', locked_at = ?, locked_by = ? WHERE period_id = ?",
        (datetime.now(timezone.utc).isoformat(), user, period_id),
    )
    audit_service.log(conn, "lock", "periods", str(period_id), user=user)


def unlock(conn: sqlite3.Connection, period_id: int, user: str | None = None) -> None:
    conn.execute(
        "UPDATE periods SET status = 'open', locked_at = NULL, locked_by = NULL WHERE period_id = ?",
        (period_id,),
    )
    audit_service.log(conn, "unlock", "periods", str(period_id), user=user)
