"""Phase 1 Excel pack: Summary, Conso_TB_Matrix, Conso_TB_Total, Entity_<CODE> sheets,
PL_Current, BS_Current, Mapping, Validation.

Every derived cell is a live Excel formula, not a static value, so the workbook is
traceable directly in Excel (click a cell, see where it comes from):

    Entity_<CODE> sheets (base data, from the DB)
        -> Conso_TB_Matrix (entity columns reference Entity_<CODE>; Total = SUM across entities)
            -> Conso_TB_Total (Total column references Conso_TB_Matrix's Total column)
                -> PL_Current / BS_Current (leaves reference Conso_TB_Total; subtotals are
                   SUM/arithmetic formulas over rows within the same sheet; BS_Current's
                   Retained Earnings cross-references PL_Current's Net Income row directly,
                   same as the real template's Schedule 15 pulls in the current year's P&L)

statement_generator.py's compute_pl/compute_bs (numeric, not formulas) remain the source of
truth for the validation engine — this module's formulas are built to mirror that logic
exactly and are checked against it via LibreOffice recalculation, not by sharing code, since
one writes Python values and the other writes Excel formula strings.
"""

import sqlite3

import openpyxl
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

from src.db.repositories import entity_repo, group_coa_repo, consolidated_repo
from src.engines.validation_engine import run_all
from src.engines.statement_generator import compute_pl, compute_bs

IDR_FORMAT = '#,##0;(#,##0)'
BOLD = Font(bold=True)
GREEN_FILL = PatternFill("solid", fgColor="C6EFCE")
RED_FILL = PatternFill("solid", fgColor="FFC7CE")
AMBER_FILL = PatternFill("solid", fgColor="FFEB9C")


def _write_summary(wb, conn, period_id, period_label, validations):
    ws = wb.create_sheet("Summary")
    ws.append(["Tally Consolidation Tool - Phase 1"])
    ws["A1"].font = Font(bold=True, size=14)
    ws.append(["Period", period_label])
    ws.append([])
    ws.append(["Entities"])
    ws[f"A{ws.max_row}"].font = BOLD
    for e in entity_repo.list_all(conn):
        ws.append([e["entity_code"], e["entity_name"]])
    ws.append([])
    ws.append(["Validation status"])
    ws[f"A{ws.max_row}"].font = BOLD
    passed = sum(1 for v in validations if v.passed)
    ws.append([f"{passed}/{len(validations)} checks passed"])
    for v in validations:
        row = [v.check_id, v.description, "PASS" if v.passed else "FAIL"]
        ws.append(row)
        fill = GREEN_FILL if v.passed else RED_FILL
        ws.cell(row=ws.max_row, column=3).fill = fill
    ws.column_dimensions["A"].width = 40
    ws.column_dimensions["B"].width = 55


def _write_entity_sheets(wb, conn, period_id):
    """Base layer: every leaf category for every entity, in identical canonical order
    across all entity sheets (even zero-balance ones) so row numbers are predictable and
    Conso_TB_Matrix can reference them by cell, not by re-deriving the value."""
    entities = entity_repo.list_all(conn)
    coa_leaves = group_coa_repo.list_leaf_categories(conn)
    matrix = consolidated_repo.get_matrix(conn, period_id)
    by_account_entity = {
        (r["group_account_id"], r["entity_id"]): (r["closing_dr"] or 0) - (r["closing_cr"] or 0)
        for r in matrix
    }

    entity_row: dict[str, dict[str, int]] = {}
    for e in entities:
        ws = wb.create_sheet(f"Entity_{e['entity_code']}")
        ws.append(["Account Code", "Account Name", "Section", "Closing Balance"])
        for c in ws[1]:
            c.font = BOLD
        ws.freeze_panes = "A2"
        code_to_row: dict[str, int] = {}
        for row in coa_leaves:
            v = by_account_entity.get((row["group_account_id"], e["entity_id"]), 0.0)
            ws.append([row["account_code"], row["account_name"], row["section"], v])
            ws.cell(row=ws.max_row, column=4).number_format = IDR_FORMAT
            code_to_row[row["account_code"]] = ws.max_row
        entity_row[e["entity_code"]] = code_to_row
        ws.column_dimensions["A"].width = 12
        ws.column_dimensions["B"].width = 40
        ws.column_dimensions["C"].width = 20
        ws.column_dimensions["D"].width = 16

    return entity_row


