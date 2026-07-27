"""Phase 1 validation subset: V1, V3, V5, V8, V9, V12 from the source plan's Section 6.7/10."""

import sqlite3
from dataclasses import dataclass

TOLERANCE_IDR = 1
MATERIALITY_IDR = 0.0


@dataclass
class ValidationResult:
    check_id: str
    description: str
    severity: str  # "Error" or "Warning"
    passed: bool
    details: list[str]


def _v1_entity_grand_total_ties(conn: sqlite3.Connection, period_id: int) -> ValidationResult:
    """Each entity TB: period Dr/Cr sums tie to the exported Grand Total row."""
    details = []
    rows = conn.execute(
        """SELECT tbi.import_id, e.entity_code, tbi.grand_total_period_dr, tbi.grand_total_period_cr,
                  SUM(tbl.period_dr) AS sum_dr, SUM(tbl.period_cr) AS sum_cr
           FROM trial_balance_imports tbi
           JOIN entities e ON tbi.entity_id = e.entity_id
           JOIN trial_balance_lines tbl ON tbl.import_id = tbi.import_id
           WHERE tbi.period_id = ?
           GROUP BY tbi.import_id""",
        (period_id,),
    ).fetchall()
    for r in rows:
        if abs((r["sum_dr"] or 0) - (r["grand_total_period_dr"] or 0)) > TOLERANCE_IDR:
            details.append(f"{r['entity_code']}: sum(period_dr)={r['sum_dr']:.2f} vs Grand Total {r['grand_total_period_dr']:.2f}")
        if abs((r["sum_cr"] or 0) - (r["grand_total_period_cr"] or 0)) > TOLERANCE_IDR:
            details.append(f"{r['entity_code']}: sum(period_cr)={r['sum_cr']:.2f} vs Grand Total {r['grand_total_period_cr']:.2f}")
    return ValidationResult("V1", "Each entity TB ties to its exported Grand Total (Dr/Cr)", "Error", not details, details)


def _v3_v12_material_mapped(conn: sqlite3.Connection, period_id: int) -> ValidationResult:
    rows = conn.execute(
        """SELECT e.entity_code, tbl.entity_ledger_name, (tbl.closing_dr - tbl.closing_cr) AS balance
           FROM trial_balance_lines tbl
           JOIN trial_balance_imports tbi ON tbl.import_id = tbi.import_id
           JOIN entities e ON tbi.entity_id = e.entity_id
           WHERE tbi.period_id = ? AND tbl.mapped_group_account_id IS NULL""",
        (period_id,),
    ).fetchall()
    details = [
        f"{r['entity_code']}: {r['entity_ledger_name']} ({r['balance']:.2f})"
        for r in rows if abs(r["balance"]) > MATERIALITY_IDR
    ]
    return ValidationResult("V3/V12", "All material ledgers are categorized", "Error", not details, details)


def _v5_consolidated_balances(conn: sqlite3.Connection, period_id: int) -> ValidationResult:
    row = conn.execute(
        """SELECT SUM(closing_dr) AS dr, SUM(closing_cr) AS cr
           FROM consolidated_tb WHERE period_id = ? AND source_type = 'total'""",
        (period_id,),
    ).fetchone()
    dr, cr = row["dr"] or 0, row["cr"] or 0
    diff = abs(dr - cr)
    details = [] if diff <= TOLERANCE_IDR else [f"Consolidated total Dr={dr:.2f} vs Cr={cr:.2f} (diff {diff:.2f})"]
    return ValidationResult("V5", "Consolidated TB balances (total Dr = total Cr)", "Error", not details, details)


def _v8_entity_columns_sum_to_total(conn: sqlite3.Connection, period_id: int) -> ValidationResult:
    """Total = sum of entity_tb rows + adjustment rows (adjustments carry their own
    entity_id, including NULL for group-level ones) — not entity_tb alone, since applied
    adjustments land in the Total column but don't belong to any single entity's TB."""
    rows = conn.execute(
        """SELECT gc.account_name,
                  SUM(CASE WHEN ctb.source_type IN ('entity_tb', 'adjustment')
                           THEN ctb.closing_dr - ctb.closing_cr ELSE 0 END) AS entity_sum,
                  SUM(CASE WHEN ctb.source_type = 'total' THEN ctb.closing_dr - ctb.closing_cr ELSE 0 END) AS total_sum
           FROM consolidated_tb ctb
           JOIN group_coa gc ON gc.group_account_id = ctb.group_account_id
           WHERE ctb.period_id = ?
           GROUP BY ctb.group_account_id""",
        (period_id,),
    ).fetchall()
    details = [
        f"{r['account_name']}: entity+adjustment rows sum to {r['entity_sum']:.2f} vs total {r['total_sum']:.2f}"
        for r in rows if abs((r["entity_sum"] or 0) - (r["total_sum"] or 0)) > TOLERANCE_IDR
    ]
    return ValidationResult("V8", "Entity + adjustment rows sum to the Total column for every account", "Error", not details, details)


