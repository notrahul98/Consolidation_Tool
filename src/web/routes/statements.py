import sqlite3

from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse

from src.db.repositories import consolidated_repo, entity_repo, group_coa_repo, period_repo
from src.engines.consolidation_engine import consolidate_period
from src.engines.statement_generator import compute_pl, compute_bs
from src.web.deps import get_db, templates

router = APIRouter()


@router.get("/periods/{period_str}/consolidated")
def consolidated_tb(request: Request, period_str: str, conn: sqlite3.Connection = Depends(get_db)):
    period = period_repo.get_by_str(conn, period_str)
    if period is None:
        return RedirectResponse(f"/?flash=No such period&flash_kind=error", status_code=303)

    entities = entity_repo.list_all(conn)
    coa_rows = group_coa_repo.list_all(conn)
    # Entity columns carry that entity's TB plus any adjustment booked against it; the
    # Adjustments column carries only group-level adjustments (which belong to no entity);
    # Total comes straight from the 'total' row, the same figure the P&L and BS read.
    by_account_entity, group_adjustment, total_by_account = consolidated_repo.get_buckets(
        conn, period["period_id"])

    rows = []
    for row in coa_rows:
        entity_values = [by_account_entity.get((row["group_account_id"], e["entity_id"])) for e in entities]
        adjustment = group_adjustment.get(row["group_account_id"])
        total = total_by_account.get(row["group_account_id"])
        if row["is_header"] and total is None and not any(v is not None for v in entity_values):
            continue
        rows.append({
            "code": row["account_code"], "name": row["account_name"], "is_header": row["is_header"],
            "entity_values": entity_values, "adjustment": adjustment, "total": total,
        })

    return templates.TemplateResponse(request, "consolidated_tb.html", {
        "request": request, "period_str": period_str, "entities": entities, "rows": rows,
    })


@router.post("/periods/{period_str}/consolidated/recalculate")
def recalculate(period_str: str, conn: sqlite3.Connection = Depends(get_db)):
    period = period_repo.get_by_str(conn, period_str)
    result = consolidate_period(conn, period["period_id"])
    conn.commit()
    if result["blocked"]:
        if result.get("reason") == "locked":
            msg = f"Period {period_str} is locked — unlock it first if you really need to re-consolidate"
        else:
            names = "; ".join(f"{n} ({b:,.0f})" for n, b in result["unmapped_material"][:5])
            msg = f"Blocked — {len(result['unmapped_material'])} uncategorized material ledger(s): {names}"
        kind = "error"
    else:
        msg, kind = f"Consolidated: {result['rows_written']} rows written", "success"
    return RedirectResponse(f"/periods/{period_str}/consolidated?flash={msg}&flash_kind={kind}", status_code=303)


@router.get("/periods/{period_str}/pl")
def pl_statement(request: Request, period_str: str, conn: sqlite3.Connection = Depends(get_db)):
    period = period_repo.get_by_str(conn, period_str)
    if period is None:
        return RedirectResponse(f"/?flash=No such period&flash_kind=error", status_code=303)
    lines, net_income = compute_pl(conn, period["period_id"])
    return templates.TemplateResponse(request, "statement.html", {
        "request": request, "period_str": period_str, "title": "Profit & Loss",
        "lines": lines, "show_percent": True,
    })


@router.get("/periods/{period_str}/bs")
def bs_statement(request: Request, period_str: str, conn: sqlite3.Connection = Depends(get_db)):
    period = period_repo.get_by_str(conn, period_str)
    if period is None:
        return RedirectResponse(f"/?flash=No such period&flash_kind=error", status_code=303)
    lines, total_assets, total_le = compute_bs(conn, period["period_id"])
    return templates.TemplateResponse(request, "statement.html", {
        "request": request, "period_str": period_str, "title": "Balance Sheet",
        "lines": lines, "show_percent": False,
    })