def _write_matrix_and_total(wb, conn, coa_rows, entities, entity_row):
    """Conso_TB_Matrix: entity columns formula-reference Entity_<CODE> sheets; Total column
    is a SUM formula across the entity columns in that row. Conso_TB_Total mirrors the same
    row layout and formula-references Conso_TB_Matrix's own Total column."""
    ws = wb.create_sheet("Conso_TB_Matrix")
    header = ["Account Code", "Account Name", "Section"] + [e["entity_code"] for e in entities] + ["Total"]
    ws.append(header)
    for c in ws[1]:
        c.font = BOLD
    ws.freeze_panes = "D2"

    entity_start_col = 4
    total_col = entity_start_col + len(entities)
    total_col_letter = get_column_letter(total_col)

    code_row: dict[str, int] = {}
    for row in coa_rows:
        ws.append([row["account_code"], row["account_name"], row["section"]])
        r = ws.max_row
        code_row[row["account_code"]] = r
        if not row["is_header"]:
            for i, e in enumerate(entities):
                col = entity_start_col + i
                entity_sheet_row = entity_row[e["entity_code"]].get(row["account_code"])
                cell = ws.cell(row=r, column=col)
                if entity_sheet_row:
                    cell.value = f"='Entity_{e['entity_code']}'!D{entity_sheet_row}"
                cell.number_format = IDR_FORMAT
            first_letter = get_column_letter(entity_start_col)
            last_letter = get_column_letter(entity_start_col + len(entities) - 1)
            ws.cell(row=r, column=total_col, value=f"=SUM({first_letter}{r}:{last_letter}{r})")
            ws.cell(row=r, column=total_col).number_format = IDR_FORMAT
        else:
            for c in ws[r]:
                c.font = BOLD

    widths = [12, 40, 20] + [14] * (len(entities) + 1)
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w

    ws_total = wb.create_sheet("Conso_TB_Total")
    ws_total.append(["Account Code", "Account Name", "Section", "Total"])
    for c in ws_total[1]:
        c.font = BOLD
    ws_total.freeze_panes = "D2"
    for row in coa_rows:
        ws_total.append([row["account_code"], row["account_name"], row["section"]])
        r = ws_total.max_row
        assert r == code_row[row["account_code"]], "Conso_TB_Total must mirror Conso_TB_Matrix row-for-row"
        if not row["is_header"]:
            ws_total.cell(row=r, column=4, value=f"='Conso_TB_Matrix'!{total_col_letter}{r}")
            ws_total.cell(row=r, column=4).number_format = IDR_FORMAT
        else:
            for c in ws_total[r]:
                c.font = BOLD
    for i, w in enumerate([12, 40, 20, 16], start=1):
        ws_total.column_dimensions[get_column_letter(i)].width = w

    return code_row


def _write_mapping_sheet(wb, conn, period_id):
    from src.db.repositories import mapping_repo
    ws = wb.create_sheet("Mapping")
    ws.append(["Ledger Name", "Entities Present In", "Category", "Status"])
    for c in ws[1]:
        c.font = BOLD
    ws.freeze_panes = "A2"
    for entry in sorted(mapping_repo.distinct_ledgers_for_period(conn, period_id), key=lambda x: x["ledger_name"]):
        category = ""
        if len(entry["group_account_ids"]) == 1:
            row = group_coa_repo.get_by_id(conn, next(iter(entry["group_account_ids"])))
            category = row["account_name"] if row else ""
        status = "Mapped" if entry["group_account_ids"] else "Unmapped"
        ws.append([entry["ledger_name"], ", ".join(sorted(set(entry["entities"]))), category, status])
    ws.column_dimensions["A"].width = 45
    ws.column_dimensions["B"].width = 22
    ws.column_dimensions["C"].width = 40
    ws.column_dimensions["D"].width = 14


