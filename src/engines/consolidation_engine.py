"""Rolls up mapped entity TB lines + applied adjustments into the consolidated TB,
mirroring the entity-columns + total matrix layout the user already works with
(their `TB Consol` sheet)."""

import sqlite3
from collections import defaultdict

from src.db.repositories import consolidated_repo

MATERIALITY_IDR = 0.0  # any non-zero closing balance is "material" for blocking purposes


def _refresh_line_mappings(conn: sqlite3.Connection, period_id: int) -> None:
    """Re-stamp each TB line's cached mapped_group_account_id from the current
    entity_coa_mapping state, so consolidate always reflects the latest categorization."""
    conn.execute(
        """UPDATE trial_balance_lines
           SET mapped_group_account_id = (
               SELECT ecm.group_account_id
               FROM entity_coa_mapping ecm
               JOIN trial_balance_imports tbi ON tbi.import_id = trial_balance_lines.import_id
               WHERE ecm.entity_id = tbi.entity_id
                 AND ecm.entity_ledger_name = trial_balance_lines.entity_ledger_name
           )
           WHERE import_id IN (
               SELECT import_id FROM trial_balance_imports WHERE period_id = ?
           )""",
        (period_id,),
    )


def _find_unmapped_material(conn: sqlite3.Connection, period_id: int) -> list[tuple[str, float]]:
    rows = conn.execute(
        """SELECT tbl.entity_ledger_name, e.entity_code,
                  (tbl.closing_dr - tbl.closing_cr) AS balance
           FROM trial_balance_lines tbl
           JOIN trial_balance_imports tbi ON tbl.import_id = tbi.import_id
           JOIN entities e ON tbi.entity_id = e.entity_id
           WHERE tbi.period_id = ? AND tbl.mapped_group_account_id IS NULL""",
        (period_id,),
    ).fetchall()
    return [
        (f"{r['entity_code']}: {r['entity_ledger_name']}", r["balance"])
        for r in rows
        if abs(r["balance"]) > MATERIALITY_IDR
    ]


def _applied_adjustment_lines(conn: sqlite3.Connection, period_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        """SELECT al.entity_id, al.group_account_id,
                  SUM(al.debit_amount) AS debit_amount, SUM(al.credit_amount) AS credit_amount
           FROM adjustment_lines al
           JOIN adjustments a ON a.adjustment_id = al.adjustment_id
           WHERE a.period_id = ? AND a.status = 'applied'
           GROUP BY al.entity_id, al.group_account_id""",
        (period_id,),
    ).fetchall()


def consolidate_period(conn: sqlite3.Connection, period_id: int) -> dict:
    period = conn.execute("SELECT * FROM periods WHERE period_id = ?", (period_id,)).fetchone()
    if period is not None and period["status"] == "locked":
        return {"blocked": True, "reason": "locked", "unmapped_material": [], "rows_written": 0}

    _refresh_line_mappings(conn, period_id)
    conn.commit()

    unmapped_material = _find_unmapped_material(conn, period_id)
    if unmapped_material:
        return {"blocked": True, "reason": "unmapped", "unmapped_material": unmapped_material, "rows_written": 0}

    consolidated_repo.clear_period(conn, period_id)
    rows_written = 0

    # entity_tb rows: pure TB data, unaffected by adjustments.
    entity_group_rows = conn.execute(
        """SELECT tbi.entity_id, tbl.mapped_group_account_id AS group_account_id,
                  SUM(tbl.opening_dr) AS opening_dr, SUM(tbl.opening_cr) AS opening_cr,
                  SUM(tbl.period_dr) AS period_dr, SUM(tbl.period_cr) AS period_cr,
                  SUM(tbl.closing_dr) AS closing_dr, SUM(tbl.closing_cr) AS closing_cr
           FROM trial_balance_lines tbl
           JOIN trial_balance_imports tbi ON tbl.import_id = tbi.import_id
           WHERE tbi.period_id = ? AND tbl.mapped_group_account_id IS NOT NULL
           GROUP BY tbi.entity_id, tbl.mapped_group_account_id""",
        (period_id,),
    ).fetchall()

    # total[account] accumulates across entity_tb rows (all entities) + adjustment rows
    # (all entities, including group-level entity_id=NULL ones) — folding adjustments into
    # a separate source_type keeps the entity_tb rows a pure, untouched mirror of the TB.
    total = defaultdict(lambda: [0.0] * 6)  # opening_dr, opening_cr, period_dr, period_cr, closing_dr, closing_cr

    for r in entity_group_rows:
        consolidated_repo.insert_row(
            conn, period_id, r["group_account_id"], r["entity_id"],
            r["opening_dr"], r["opening_cr"], r["period_dr"], r["period_cr"],
            r["closing_dr"], r["closing_cr"], source_type="entity_tb",
        )
        rows_written += 1
        t = total[r["group_account_id"]]
        t[0] += r["opening_dr"]; t[1] += r["opening_cr"]
        t[2] += r["period_dr"]; t[3] += r["period_cr"]
        t[4] += r["closing_dr"]; t[5] += r["closing_cr"]

    for r in _applied_adjustment_lines(conn, period_id):
        dr, cr = r["debit_amount"] or 0.0, r["credit_amount"] or 0.0
        # Adjustments have no opening dimension — they're a point-in-time correction to
        # this period's movement and closing balance only.
        consolidated_repo.insert_row(
            conn, period_id, r["group_account_id"], r["entity_id"],
            0.0, 0.0, dr, cr, dr, cr, source_type="adjustment",
        )
        rows_written += 1
        t = total[r["group_account_id"]]
        t[2] += dr; t[3] += cr
        t[4] += dr; t[5] += cr

    for group_account_id, (odr, ocr, pdr, pcr, cdr, ccr) in total.items():
        consolidated_repo.insert_row(
            conn, period_id, group_account_id, None,
            odr, ocr, pdr, pcr, cdr, ccr, source_type="total",
        )
        rows_written += 1

    return {"blocked": False, "unmapped_material": [], "rows_written": rows_written}
