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


def get_buckets(conn: sqlite3.Connection, period_id: int) -> tuple[dict, dict, dict]:
    """The single aggregation of consolidated_tb used by BOTH the Consolidated TB page and
    the Excel pack, so the screen and the workbook cannot drift apart.

    Returns (by_account_entity, group_adjustment, total):
      by_account_entity[(group_account_id, entity_id)]
          that entity's TB plus any adjustment booked directly against that entity, summed
          (never overwritten — see the entity+adjustment bug in HANDOVER.md §9.6).
      group_adjustment[group_account_id]
          adjustments carrying no entity. They belong to no entity column, so they have to
          be added on top of the entity columns to reach the total.
      total[group_account_id]
          the authoritative 'total' row — the same figure compute_pl/compute_bs read.

    The trap this exists to close: group-level adjustment rows and 'total' rows BOTH carry
    entity_id IS NULL, so bucketing by entity_id alone silently merges them. Separate by
    source_type first, always.
    """
    by_account_entity: dict[tuple[int, int | None], float] = {}
    group_adjustment: dict[int, float] = {}
    total: dict[int, float] = {}

    for r in get_matrix(conn, period_id):
        account_id = r["group_account_id"]
        signed = (r["closing_dr"] or 0) - (r["closing_cr"] or 0)
        if r["source_type"] == "total":
            total[account_id] = total.get(account_id, 0.0) + signed
        elif r["source_type"] == "adjustment" and r["entity_id"] is None:
            group_adjustment[account_id] = group_adjustment.get(account_id, 0.0) + signed
        else:
            key = (account_id, r["entity_id"])
            by_account_entity[key] = by_account_entity.get(key, 0.0) + signed

    return by_account_entity, group_adjustment, total


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
