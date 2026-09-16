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


def get_by_year_month(conn: sqlite3.Connection, year: int, month: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM periods WHERE year = ? AND month = ?", (year, month)
    ).fetchone()


def list_in_range(conn: sqlite3.Connection, year: int, month_from: int, month_to: int) -> list[sqlite3.Row]:
    """Periods that exist within one calendar year's month span, chronologically.

    Returns only what has actually been imported — a range of Jan..Aug on a database holding
    May..Aug returns four rows, not eight. Callers that need to know which months are absent
    ask `comparative_readiness`; conflating "no row" with "zero" is the whole trap here.
    """
    return conn.execute(
        """SELECT * FROM periods WHERE year = ? AND month BETWEEN ? AND ?
           ORDER BY month""",
        (year, month_from, month_to),
    ).fetchall()


def comparative_readiness(conn: sqlite3.Connection, months: list[tuple[int, int]]) -> dict:
    """What a comparative range can and cannot show, for the warning banners.

    Takes (year, month) pairs rather than period_ids — the most important thing to report is
    the months that have no period row at all, and those have no id to pass in.

    - `missing`: no period row, or a period row with nothing in consolidated_tb. Either way
      the column has no figures; it contributes zero to a YTD sum and must display as "—".
    - `open`: present but not locked. Figures can still move. Warn, never block (locked
      decision, PLAN_PHASE8).
    - `stale`: consolidated, but an adjustment has changed since. The numbers shown are not
      what a re-consolidate would produce.
    """
    missing: list[str] = []
    open_periods: list[str] = []
    stale: list[str] = []

    for year, month in months:
        label = f"{year}-{month:02d}"
        period = get_by_year_month(conn, year, month)
        if period is None:
            missing.append(label)
            continue
        has_data = conn.execute(
            "SELECT 1 FROM consolidated_tb WHERE period_id = ? LIMIT 1", (period["period_id"],)
        ).fetchone() is not None
        if not has_data:
            missing.append(label)
            continue
        if period["status"] != "locked":
            open_periods.append(label)
        if is_consolidation_stale(conn, period["period_id"]):
            stale.append(label)

    return {"missing": missing, "open": open_periods, "stale": stale}


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


def mark_consolidated(conn: sqlite3.Connection, period_id: int) -> None:
    """Records both a human-readable timestamp and the current high-water mark of
    audit_log.log_id. Staleness detection (below) uses the log_id marker, not the
    timestamp — see migration 005 for why: wall-clock comparison is unreliable when
    operations happen faster than clock resolution, which real automated/test use hits
    often enough to matter."""
    latest_log_id = conn.execute("SELECT COALESCE(MAX(log_id), 0) FROM audit_log").fetchone()[0]
    conn.execute(
        "UPDATE periods SET consolidated_at = ?, consolidated_through_log_id = ? WHERE period_id = ?",
        (datetime.now(timezone.utc).isoformat(), latest_log_id, period_id),
    )


def is_consolidation_stale(conn: sqlite3.Connection, period_id: int) -> bool:
    """True when an adjustment for this period has been created, edited, applied, or
    deleted since the last successful consolidate. Compares the audit_log.log_id
    high-water mark recorded at that consolidate against the newest audit_log.log_id for
    table_name='adjustments' on that period's *current* adjustment ids — an adjustment
    deleted after consolidation won't be caught by this (its id no longer resolves to the
    period), which matches the source plan's described approach rather than adding
    further tracking to catch that edge case precisely."""
    period = conn.execute(
        "SELECT consolidated_at, consolidated_through_log_id FROM periods WHERE period_id = ?", (period_id,)
    ).fetchone()
    if period is None or period["consolidated_at"] is None:
        return False

    adjustment_ids = [
        str(r["adjustment_id"]) for r in
        conn.execute("SELECT adjustment_id FROM adjustments WHERE period_id = ?", (period_id,)).fetchall()
    ]
    if not adjustment_ids:
        return False

    placeholders = ",".join("?" for _ in adjustment_ids)
    row = conn.execute(
        f"""SELECT MAX(log_id) AS latest FROM audit_log
            WHERE table_name = 'adjustments' AND record_id IN ({placeholders})""",
        adjustment_ids,
    ).fetchone()
    if row is None or row["latest"] is None:
        return False

    return row["latest"] > period["consolidated_through_log_id"]
