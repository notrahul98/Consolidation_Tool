"""Mapping.xlsx round-trip: export every distinct ledger name for categorization,
then re-import the user's edits. No category is ever pre-filled from anywhere except
a prior run of this same tool (see Phase 1 plan finding #6 — the old Financials
workbook's Mapping sheet is never consulted)."""

import sqlite3

import openpyxl
from openpyxl.worksheet.datavalidation import DataValidation

from src.db.repositories import group_coa_repo, mapping_repo

HEADER = ["Ledger Name", "Entities Present In", "Inferred Tally Primary Group", "Balance (IDR)",
          "Check", "Category"]


def export_mapping_workbook(conn: sqlite3.Connection, period_id: int, out_path: str) -> None:
    ledgers = mapping_repo.distinct_ledgers_for_period(conn, period_id)
    ledgers.sort(key=lambda x: x["ledger_name"])
    categories = group_coa_repo.list_leaf_categories(conn)
    category_names = [c["account_name"] for c in categories]
    code_by_name = {c["account_name"]: c["group_account_id"] for c in categories}

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Mapping"
    ws.append(HEADER)
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "A2"

    for entry in ledgers:
        multiple_groups = len(entry["primary_groups"]) > 1
        multiple_categories = len(entry["group_account_ids"]) > 1
        check = ""
        if multiple_groups:
            check = "Check: differs across entities"
        elif multiple_categories:
            check = "Check: inconsistently categorized"

        current_category = ""
        if len(entry["group_account_ids"]) == 1:
            gid = next(iter(entry["group_account_ids"]))
            row = group_coa_repo.get_by_id(conn, gid)
            current_category = row["account_name"] if row else ""

        ws.append([
            entry["ledger_name"],
            ", ".join(sorted(set(entry["entities"]))),
            ", ".join(sorted(entry["primary_groups"])) or "",
            round(entry["total_balance"], 2),
            check,
            current_category,
        ])

    cat_sheet = wb.create_sheet("_CategoryList")
    for i, name in enumerate(category_names, start=1):
        cat_sheet.cell(row=i, column=1, value=name)
    cat_sheet.sheet_state = "hidden"

    dv = DataValidation(
        type="list",
        formula1=f"'_CategoryList'!$A$1:$A${len(category_names)}",
        allow_blank=True,
        showErrorMessage=True,
        errorTitle="Invalid category",
        error="Pick a category from the dropdown list.",
    )
    ws.add_data_validation(dv)
    dv.add(f"F2:F{ws.max_row}")

    widths = [40, 20, 28, 16, 26, 45]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(i)].width = w

    wb.save(out_path)


def import_mapping_workbook(conn: sqlite3.Connection, in_path: str, user: str | None = None) -> int:
    wb = openpyxl.load_workbook(in_path, data_only=True)
    ws = wb["Mapping"]

    categories = group_coa_repo.list_leaf_categories(conn)
    code_by_name = {c["account_name"]: c["group_account_id"] for c in categories}

    header = [c.value for c in ws[1]]
    col = {name: i + 1 for i, name in enumerate(header)}
    required = {"Ledger Name", "Category"}
    if not required.issubset(col):
        raise ValueError(f"Mapping.xlsx is missing required column(s): {required - set(col)}")

    applied = 0
    errors = []
    for row in range(2, ws.max_row + 1):
        ledger_name = ws.cell(row=row, column=col["Ledger Name"]).value
        if not ledger_name:
            continue
        category = ws.cell(row=row, column=col["Category"]).value
        if not category:
            continue  # still uncategorized, nothing to apply
        category = str(category).strip()
        if category not in code_by_name:
            errors.append(f"Row {row}: unknown category '{category}' for ledger '{ledger_name}'")
            continue
        mapping_repo.apply_mapping(conn, str(ledger_name).strip(), code_by_name[category], user=user)
        applied += 1

    if errors:
        raise ValueError("Mapping.xlsx has invalid categories:\n" + "\n".join(errors))

    return applied
