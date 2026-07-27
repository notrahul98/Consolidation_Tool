import sqlite3

from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse

from src.db.repositories import period_repo
from src.web.deps import get_db, templates

router = APIRouter()


@router.get("/periods/{period_str}/audit")
def audit_log(request: Request, period_str: str, conn: sqlite3.Connection = Depends(get_db)):
    period = period_repo.get_by_str(conn, period_str)
    if period is None:
        return RedirectResponse(f"/?flash=No such period&flash_kind=error", status_code=303)
    rows = conn.execute("SELECT * FROM audit_log ORDER BY log_id DESC LIMIT 500").fetchall()
    return templates.TemplateResponse(request, "audit_log.html", {
        "request": request, "period_str": period_str, "rows": rows,
    })