def _v9_source_tb_self_balances(conn: sqlite3.Connection, period_id: int) -> ValidationResult:
    """Each entity's raw imported TB (all lines, mapped or not) balances Dr=Cr on closing."""
    rows = conn.execute(
        """SELECT e.entity_code, SUM(tbl.closing_dr) AS dr, SUM(tbl.closing_cr) AS cr
           FROM trial_balance_lines tbl
           JOIN trial_balance_imports tbi ON tbl.import_id = tbi.import_id
           JOIN entities e ON tbi.entity_id = e.entity_id
           WHERE tbi.period_id = ?
           GROUP BY tbi.import_id""",
        (period_id,),
    ).fetchall()
    details = [
        f"{r['entity_code']}: closing Dr={r['dr']:.2f} vs Cr={r['cr']:.2f}"
        for r in rows if abs((r["dr"] or 0) - (r["cr"] or 0)) > TOLERANCE_IDR
    ]
    return ValidationResult("V9", "Each entity's source TB self-balances (closing Dr = Cr)", "Error", not details, details)


def _v6_bs_balances(conn: sqlite3.Connection, period_id: int) -> ValidationResult:
    from src.engines.statement_generator import compute_bs
    _, total_assets, total_le = compute_bs(conn, period_id)
    diff = abs(total_assets - total_le)
    details = [] if diff <= TOLERANCE_IDR else [f"Total Assets={total_assets:.2f} vs Total Liabilities+Equity={total_le:.2f} (diff {diff:.2f})"]
    return ValidationResult("V6", "Balance Sheet balances (Total Assets = Total Liabilities + Equity)", "Error", not details, details)


def _v7_pl_flows_to_bs(conn: sqlite3.Connection, period_id: int) -> ValidationResult:
    """Net income computed independently from the P&L must equal the BS's "Current Year
    Profit" plug — this is really the same check as V6 from the other direction, but kept
    separate per the source plan's explicit acceptance criterion."""
    from src.engines.statement_generator import compute_pl
    _, net_income = compute_pl(conn, period_id)
    row = conn.execute(
        """SELECT SUM(closing_dr) AS dr, SUM(closing_cr) AS cr
           FROM consolidated_tb ctb
           JOIN group_coa gc ON gc.group_account_id = ctb.group_account_id
           WHERE ctb.period_id = ? AND ctb.source_type = 'total' AND gc.statement_type = 'PL'""",
        (period_id,),
    ).fetchone()
    pl_signed_total = (row["dr"] or 0) - (row["cr"] or 0)
    diff = abs(net_income - (-pl_signed_total))
    details = [] if diff <= TOLERANCE_IDR else [f"Computed net income {net_income:.2f} vs raw P&L ledger total {-pl_signed_total:.2f}"]
    return ValidationResult("V7", "P&L net profit flows consistently to the BS current-year-profit line", "Error", not details, details)


def _v2_adjustments_balance(conn: sqlite3.Connection, period_id: int) -> ValidationResult:
    rows = conn.execute(
        """SELECT a.adjustment_id, a.external_ref, SUM(al.debit_amount) AS dr, SUM(al.credit_amount) AS cr
           FROM adjustments a
           JOIN adjustment_lines al ON al.adjustment_id = a.adjustment_id
           WHERE a.period_id = ?
           GROUP BY a.adjustment_id""",
        (period_id,),
    ).fetchall()
    details = [
        f"{r['external_ref']}: debits={r['dr']:.2f} vs credits={r['cr']:.2f}"
        for r in rows if abs((r["dr"] or 0) - (r["cr"] or 0)) > TOLERANCE_IDR
    ]
    return ValidationResult("V2", "Each adjustment's debits equal its credits", "Error", not details, details)


def _v14_draft_adjustments(conn: sqlite3.Connection, period_id: int) -> ValidationResult:
    rows = conn.execute(
        "SELECT external_ref FROM adjustments WHERE period_id = ? AND status = 'draft'", (period_id,)
    ).fetchall()
    details = [f"{r['external_ref']} is still in draft — not yet applied" for r in rows]
    return ValidationResult("V14", "No adjustments left pending in draft status", "Warning", not details, details)


def _v18_locked_period_immutable(conn: sqlite3.Connection, period_id: int) -> ValidationResult:
    period = conn.execute("SELECT * FROM periods WHERE period_id = ?", (period_id,)).fetchone()
    if period["status"] != "locked":
        return ValidationResult("V18", "Locked periods carry no unapplied draft adjustments", "Error", True, [])
    rows = conn.execute(
        "SELECT external_ref FROM adjustments WHERE period_id = ? AND status = 'draft'", (period_id,)
    ).fetchall()
    details = [f"{r['external_ref']} is draft in a locked period" for r in rows]
    return ValidationResult("V18", "Locked periods carry no unapplied draft adjustments", "Error", not details, details)


def run_all(conn: sqlite3.Connection, period_id: int) -> list[ValidationResult]:
    return [
        _v1_entity_grand_total_ties(conn, period_id),
        _v3_v12_material_mapped(conn, period_id),
        _v9_source_tb_self_balances(conn, period_id),
        _v5_consolidated_balances(conn, period_id),
        _v8_entity_columns_sum_to_total(conn, period_id),
        _v6_bs_balances(conn, period_id),
        _v7_pl_flows_to_bs(conn, period_id),
        _v2_adjustments_balance(conn, period_id),
        _v14_draft_adjustments(conn, period_id),
        _v18_locked_period_immutable(conn, period_id),
    ]
