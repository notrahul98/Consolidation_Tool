"""Stock/COGS screen and adjustment generation."""

import getpass
import sqlite3

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import RedirectResponse

from src.db.repositories import period_repo, entity_repo
from src.engines import stock_engine
from src.web.deps import get_db, templates

router = APIRouter()


@router.get("/periods/{period_str}/stock")
def stock_form(request: Request, period_str: str, conn: sqlite3.Connection = Depends(get_db)):
    period = period_repo.get_by_str(conn, period_str)
    if period is None:
        return RedirectResponse(f"/?flash=No such period&flash_kind=error", status_code=303)

    # Refresh stock movement data (auto values)
    stock_rows = stock_engine.refresh(conn, period["period_id"])

    # Format rows for template
    rows = []
    total_computed_cogs = 0.0
    total_tb_cogs = 0.0

    for row in stock_rows:
        rows.append({
            "entity_code": row.entity_code,
            "entity_id": row.entity_id,
            "opening_auto": row.opening_auto,
            "opening": row.opening,
            "opening_override": row.opening_override,
            "closing_auto": row.closing_auto,
            "closing": row.closing,
            "closing_override": row.closing_override,
            "purchases_auto": row.purchases_auto,
            "purchases": row.purchases,
            "purchases_override": row.purchases_override,
            "computed_cogs": row.computed_cogs,
            "tb_cogs": row.tb_cogs,
            "delta": row.delta,
            "balancing_account": row.balancing_account,
            "purchase_ledger_count": row.purchase_ledger_count,
            "tb_opening_inventory": row.tb_opening_inventory,
            "opening_break": row.opening_break,
        })
        if row.computed_cogs is not None:
            total_computed_cogs += row.computed_cogs
        total_tb_cogs += row.tb_cogs

    return templates.TemplateResponse(request, "stock.html", {
        "request": request,
        "period_str": period_str,
        "period_locked": period["status"] == "locked",
        "rows": rows,
        "total_computed_cogs": total_computed_cogs,
        "total_tb_cogs": total_tb_cogs,
    })


@router.post("/periods/{period_str}/stock")
def save_stock_form(period_str: str,
                     entity_id: list[int] = Form(default=[]),
                     opening: list[str] = Form(default=[]),
                     closing: list[str] = Form(default=[]),
                     purchases: list[str] = Form(default=[]),
                     balancing: list[str] = Form(default=[]),
                     conn: sqlite3.Connection = Depends(get_db)):
    period = period_repo.get_by_str(conn, period_str)
    if period is None:
        return RedirectResponse(f"/?flash=No such period&flash_kind=error", status_code=303)

    try:
        period_repo.require_open(conn, period["period_id"], "change stock figures")
    except ValueError as e:
        return RedirectResponse(
            f"/periods/{period_str}/stock?flash={e}&flash_kind=error", status_code=303)

    saved = 0
    user = getpass.getuser()

    for ent_id, open_str, close_str, purch_str, bal_str in zip(entity_id, opening, closing, purchases, balancing):
        try:
            open_val = float(open_str) if open_str else None
            close_val = float(close_str) if close_str else None
            purch_val = float(purch_str) if purch_str else None
        except ValueError:
            continue

        stock_engine.save_overrides(
            conn, period["period_id"], ent_id,
            opening=open_val, closing=close_val, purchases=purch_val,
            balancing_account=bal_str if bal_str else None, user=user
        )
        saved += 1

    return RedirectResponse(
        f"/periods/{period_str}/stock?flash=Saved {saved} entity(ies)&flash_kind=success", status_code=303)


@router.post("/periods/{period_str}/stock/generate")
def generate_stock_adjustment(period_str: str,
                              ref: str = Form(default=""),
                              conn: sqlite3.Connection = Depends(get_db)):
    period = period_repo.get_by_str(conn, period_str)
    if period is None:
        return RedirectResponse(f"/?flash=No such period&flash_kind=error", status_code=303)

    try:
        period_repo.require_open(conn, period["period_id"], "generate stock adjustment")
    except ValueError as e:
        return RedirectResponse(
            f"/periods/{period_str}/stock?flash={e}&flash_kind=error", status_code=303)

    # Use provided ref or default
    if not ref:
        ref = f"ADJ-{period['year']}-{period['month']:02d}-STOCK"

    try:
        stock_engine.generate_adjustment(conn, period["period_id"], ref, user=getpass.getuser())
    except Exception as e:
        return RedirectResponse(
            f"/periods/{period_str}/stock?flash=Error generating adjustment: {e}&flash_kind=error", status_code=303)

    return RedirectResponse(
        f"/periods/{period_str}/adjustments?flash=Created {ref} as draft. Apply it and re-run Consolidate.&flash_kind=success",
        status_code=303)
