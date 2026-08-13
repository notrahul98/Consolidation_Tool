import sqlite3

from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse

from src.db.repositories import period_repo
from src.engines import re_check
from src.engines.validation_engine import TOLERANCE_IDR
from src.web.deps import get_db, templates

router = APIRouter()


@router.get("/periods/{period_str}/retained-earnings")
def retained_earnings_page(request: Request, period_str: str, conn: sqlite3.Connection = Depends(get_db)):
    period = period_repo.get_by_str(conn, period_str)
    if period is None:
        return RedirectResponse(f"/?flash=No such period&flash_kind=error", status_code=303)

    result = re_check.run(conn, period["period_id"])

    group_row = None
    entity_rows = []
    if result.applicable:
        for row in result.rows:
            if row.entity_code is None:
                group_row = row
            else:
                entity_rows.append(row)

    return templates.TemplateResponse(request, "retained_earnings.html", {
        "request": request,
        "period_str": period_str,
        "result": result,
        "group_row": group_row,
        "entity_rows": entity_rows,
        "tolerance": TOLERANCE_IDR,
    })
