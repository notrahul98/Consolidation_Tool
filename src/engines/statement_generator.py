"""Computes the P&L and Balance Sheet from the consolidated TB, matching the exact line-item
structure, grouping, and section layout of the user's real template
(`Kreasi Financials FY June 2026 Draft V2.xlsx`, sheets `P&L` and `BS`) — single period only
(no comparatives yet — that needs multiple locked periods, a later phase).

Sign convention: consolidated_tb stores signed closing balances as (closing_dr - closing_cr)
— "Dr positive". For statement *display*, every leaf is converted to its own natural
positive-magnitude direction using group_coa.normal_balance (a Dr-normal leaf displays
as-is; a Cr-normal leaf is negated). Subtotal rows are NOT a generic sum of that display
value — each is computed via the explicit formula relationship the real template uses
(e.g. Net Sales = Total Sales - Sales Discount/Return), because in a human-readable P&L,
revenue and expenses both display positive and must be combined with the correct
arithmetic sign, not just summed.

Retained Earnings: confirmed against the real template's `Schedules` sheet (Schedule 15)
that "Retained Earnings" on the BS face is a single line combining the brought-forward
P&L ledger balance *and* the current period's P&L result — not two separate BS lines.
Replicated the same way here, and the BS carries a `Check` row (Total Liabilities & Equity
minus Total Assets) exactly like the real template, instead of inventing a new line.
"""

import sqlite3


def _totals_by_account_name(conn: sqlite3.Connection, period_id: int) -> dict[str, tuple[float, str]]:
    """account_name -> (Dr-positive signed closing balance, normal_balance)"""
    rows = conn.execute(
        """SELECT gc.account_name, gc.normal_balance,
                  SUM(ctb.closing_dr) AS dr, SUM(ctb.closing_cr) AS cr
           FROM consolidated_tb ctb
           JOIN group_coa gc ON gc.group_account_id = ctb.group_account_id
           WHERE ctb.period_id = ? AND ctb.source_type = 'total'
           GROUP BY gc.account_name""",
        (period_id,),
    ).fetchall()
    return {r["account_name"]: ((r["dr"] or 0) - (r["cr"] or 0), r["normal_balance"]) for r in rows}


class StatementLine:
    """kind: 'section' (bare label, no amount, e.g. "CURRENT ASSETS"),
    'leaf' (a mapped category), 'subtotal' (computed, bold)."""

    def __init__(self, label: str, value: float | None, level: int = 0, kind: str = "leaf", percent: float | None = None):
        self.label = label
        self.value = value
        self.level = level
        self.kind = kind
        self.percent = percent

    @property
    def is_subtotal(self) -> bool:
        return self.kind == "subtotal"


def _build(totals: dict[str, tuple[float, str]]):
    def leaf(name: str) -> float:
        signed, normal_balance = totals.get(name, (0.0, None))
        if normal_balance is None:
            return 0.0
        return signed if normal_balance == "DR" else -signed
    return leaf


def compute_pl(conn: sqlite3.Connection, period_id: int) -> tuple[list[StatementLine], float]:
    totals = _totals_by_account_name(conn, period_id)
    leaf = _build(totals)
    L = StatementLine
    lines: list[StatementLine] = []
    net_sales_holder = [1.0]  # filled in once Net Sales is known; guards divide-by-zero until then

    def pct(value):
        base = net_sales_holder[0]
        return value / base if base else 0.0

    def add(label, value, level=0, kind="leaf"):
        lines.append(L(label, value, level, kind, pct(value) if value is not None else None))

    total_sales = leaf("Sales")
    sales_discount = leaf("Sales Discount/Return")
    net_sales = total_sales - sales_discount
    net_sales_holder[0] = net_sales if net_sales else 1.0  # set before any add() so % is correct from the first row

    add("Sales", total_sales, 1)
    add("Total Sales", total_sales, 0, "subtotal")
    add("Sales Discount/Return", sales_discount, 1)
    add("Net Sales", net_sales, 0, "subtotal")

    cogs_before = leaf("COGS before Direct Cost & Forex Gain/Loss")
    direct_income = leaf("Direct Income")
    direct_costs = leaf("Direct Costs")
    total_cogs = cogs_before + direct_costs - direct_income
    add("COGS before Direct Cost & Forex Gain/Loss", cogs_before, 1)
    add("Direct Income", direct_income, 1)
    add("Direct Costs", direct_costs, 1)
    add("Total Cost of Goods Sold", total_cogs, 0, "subtotal")

    gross_profit = net_sales - total_cogs
    add("Gross Profit", gross_profit, 0, "subtotal")

    def group(header: str, members: list[str]) -> float:
        total = 0.0
        add(header, None, 0, "subtotal")
        idx = len(lines) - 1
        for m in members:
            v = leaf(m)
            add(m, v, 1)
            total += v
        lines[idx].value = total
        lines[idx].percent = pct(total)
        return total

    staff_costs = group("Staff and Staff related Costs",
                          ["Salaries & Wages", "Bonus & Incentives", "Commission", "Staff Insurance", "Staff Welfare"])
    marketing = group("Marketing Expenses", ["Advertising Expense", "Entertainment"])
    sales_exp = group("Sales Expenses", ["Freight, Storage & Handling", "Sales Fees", "Packaging and Labeling"])
    utilities = group("Utlities", ["Telephone Expense", "Electricity Expense"])
    plsharing = leaf("Profit/Loss Sharing")
    add("Profit/Loss Sharing", plsharing, 0)
    rent = leaf("Rent Expense")
    add("Rent Expense", rent, 0)
    depreciation = leaf("Depreciation")
    add("Depreciation", depreciation, 0)
    consumables = group("Consumables", ["Printing & Stationery", "Pantry Expenses"])
    maintenance = group("Maintenance Expenses", ["Repairs & Maintenance", "Security Expense"])
    taxes_lic = leaf("Taxes, Licenses & Permits")
    add("Taxes, Licenses & Permits", taxes_lic, 0)
    other_exp = group("Other Expenses", [
        "Sample Expenses", "Interest Expense", "Interest on  Shareholder loan", "Warehouse Expense",
        "Consulting & Professional Fee", "General Insurance Expense", "Postage & Courier Expenses",
        "Tax Expenses", "Transport Expense", "Office Expenses", "Modern Market Trading Terms",
        "Stock Write Off", "Bad Debts",
    ])
    travel = group("Travel Expenses", ["Travel Expense - International", "Travel Expense - Domestic"])

    operating_expenses = (staff_costs + marketing + sales_exp + utilities + plsharing + rent +
                            depreciation + consumables + maintenance + taxes_lic + other_exp + travel)
    add("Operating Expenses", operating_expenses, 0, "subtotal")

    operative_profit = gross_profit - operating_expenses
    add("Operative Profit/(Loss)", operative_profit, 0, "subtotal")

    misc_exp = group("Miscellaneous Expenses", ["Misc. Expense", "Bank Charges", "Foreign Exchange (Gain) Loss"])
    misc_inc = group("Miscellaneous Incomes", ["Other Income", "Other Income - CPCI Income"])
    total_nonop = misc_exp - misc_inc
    add("Total Non Operating Expenses/(Income)", total_nonop, 0, "subtotal")

    net_income_before = operative_profit - total_nonop
    add("Net Income/(Loss) Before Tax & Previous Year Expenses", net_income_before, 0, "subtotal")

    extraordinary = group("Extraordinary / Previous Year Expenses", [
        "Tax Expenses - Prev Years", "Credit Note - Prev. Years", "Previous Year Rent Expenses",
        "Previous Year Commissions", "Corporate Tax",
    ])
    net_income_after = net_income_before - extraordinary
    add("Net Income/(Loss) After Tax & Previous Year Expenses", net_income_after, 0, "subtotal")

    add("Net Income Before Depreciation", net_income_after + depreciation, 0, "subtotal")
    interest_expense = leaf("Interest Expense")
    interest_shareholder = leaf("Interest on  Shareholder loan")
    add("Net Profit without interest on bank loan", net_income_after + interest_expense, 0, "subtotal")
    add("Net Profit without interest on shareholder loan", net_income_after + interest_shareholder, 0, "subtotal")

    return lines, net_income_after