def _write_validation_sheet(wb, validations):
    ws = wb.create_sheet("Validation")
    ws.append(["Check", "Description", "Severity", "Status", "Details"])
    for c in ws[1]:
        c.font = BOLD
    ws.freeze_panes = "A2"
    for v in validations:
        detail_text = "; ".join(v.details) if v.details else ""
        ws.append([v.check_id, v.description, v.severity, "PASS" if v.passed else "FAIL", detail_text])
        fill = GREEN_FILL if v.passed else RED_FILL
        ws.cell(row=ws.max_row, column=4).fill = fill
    ws.column_dimensions["A"].width = 10
    ws.column_dimensions["B"].width = 50
    ws.column_dimensions["C"].width = 10
    ws.column_dimensions["D"].width = 10
    ws.column_dimensions["E"].width = 80


def _leaf_ref(name, name_to_leaf, code_row, positive_override=False):
    """Formula fragment (no leading '=') pulling a leaf category from Conso_TB_Total,
    applying the Dr-positive -> display-magnitude sign flip via normal_balance."""
    info = name_to_leaf[name]
    row = code_row[info["account_code"]]
    negate = (info["normal_balance"] == "CR") and not positive_override
    ref = f"'Conso_TB_Total'!D{row}"
    return f"-{ref}" if negate else ref


