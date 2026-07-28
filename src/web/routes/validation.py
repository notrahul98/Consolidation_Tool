import sqlite3

from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse

from src.db.repositories import period_repo
from src.engines.validation_engine import run_all
from src.web.deps import get_db, templates

router = APIRouter()


@router.get("/periods/{period_str}/validation")
def validation_page(request: Request, period_str: str, conn: sqlite3.Connection = Depends(get_db)):
    period = period_repo.get_by_str(conn, period_str)
    if period is None:
        return RedirectResponse(f"/?flash=No such period&flash_kind=error", status_code=303)
    validations = run_all(conn, period["period_id"])
    return templates.TemplateResponse(request, "validation.html", {
        "request": request, "period_str": period_str, "validations": validations,
    })
