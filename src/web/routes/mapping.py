import getpass
import sqlite3

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import RedirectResponse

from src.db.repositories import group_coa_repo, mapping_repo, period_repo
from src.web.deps import get_db, templates

router = APIRouter()


@router.get("/periods/{period_str}/mapping")
def mapping_form(request: Request, period_str: str, conn: sqlite3.Connection = Depends(get_db)):
    period = period_repo.get_by_str(conn, period_str)
    if period is None:
        return RedirectResponse(f"/?flash=No such period&flash_kind=error", status_code=303)
    mapping_repo.ensure_rows_exist(conn, period["period_id"])
    conn.commit()

    ledgers = mapping_repo.distinct_ledgers_for_period(conn, period["period_id"])
    ledgers.sort(key=lambda x: x["ledger_name"])
    categories = group_coa_repo.list_leaf_categories(conn)

    rows = []
    for entry in ledgers:
        current_category = ""
        multiple = len(entry["group_account_ids"]) > 1
        if len(entry["group_account_ids"]) == 1:
            cat = group_coa_repo.get_by_id(conn, next(iter(entry["group_account_ids"])))
            current_category = cat["account_name"] if cat else ""
        rows.append({
            "ledger_name": entry["ledger_name"],
            "entities": ", ".join(sorted(set(entry["entities"]))),
            "primary_group": ", ".join(sorted(entry["primary_groups"])),
            "balance": entry["total_balance"],
            "current_category": current_category,
            "check": "differs across entities" if len(entry["primary_groups"]) > 1
                      else ("inconsistently categorized" if multiple else ""),
        })

    return templates.TemplateResponse(request, "mapping.html", {
        "request": request, "period_str": period_str, "rows": rows,
        "categories": [c["account_name"] for c in categories],
    })


@router.post("/periods/{period_str}/mapping")
def apply_mapping_form(period_str: str,
                         ledger_name: list[str] = Form(default=[]),
                         category: list[str] = Form(default=[]),
                         conn: sqlite3.Connection = Depends(get_db)):
    period = period_repo.get_by_str(conn, period_str)
    if period is None:
        return RedirectResponse(f"/?flash=No such period&flash_kind=error", status_code=303)
    try:
        period_repo.require_open(conn, period["period_id"], "change categorization")
    except ValueError as e:
        return RedirectResponse(
            f"/periods/{period_str}/mapping?flash={e}&flash_kind=error", status_code=303)

    applied = 0
    for name, cat_name in zip(ledger_name, category):
        if not cat_name:
            continue
        cat = group_coa_repo.get_by_name(conn, cat_name)
        if cat is None:
            continue
        mapping_repo.apply_mapping(conn, name, cat["group_account_id"], user=getpass.getuser())
        applied += 1
    conn.commit()
    return RedirectResponse(
        f"/periods/{period_str}/mapping?flash=Categorized {applied} ledger(s)&flash_kind=success", status_code=303)