def _write_pl_sheet(wb, conn, name_to_leaf, code_row):
    ws = wb.create_sheet("PL_Current")
    ws.append(["Line Item", "Amount (IDR)", "% of Net Sales"])
    for c in ws[1]:
        c.font = BOLD
    ws.freeze_panes = "A2"
    row_of: dict[str, int] = {}

    def ref(name, positive_override=False):
        return _leaf_ref(name, name_to_leaf, code_row, positive_override)

    def w(label, formula, level=0, bold=False):
        indent = "    " * level
        ws.append([f"{indent}{label}", f"={formula}" if formula else None])
        r = ws.max_row
        ws.cell(row=r, column=2).number_format = IDR_FORMAT
        if bold:
            for c in ws[r][:2]:
                c.font = BOLD
        row_of[label] = r
        return r

    def group(header, members):
        r_header = w(header, None, 0, bold=True)
        for m in members:
            w(m, ref(m), 1)
        first, last = row_of[members[0]], row_of[members[-1]]
        ws.cell(row=r_header, column=2, value=f"=SUM(B{first}:B{last})")
        return header

    w("Sales", ref("Sales"), 1)
    w("Total Sales", f"B{row_of['Sales']}", 0, bold=True)
    w("Sales Discount/Return", ref("Sales Discount/Return"), 1)
    w("Net Sales", f"B{row_of['Total Sales']}-B{row_of['Sales Discount/Return']}", 0, bold=True)

    w("COGS before Direct Cost & Forex Gain/Loss", ref("COGS before Direct Cost & Forex Gain/Loss"), 1)
    w("Direct Income", ref("Direct Income"), 1)
    w("Direct Costs", ref("Direct Costs"), 1)
    w("Total Cost of Goods Sold",
      f"B{row_of['COGS before Direct Cost & Forex Gain/Loss']}+B{row_of['Direct Costs']}-B{row_of['Direct Income']}",
      0, bold=True)

    w("Gross Profit", f"B{row_of['Net Sales']}-B{row_of['Total Cost of Goods Sold']}", 0, bold=True)

    group("Staff and Staff related Costs",
          ["Salaries & Wages", "Bonus & Incentives", "Commission", "Staff Insurance", "Staff Welfare"])
    group("Marketing Expenses", ["Advertising Expense", "Entertainment"])
    group("Sales Expenses", ["Freight, Storage & Handling", "Sales Fees", "Packaging and Labeling"])
    group("Utlities", ["Telephone Expense", "Electricity Expense"])
    w("Profit/Loss Sharing", ref("Profit/Loss Sharing"), 0)
    w("Rent Expense", ref("Rent Expense"), 0)
    w("Depreciation", ref("Depreciation"), 0)
    group("Consumables", ["Printing & Stationery", "Pantry Expenses"])
    group("Maintenance Expenses", ["Repairs & Maintenance", "Security Expense"])
    w("Taxes, Licenses & Permits", ref("Taxes, Licenses & Permits"), 0)
    group("Other Expenses", [
        "Sample Expenses", "Interest Expense", "Interest on  Shareholder loan", "Warehouse Expense",
        "Consulting & Professional Fee", "General Insurance Expense", "Postage & Courier Expenses",
        "Tax Expenses", "Transport Expense", "Office Expenses", "Modern Market Trading Terms",
        "Stock Write Off", "Bad Debts",
    ])
    group("Travel Expenses", ["Travel Expense - International", "Travel Expense - Domestic"])

    opex_members = ["Staff and Staff related Costs", "Marketing Expenses", "Sales Expenses", "Utlities",
                     "Profit/Loss Sharing", "Rent Expense", "Depreciation", "Consumables",
                     "Maintenance Expenses", "Taxes, Licenses & Permits", "Other Expenses", "Travel Expenses"]
    opex_formula = "+".join(f"B{row_of[m]}" for m in opex_members)
    w("Operating Expenses", opex_formula, 0, bold=True)

    w("Operative Profit/(Loss)", f"B{row_of['Gross Profit']}-B{row_of['Operating Expenses']}", 0, bold=True)

    group("Miscellaneous Expenses", ["Misc. Expense", "Bank Charges", "Foreign Exchange (Gain) Loss"])
    group("Miscellaneous Incomes", ["Other Income", "Other Income - CPCI Income"])
    w("Total Non Operating Expenses/(Income)",
      f"B{row_of['Miscellaneous Expenses']}-B{row_of['Miscellaneous Incomes']}", 0, bold=True)

    w("Net Income/(Loss) Before Tax & Previous Year Expenses",
      f"B{row_of['Operative Profit/(Loss)']}-B{row_of['Total Non Operating Expenses/(Income)']}", 0, bold=True)

    group("Extraordinary / Previous Year Expenses", [
        "Tax Expenses - Prev Years", "Credit Note - Prev. Years", "Previous Year Rent Expenses",
        "Previous Year Commissions", "Corporate Tax",
    ])
    w("Net Income/(Loss) After Tax & Previous Year Expenses",
      f"B{row_of['Net Income/(Loss) Before Tax & Previous Year Expenses']}-B{row_of['Extraordinary / Previous Year Expenses']}",
      0, bold=True)

    net_income_row = row_of["Net Income/(Loss) After Tax & Previous Year Expenses"]
    w("Net Income Before Depreciation", f"B{net_income_row}+B{row_of['Depreciation']}", 0, bold=True)
    w("Net Profit without interest on bank loan", f"B{net_income_row}+B{row_of['Interest Expense']}", 0, bold=True)
    w("Net Profit without interest on shareholder loan",
      f"B{net_income_row}+B{row_of['Interest on  Shareholder loan']}", 0, bold=True)

    net_sales_row = row_of["Net Sales"]
    for label, r in row_of.items():
        ws.cell(row=r, column=3, value=f"=B{r}/$B${net_sales_row}")
        ws.cell(row=r, column=3).number_format = "0.0%"

    ws.column_dimensions["A"].width = 55
    ws.column_dimensions["B"].width = 20
    ws.column_dimensions["C"].width = 15

    return net_income_row


