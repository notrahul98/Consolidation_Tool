import sqlite3

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates

from src.db.repositories import period_repo
from src.engines.statement_generator import compute_pl, compute_bs
from src.engines.validation_engine import run_all
from src.web.deps import get_db, templates

router = APIRouter()


@router.get("/")
def dashboard(request: Request, period: str | None = None, conn: sqlite3.Connection = Depends(get_db)):
    periods = period_repo.list_all(conn)
    if period is None and periods:
        period = period_repo.as_str(periods[0])

    context = {
        "request": request,
        "periods": periods,
        "period_str": period,
        "has_period": period is not None,
    }

    if period is None:
        return templates.TemplateResponse(request, "dashboard.html", context)

    row = period_repo.get_by_str(conn, period)
    if row is None:
        return RedirectResponse(f"/?flash=No such period {period} yet&flash_kind=error", status_code=303)

    period_id = row["period_id"]
    context["period_status"] = row["status"]
    validations = run_all(conn, period_id)
    context["validations"] = validations
    context["all_pass"] = all(v.passed for v in validations if v.severity == "Error")

    has_data = conn.execute(
        "SELECT 1 FROM consolidated_tb WHERE period_id = ? AND source_type = 'total' LIMIT 1", (period_id,)
    ).fetchone()
    context["has_consolidated_data"] = bool(has_data)

    if has_data:
        pl_lines, net_income = compute_pl(conn, period_id)
        bs_lines, total_assets, total_le = compute_bs(conn, period_id)
        total_sales = next((l.value for l in pl_lines if l.label == "Total Sales"), 0.0)
        context.update({
            "total_sales": total_sales,
            "net_income": net_income,
            "total_assets": total_assets,
            "total_le": total_le,
            "bs_diff": total_assets - total_le,
        })

    return templates.TemplateResponse(request, "dashboard.html", context)


@router.post("/periods/new")
def create_period(period: str = Form(...), conn: sqlite3.Connection = Depends(get_db)):
    year, month = period_repo.parse_period_str(period)
    period_repo.get_or_create(conn, year, month)
    conn.commit()
    return RedirectResponse(f"/?period={period}", status_code=303)
