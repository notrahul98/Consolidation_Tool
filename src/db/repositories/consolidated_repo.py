import sqlite3


def clear_period(conn: sqlite3.Connection, period_id: int) -> None:
    conn.execute("DELETE FROM consolidated_tb WHERE period_id = ?", (period_id,))


def insert_row(conn: sqlite3.Connection, period_id: int, group_account_id: int, entity_id: int | None,
               opening_dr: float, opening_cr: float, period_dr: float, period_cr: float,
               closing_dr: float, closing_cr: float, source_type: str = "entity_tb") -> None:
    conn.execute(
        """INSERT INTO consolidated_tb
           (period_id, group_account_id, entity_id, source_type,
            opening_dr, opening_cr, period_dr, period_cr, closing_dr, closing_cr)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (period_id, group_account_id, entity_id, source_type,
         opening_dr, opening_cr, period_dr, period_cr, closing_dr, closing_cr),
    )


def get_matrix(conn: sqlite3.Connection, period_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        """SELECT ctb.*, gc.account_code, gc.account_name, gc.statement_type, gc.section,
                  gc.line_item_order, e.entity_code
           FROM consolidated_tb ctb
           JOIN group_coa gc ON ctb.group_account_id = gc.group_account_id
           LEFT JOIN entities e ON ctb.entity_id = e.entity_id
           WHERE ctb.period_id = ?
           ORDER BY gc.line_item_order, e.sort_order""",
        (period_id,),
    ).fetchall()