def _write_bs_sheet(wb, conn, name_to_leaf, code_row, pl_net_income_row):
    ws = wb.create_sheet("BS_Current")
    ws.append(["Line Item", "Amount (IDR)"])
    for c in ws[1]:
        c.font = BOLD
    ws.freeze_panes = "A2"
    row_of: dict[str, int] = {}

    def ref(name, positive_override=False):
        return _leaf_ref(name, name_to_leaf, code_row, positive_override)

    def w(label, formula, level=0, bold=False, section=False):
        if section:
            ws.append([label])
            for c in ws[ws.max_row]:
                c.font = BOLD
            row_of[label] = ws.max_row
            return ws.max_row
        indent = "    " * level
        ws.append([f"{indent}{label}", f"={formula}" if formula else None])
        r = ws.max_row
        ws.cell(row=r, column=2).number_format = IDR_FORMAT
        if bold:
            for c in ws[r][:2]:
                c.font = BOLD
        row_of[label] = r
        return r

    def group(header, members):
        first_row = None
        for i, m in enumerate(members):
            r = w(m, ref(m), 1)
            if i == 0:
                first_row = r
        last_row = row_of[members[-1]]
        w(header, f"SUM(B{first_row}:B{last_row})", 0, bold=True)
        return header

    w("CURRENT ASSETS", None, section=True)
    group("Total Current Assets", [
        "Cash & Cash Equivalent", "Accounts Receivable", "Inventory", "Prepaid Taxes",
        "Prepaid Expenses", "Short Term Deposits", "Other Receivables",
    ])

    w("NON CURRENT ASSETS", None, section=True)
    w("Fixed Assets", ref("Fixed Assets"), 1)
    # Displayed as the raw (already-negative) balance — a contra-asset, matching the real
    # template's convention — so Net Fixed Assets below is a plain addition, not a subtraction.
    w("Accumulated Depreciation", ref("Accumulated Depreciation", positive_override=True), 1)
    w("Net Fixed Assets", f"B{row_of['Fixed Assets']}+B{row_of['Accumulated Depreciation']}", 0, bold=True)
    w("Other Non-current Asset", ref("Other Non-current Asset"), 0)
    w("Total Non-Current Assets", f"B{row_of['Net Fixed Assets']}+B{row_of['Other Non-current Asset']}", 0, bold=True)

    w("TOTAL ASSETS", f"B{row_of['Total Current Assets']}+B{row_of['Total Non-Current Assets']}", 0, bold=True)

    w("LIABILITIES AND EQUITY", None, section=True)
    w("LIABILITIES", None, section=True)
    group("Total Short Term Liabilities", [
        "Accounts Payable", "Taxes Payable", "Accrued Expenses", "Loans & Advances taken",
        "Interco Balances", "Other Payables",
    ])

    w("EQUITY", None, section=True)
    w("Share Capital", ref("Share Capital"), 1)
    # Retained Earnings = brought-forward P&L ledger balance (Conso_TB_Total) + this period's
    # P&L result, cross-referenced straight from PL_Current — same composition as the real
    # template's Schedule 15 (prior years + current year P&L).
    w("Retained Earnings", f"({ref('Retained Earnings')})+'PL_Current'!B{pl_net_income_row}", 1)
    w("Total Equity", f"B{row_of['Share Capital']}+B{row_of['Retained Earnings']}", 0, bold=True)

    w("TOTAL LIABILITIES AND EQUITY",
      f"B{row_of['Total Short Term Liabilities']}+B{row_of['Total Equity']}", 0, bold=True)

    w("Check", f"B{row_of['TOTAL LIABILITIES AND EQUITY']}-B{row_of['TOTAL ASSETS']}", 0, bold=True)

    ws.column_dimensions["A"].width = 55
    ws.column_dimensions["B"].width = 20


def _write_adjustments_sheet(wb, conn, period_id):
    from src.db.repositories import adjustment_repo
    ws = wb.create_sheet("Adjustments")
    ws.append(["Adjustment Ref", "Type", "Narration", "Entity", "Category", "Debit", "Credit",
               "Line Narration", "Status", "Copied From"])
    for c in ws[1]:
        c.font = BOLD
    ws.freeze_panes = "A2"
    for adj in adjustment_repo.list_for_period(conn, period_id):
        copied_from = ""
        if adj["copied_from_period_id"]:
            p = conn.execute("SELECT * FROM periods WHERE period_id = ?",
                              (adj["copied_from_period_id"],)).fetchone()
            copied_from = f"{p['year']}-{p['month']:02d}" if p else ""
        for line in adjustment_repo.get_lines(conn, adj["adjustment_id"]):
            entity_code = ""
            if line["entity_id"]:
                e = conn.execute("SELECT entity_code FROM entities WHERE entity_id = ?",
                                  (line["entity_id"],)).fetchone()
                entity_code = e["entity_code"] if e else ""
            category = group_coa_repo.get_by_id(conn, line["group_account_id"])
            ws.append([
                adj["external_ref"], adj["adjustment_type"], adj["narration"], entity_code,
                category["account_name"] if category else "",
                line["debit_amount"] or None, line["credit_amount"] or None,
                line["line_narration"], adj["status"], copied_from,
            ])
            for col in (6, 7):
                ws.cell(row=ws.max_row, column=col).number_format = IDR_FORMAT
    widths = [16, 18, 45, 10, 40, 16, 16, 30, 10, 14]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w


