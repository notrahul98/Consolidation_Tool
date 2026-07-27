import sqlite3
from datetime import datetime, timezone

from src.importers.tally_tb_parser import ParsedTB
from src.db.repositories import period_repo
from src.services import audit_service


def import_tb(conn: sqlite3.Connection, period_id: int, entity_id: int, parsed: ParsedTB,
              imported_by: str | None = None) -> int:
    """Insert (or replace, per source plan 6.1 point 6) a TB import for one entity+period."""
    period_repo.require_open(conn, period_id, "import a TB")

    existing = conn.execute(
        "SELECT import_id FROM trial_balance_imports WHERE period_id = ? AND entity_id = ?",
        (period_id, entity_id),
    ).fetchone()

    if existing:
        import_id = existing["import_id"]
        conn.execute("DELETE FROM trial_balance_lines WHERE import_id = ?", (import_id,))
        conn.execute(
            """UPDATE trial_balance_imports
               SET source_filename = ?, imported_at = ?, imported_by = ?, row_count = ?,
                   checksum = ?, grand_total_period_dr = ?, grand_total_period_cr = ?
               WHERE import_id = ?""",
            (
                parsed.source_filename,
                datetime.now(timezone.utc).isoformat(),
                imported_by,
                len(parsed.lines),
                parsed.checksum,
                parsed.grand_total_period_dr,
                parsed.grand_total_period_cr,
                import_id,
            ),
        )
        audit_service.log(conn, "re-import", "trial_balance_imports", str(import_id),
                            new_value=parsed.source_filename, user=imported_by)
    else:
        cur = conn.execute(
            """INSERT INTO trial_balance_imports
               (period_id, entity_id, source_filename, imported_at, imported_by, row_count,
                checksum, grand_total_period_dr, grand_total_period_cr)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                period_id,
                entity_id,
                parsed.source_filename,
                datetime.now(timezone.utc).isoformat(),
                imported_by,
                len(parsed.lines),
                parsed.checksum,
                parsed.grand_total_period_dr,
                parsed.grand_total_period_cr,
            ),
        )
        import_id = cur.lastrowid
        audit_service.log(conn, "import", "trial_balance_imports", str(import_id),
                            new_value=parsed.source_filename, user=imported_by)

    for line in parsed.lines:
        conn.execute(
            """INSERT INTO trial_balance_lines
               (import_id, entity_ledger_name, tally_primary_group, opening_dr, opening_cr,
                period_dr, period_cr, closing_dr, closing_cr, closing_tie_warning)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                import_id,
                line.entity_ledger_name,
                line.tally_primary_group,
                line.opening_dr,
                line.opening_cr,
                line.period_dr,
                line.period_cr,
                line.closing_dr,
                line.closing_cr,
                1 if line.closing_tie_warning else 0,
            ),
        )
    conn.commit()
    return import_id


def find_duplicate_checksum(conn: sqlite3.Connection, period_id: int, entity_id: int, checksum: str) -> bool:
    row = conn.execute(
        """SELECT 1 FROM trial_balance_imports
           WHERE period_id = ? AND entity_id = ? AND checksum = ?""",
        (period_id, entity_id, checksum),
    ).fetchone()
    return row is not None


def get_lines_for_period(conn: sqlite3.Connection, period_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        """SELECT tbl.*, tbi.entity_id, e.entity_code, tbl.mapped_group_account_id
           FROM trial_balance_lines tbl
           JOIN trial_balance_imports tbi ON tbl.import_id = tbi.import_id
           JOIN entities e ON tbi.entity_id = e.entity_id
           WHERE tbi.period_id = ?""",
        (period_id,),
    ).fetchall()


def get_imports_for_period(conn: sqlite3.Connection, period_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        """SELECT tbi.*, e.entity_code, e.entity_name
           FROM trial_balance_imports tbi
           JOIN entities e ON tbi.entity_id = e.entity_id
           WHERE tbi.period_id = ?""",
        (period_id,),
    ).fetchall()


def set_line_mapping(conn: sqlite3.Connection, line_id: int, group_account_id: int | None) -> None:
    conn.execute(
        "UPDATE trial_balance_lines SET mapped_group_account_id = ? WHERE line_id = ?",
        (group_account_id, line_id),
    )