def compute_bs(conn: sqlite3.Connection, period_id: int) -> tuple[list[StatementLine], float, float]:
    totals = _totals_by_account_name(conn, period_id)
    leaf = _build(totals)
    L = StatementLine
    lines: list[StatementLine] = []

    _, current_year_pl = compute_pl(conn, period_id)

    def group(header: str, members: list[str]) -> float:
        """BS convention (unlike the P&L's): line items first, subtotal last."""
        total = 0.0
        for m in members:
            v = leaf(m)
            lines.append(L(m, v, 1))
            total += v
        lines.append(L(header, total, 0, "subtotal"))
        return total

    lines.append(L("CURRENT ASSETS", None, 0, "section"))
    total_ca = group("Total Current Assets", [
        "Cash & Cash Equivalent", "Accounts Receivable", "Inventory", "Prepaid Taxes",
        "Prepaid Expenses", "Short Term Deposits", "Other Receivables",
    ])

    lines.append(L("NON CURRENT ASSETS", None, 0, "section"))
    fixed_assets = leaf("Fixed Assets")
    acc_dep = leaf("Accumulated Depreciation")
    net_fixed = fixed_assets - acc_dep
    lines.append(L("Fixed Assets", fixed_assets, 1))
    # Displayed as negative (a contra-asset), matching the real template's convention —
    # Net Fixed Assets is unaffected, it's a display-only sign flip.
    lines.append(L("Accumulated Depreciation", -acc_dep, 1))
    lines.append(L("Net Fixed Assets", net_fixed, 0, "subtotal"))
    other_nca = leaf("Other Non-current Asset")
    lines.append(L("Other Non-current Asset", other_nca, 0))
    total_nca = net_fixed + other_nca
    lines.append(L("Total Non-Current Assets", total_nca, 0, "subtotal"))

    total_assets = total_ca + total_nca
    lines.append(L("TOTAL ASSETS", total_assets, 0, "subtotal"))

    lines.append(L("LIABILITIES AND EQUITY", None, 0, "section"))
    lines.append(L("LIABILITIES", None, 0, "section"))
    total_stl = group("Total Short Term Liabilities", [
        "Accounts Payable", "Taxes Payable", "Accrued Expenses", "Loans & Advances taken",
        "Interco Balances", "Other Payables",
    ])

    lines.append(L("EQUITY", None, 0, "section"))
    share_capital = leaf("Share Capital")
    # Retained Earnings on the face of the statement is one line — brought-forward P&L
    # ledger balance plus this period's P&L result — replicating the real template's
    # Schedule 15 (Schedules!C88 "prior years" + C89 "current year P&L" -> C91 total).
    retained_earnings_bf = leaf("Retained Earnings")
    retained_earnings = retained_earnings_bf + current_year_pl
    lines.append(L("Share Capital", share_capital, 1))
    lines.append(L("Retained Earnings", retained_earnings, 1))
    total_equity = share_capital + retained_earnings
    lines.append(L("Total Equity", total_equity, 0, "subtotal"))

    total_le = total_stl + total_equity
    lines.append(L("TOTAL LIABILITIES AND EQUITY", total_le, 0, "subtotal"))

    lines.append(L("Check", total_le - total_assets, 0, "subtotal"))

    return lines, total_assets, total_le