def _write_adj_bridge_sheet(wb, conn, period_id):
    ws = wb.create_sheet("Adj_Bridge")
    ws.append(["Account Code", "Account Name", "TB Before Adjustments", "Adjustment Impact", "TB After (Total)"])
    for c in ws[1]:
        c.font = BOLD
    ws.freeze_panes = "A2"
    rows = conn.execute(
        """SELECT gc.account_code, gc.account_name,
                  SUM(CASE WHEN ctb.source_type = 'entity_tb' THEN ctb.closing_dr - ctb.closing_cr ELSE 0 END) AS before_adj,
                  SUM(CASE WHEN ctb.source_type = 'adjustment' THEN ctb.closing_dr - ctb.closing_cr ELSE 0 END) AS adj_impact,
                  SUM(CASE WHEN ctb.source_type = 'total' THEN ctb.closing_dr - ctb.closing_cr ELSE 0 END) AS after_total
           FROM consolidated_tb ctb
           JOIN group_coa gc ON gc.group_account_id = ctb.group_account_id
           WHERE ctb.period_id = ?
           GROUP BY ctb.group_account_id
           HAVING adj_impact != 0
           ORDER BY gc.line_item_order""",
        (period_id,),
    ).fetchall()
    for r in rows:
        ws.append([r["account_code"], r["account_name"], r["before_adj"], r["adj_impact"], r["after_total"]])
        for col in (3, 4, 5):
            ws.cell(row=ws.max_row, column=col).number_format = IDR_FORMAT
    for i, w in enumerate([12, 40, 20, 18, 18], start=1):
        ws.column_dimensions[get_column_letter(i)].width = w


def _write_audit_log_sheet(wb, conn):
    ws = wb.create_sheet("Audit_Log")
    ws.append(["Timestamp", "User", "Action", "Table", "Record ID", "Old Value", "New Value"])
    for c in ws[1]:
        c.font = BOLD
    ws.freeze_panes = "A2"
    rows = conn.execute("SELECT * FROM audit_log ORDER BY log_id DESC LIMIT 2000").fetchall()
    for r in rows:
        ws.append([r["timestamp"], r["user"], r["action"], r["table_name"], r["record_id"],
                   r["old_value"], r["new_value"]])
    widths = [24, 16, 12, 22, 12, 30, 30]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w


def export_pack(conn: sqlite3.Connection, period_id: int, out_path: str) -> None:
    period = conn.execute("SELECT * FROM periods WHERE period_id = ?", (period_id,)).fetchone()
    period_label = f"{period['year']}-{period['month']:02d}"
    validations = run_all(conn, period_id)

    entities = entity_repo.list_all(conn)
    coa_rows = group_coa_repo.list_all(conn)
    coa_leaves = group_coa_repo.list_leaf_categories(conn)
    name_to_leaf = {r["account_name"]: r for r in coa_leaves}

    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    _write_summary(wb, conn, period_id, period_label, validations)
    entity_row = _write_entity_sheets(wb, conn, period_id)
    code_row = _write_matrix_and_total(wb, conn, coa_rows, entities, entity_row)
    net_income_row = _write_pl_sheet(wb, conn, name_to_leaf, code_row)
    _write_bs_sheet(wb, conn, name_to_leaf, code_row, net_income_row)
    _write_adjustments_sheet(wb, conn, period_id)
    _write_adj_bridge_sheet(wb, conn, period_id)
    _write_mapping_sheet(wb, conn, period_id)
    _write_validation_sheet(wb, validations)
    _write_audit_log_sheet(wb, conn)
    wb.save(out_path)
