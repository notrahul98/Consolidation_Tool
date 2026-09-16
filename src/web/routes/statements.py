import calendar
import sqlite3

from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse

from src.db.repositories import consolidated_repo, entity_repo, group_coa_repo, period_repo
from src.engines import comparative_engine
from src.engines.consolidation_engine import consolidate_period
from src.engines.statement_generator import compute_pl, compute_bs
from src.web.deps import get_db, templates

router = APIRouter()

MONTH_ABBR = list(calendar.month_abbr)


def _month_label(key: str) -> str:
    """'2026-08' -> "Aug'26"."""
    year, month = key.split("-")
    return f"{MONTH_ABBR[int(month)]}'{year[2:]}"


def _comparative_context(conn, period_str, title, result, show_percent, months="present"):
    """Flattens a ComparativeResult into columns + rows so the template stays declarative.

    Columns are ordered as the reference workbook orders them: the two YTD columns pinned
    first (P&L only), then each month of the year immediately followed by the same month of
    the prior year.

    `months="present"` drops a month pair only when *neither* year has data. On a fully
    loaded year that hides nothing and the layout matches the workbook exactly; on the live
    database, which holds May-Aug 2026 and no 2025 at all, it is the difference between four
    readable columns and twenty columns of dashes to scroll past. `months="all"` restores
    the full Jan-Dec grid.
    """
    ctx = result.context
    anchor = _month_label(ctx.anchor_key)

    columns = []
    if comparative_engine.YTD_CURRENT in result.columns:
        columns.append({"key": comparative_engine.YTD_CURRENT, "label": f"YTD {anchor}", "pinned": True})
        columns.append({"key": comparative_engine.YTD_PRIOR,
                        "label": f"YTD {_month_label(f'{ctx.anchor_year - 1}-{ctx.anchor_month:02d}')}",
                        "pinned": True})
    hidden_months = 0
    for (current, prior) in ctx.month_pairs:
        keys = [comparative_engine.month_key(y, m) for y, m in (current, prior)]
        if months != "all" and not any(result.has_data(k) for k in keys):
            hidden_months += 1
            continue
        for key in keys:
            columns.append({"key": key, "label": _month_label(key), "pinned": False})
    for column in columns:
        column["has_data"] = result.has_data(column["key"])

    rows = []
    for line in result.lines:
        cells = [] if line.kind == "section" else [
            {"value": result.value(c["key"], line.label),
             "percent": result.percent(c["key"], line.label)}
            for c in columns
        ]
        rows.append({"label": line.label, "level": line.level, "kind": line.kind, "cells": cells})

    last_day = calendar.monthrange(ctx.anchor_year, ctx.anchor_month)[1]
    return {
        "period_str": period_str,
        "title": title,
        "subtitle": f"period ended {last_day} {MONTH_ABBR[ctx.anchor_month]} {ctx.anchor_year}",
        "columns": columns,
        "rows": rows,
        "show_percent": show_percent,
        "missing": ctx.missing,
        "open_in_range": ctx.open_in_range,
        "stale_in_range": ctx.stale_in_range,
        "column_span": len(columns) * (2 if show_percent else 1) + 1,
        "hidden_months": hidden_months,
        "months": months,
    }


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
def pl_statement(request: Request, period_str: str, view: str = "comparative",
                 months: str = "present", conn: sqlite3.Connection = Depends(get_db)):
    """Comparative by default; ?view=simple keeps the original single-column statement, which
    stays the quickest way to read one month and to sanity-check a comparative column."""
    period = period_repo.get_by_str(conn, period_str)
    if period is None:
        return RedirectResponse(f"/?flash=No such period&flash_kind=error", status_code=303)

    if view == "simple":
        lines, net_income = compute_pl(conn, period["period_id"])
        return templates.TemplateResponse(request, "statement.html", {
            "request": request, "period_str": period_str, "title": "Profit & Loss",
            "lines": lines, "show_percent": True,
        })

    result = comparative_engine.compute_pl_comparative(conn, period["period_id"])
    context = _comparative_context(conn, period_str, "Profit and Loss", result,
                                   show_percent=True, months=months)
    return templates.TemplateResponse(request, "statement_comparative.html",
                                      {"request": request, "statement": "pl", **context})


@router.get("/periods/{period_str}/bs")
def bs_statement(request: Request, period_str: str, view: str = "comparative",
                 months: str = "present", conn: sqlite3.Connection = Depends(get_db)):
    period = period_repo.get_by_str(conn, period_str)
    if period is None:
        return RedirectResponse(f"/?flash=No such period&flash_kind=error", status_code=303)

    if view == "simple":
        lines, total_assets, total_le = compute_bs(conn, period["period_id"])
        return templates.TemplateResponse(request, "statement.html", {
            "request": request, "period_str": period_str, "title": "Balance Sheet",
            "lines": lines, "show_percent": False,
        })

    result = comparative_engine.compute_bs_comparative(conn, period["period_id"])
    context = _comparative_context(conn, period_str, "Balance Sheet", result,
                                   show_percent=False, months=months)
    return templates.TemplateResponse(request, "statement_comparative.html",
                                      {"request": request, "statement": "bs", **context})
