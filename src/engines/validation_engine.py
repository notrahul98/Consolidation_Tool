"""Validation checks V1-V22 from the source plan's Section 6.7/10, plus the comparative-range
checks added with the YTD work."""

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


def _v19_stock_cogs_booked(conn: sqlite3.Connection, period_id: int) -> ValidationResult:
    """Stock/COGS movement booked. Fails when period has non-zero Inventory and either
    (a) no applied inventory_movement adjustment exists, or (b) one exists but its amounts
    no longer match the current stock_movement figures (i.e. figures were edited after generation)."""
    details = []

    # Get all entities with non-zero Inventory in consolidated TB
    inventory_entities = conn.execute(
        """SELECT ctb.entity_id, e.entity_code,
                  SUM(ctb.closing_dr) - SUM(ctb.closing_cr) AS inventory_balance
           FROM consolidated_tb ctb
           JOIN entities e ON ctb.entity_id = e.entity_id
           JOIN group_coa gc ON gc.group_account_id = ctb.group_account_id
           WHERE ctb.period_id = ? AND gc.account_name = 'Inventory'
                 AND ctb.source_type = 'total'
           GROUP BY ctb.entity_id
           HAVING ABS(inventory_balance) > ?""",
        (period_id, TOLERANCE_IDR),
    ).fetchall()

    if not inventory_entities:
        # No non-zero inventory, so no need to book
        return ValidationResult("V19", "Stock/COGS movement booked", "Warning", True, [])

    # Check if an applied inventory_movement adjustment exists
    applied_adj = conn.execute(
        """SELECT adjustment_id FROM adjustments
           WHERE period_id = ? AND adjustment_type = 'inventory_movement' AND status = 'applied'
           LIMIT 1""",
        (period_id,),
    ).fetchone()

    if not applied_adj:
        details.append("Period has non-zero Inventory but no applied stock adjustment")
        return ValidationResult("V19", "Stock/COGS movement booked", "Warning", False, details)

    # Adjustment exists; verify amounts match current stock_movement
    for inv in inventory_entities:
        stock = conn.execute(
            """SELECT opening_stock_auto, opening_stock_override, closing_stock_auto, closing_stock_override,
                      purchases_auto, purchases_override
               FROM stock_movement WHERE period_id = ? AND entity_id = ?""",
            (period_id, inv["entity_id"]),
        ).fetchone()

        if not stock:
            details.append(f"{inv['entity_code']}: non-zero Inventory but no stock_movement row")
            continue

        # Compute current delta
        opening = stock["opening_stock_override"] if stock["opening_stock_override"] is not None else stock["opening_stock_auto"]
        closing = stock["closing_stock_override"] if stock["closing_stock_override"] is not None else stock["closing_stock_auto"]
        if opening is None or closing is None:
            continue
        delta = opening - closing

        if abs(delta) > TOLERANCE_IDR:
            # Check that the applied adjustment's Inventory line magnitude matches the
            # current delta. Only the magnitude matters here (direction is already fixed
            # by generate_adjustment's drawdown/buildup branches), so summing the signed
            # debit-credit and comparing absolute values sidesteps needing to know
            # Inventory's normal_balance direction.
            adj_balance = conn.execute(
                """SELECT SUM(al.debit_amount - al.credit_amount) AS net
                   FROM adjustment_lines al
                   JOIN adjustments a ON al.adjustment_id = a.adjustment_id
                   JOIN group_coa gc ON al.group_account_id = gc.group_account_id
                   WHERE a.adjustment_id = ? AND al.entity_id = ? AND gc.account_name = 'Inventory'""",
                (applied_adj["adjustment_id"], inv["entity_id"]),
            ).fetchone()

            if not adj_balance or abs(abs(adj_balance["net"] or 0) - abs(delta)) > TOLERANCE_IDR:
                details.append(f"{inv['entity_code']}: stock figures changed after adjustment generation")

    return ValidationResult("V19", "Stock/COGS movement booked", "Warning", not details, details)


def _v20_re_movement_ties_to_prior_profit(conn: sqlite3.Connection, period_id: int) -> ValidationResult:
    """Retained Earnings movement ties to prior period profit. Severity Warning. Wraps
    re_check.run(). Detail line per entity whose abs(gap) > TOLERANCE_IDR, plus a
    group-level line. Passes when not applicable."""
    from src.engines import re_check

    result = re_check.run(conn, period_id)
    if not result.applicable:
        return ValidationResult("V20", "Retained Earnings movement ties to prior period profit", "Warning", True, [])

    details = []
    for row in result.rows:
        if abs(row.gap) > TOLERANCE_IDR:
            label = row.entity_code if row.entity_code else "Group total"
            details.append(f"{label}: RE gap={row.gap:.2f} (expected {row.expected:.2f}, actual {row.re_closing_current:.2f})")

    return ValidationResult("V20", "Retained Earnings movement ties to prior period profit", "Warning", not details, details)


def _comparative_readiness(conn: sqlite3.Connection, period_id: int) -> dict:
    """The YTD range's missing / open / stale months, as the comparative screens report them."""
    from src.engines import comparative_engine

    return comparative_engine.resolve_comparative_periods(conn, period_id).readiness


def _v21_comparative_range_complete(conn: sqlite3.Connection, period_id: int) -> ValidationResult:
    """Every month of the year to date has consolidated data. Severity Warning.

    The comparative screens already show this as a banner, but a banner is only seen by
    whoever opens that page. Putting it in the validation list means it also reaches the
    Validation sheet in the Excel pack, where a reviewer looks at the numbers rather than at
    the tool. A partial year-to-date figure is not wrong, it just is not what its heading
    claims, so this never blocks locking.
    """
    missing = _comparative_readiness(conn, period_id)["missing"]
    details = [f"No consolidated data for {m}" for m in missing]
    if details:
        details.append(
            f"Year-to-date columns cover {len(missing)} fewer month(s) than the period implies")
    return ValidationResult("V21", "Comparative range has data for every month to date", "Warning",
                            not details, details)


def _v22_comparative_range_settled(conn: sqlite3.Connection, period_id: int) -> ValidationResult:
    """No open or stale periods inside the comparative range. Severity Warning.

    An open month can still change and a stale one is showing figures a re-consolidate would
    move, so a year-to-date column built over either is provisional. Reported together because
    the reader's question is the same: can I rely on this total yet.
    """
    readiness = _comparative_readiness(conn, period_id)
    details = [f"{m} is open (unlocked) - its figures can still change" for m in readiness["open"]]
    details += [f"{m} has adjustments changed since its last consolidation" for m in readiness["stale"]]
    return ValidationResult("V22", "Comparative range contains no open or stale periods", "Warning",
                            not details, details)


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
        _v19_stock_cogs_booked(conn, period_id),
        _v20_re_movement_ties_to_prior_profit(conn, period_id),
        _v21_comparative_range_complete(conn, period_id),
        _v22_comparative_range_settled(conn, period_id),
    ]
