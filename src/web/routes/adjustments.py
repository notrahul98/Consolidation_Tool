import getpass
import sqlite3

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import RedirectResponse

from src.db.repositories import adjustment_repo, entity_repo, group_coa_repo, period_repo
from src.db.repositories.adjustment_repo import VALID_TYPES
from src.engines.adjustment_engine import create_adjustment, copy_prior_month
from src.web.deps import get_db, templates

router = APIRouter()


@router.get("/periods/{period_str}/adjustments")
def list_adjustments(request: Request, period_str: str, conn: sqlite3.Connection = Depends(get_db)):
    period = period_repo.get_by_str(conn, period_str)
    if period is None:
        return RedirectResponse(f"/?flash=No such period&flash_kind=error", status_code=303)

    adjustments = []
    for adj in adjustment_repo.list_for_period(conn, period["period_id"]):
        lines = adjustment_repo.get_lines(conn, adj["adjustment_id"])
        total_dr = sum(l["debit_amount"] or 0 for l in lines)
        line_summaries = []
        for l in lines:
            cat = group_coa_repo.get_by_id(conn, l["group_account_id"])
            entity_code = ""
            if l["entity_id"]:
                e = conn.execute("SELECT entity_code FROM entities WHERE entity_id = ?",
                                  (l["entity_id"],)).fetchone()
                entity_code = e["entity_code"] if e else ""
            line_summaries.append({
                "entity": entity_code or "(group)",
                "category": cat["account_name"] if cat else "?",
                "debit": l["debit_amount"], "credit": l["credit_amount"],
            })
        adjustments.append({
            "ref": adj["external_ref"], "type": adj["adjustment_type"], "narration": adj["narration"],
            "status": adj["status"], "total": total_dr, "lines": line_summaries,
        })

    prior = period_repo.get_prior(conn, period["period_id"])
    return templates.TemplateResponse(request, "adjustments_list.html", {
        "request": request, "period_str": period_str, "adjustments": adjustments,
        "period_status": period["status"], "has_prior": prior is not None,
    })


@router.get("/periods/{period_str}/adjustments/new")
def new_adjustment_form(request: Request, period_str: str, conn: sqlite3.Connection = Depends(get_db)):
    entities = entity_repo.list_all(conn)
    categories = group_coa_repo.list_leaf_categories(conn)
    return templates.TemplateResponse(request, "adjustments_form.html", {
        "request": request, "period_str": period_str, "entities": entities,
        "categories": [c["account_name"] for c in categories], "types": sorted(VALID_TYPES),
        "errors": [], "form": {},
    })


@router.post("/periods/{period_str}/adjustments/new")
def create_adjustment_route(request: Request, period_str: str,
                              external_ref: str = Form(...), adjustment_type: str = Form(...),
                              narration: str = Form(...),
                              entity_code: list[str] = Form(default=[]),
                              category: list[str] = Form(default=[]),
                              debit: list[str] = Form(default=[]),
                              credit: list[str] = Form(default=[]),
                              conn: sqlite3.Connection = Depends(get_db)):
    period = period_repo.get_by_str(conn, period_str)
    if period is None:
        return RedirectResponse(f"/?flash=No such period&flash_kind=error", status_code=303)

    entities = entity_repo.list_all(conn)
    categories = group_coa_repo.list_leaf_categories(conn)
    errors = []
    lines = []
    for i, (ecode, cat_name, dr, cr) in enumerate(zip(entity_code, category, debit, credit), start=1):
        if not cat_name:
            continue
        cat = group_coa_repo.get_by_name(conn, cat_name)
        if cat is None:
            errors.append(f"Line {i}: unknown category '{cat_name}'")
            continue
        entity_id = None
        if ecode:
            e = entity_repo.get_by_code(conn, ecode)
            if e is None:
                errors.append(f"Line {i}: unknown entity '{ecode}'")
                continue
            entity_id = e["entity_id"]
        lines.append({
            "entity_id": entity_id, "group_account_id": cat["group_account_id"],
            "debit_amount": float(dr or 0), "credit_amount": float(cr or 0),
        })

    if not errors:
        try:
            create_adjustment(conn, period["period_id"], external_ref, adjustment_type, narration,
                                lines, user=getpass.getuser())
            conn.commit()
        except ValueError as e:
            errors = str(e).split("\n")

    if errors:
        return templates.TemplateResponse(request, "adjustments_form.html", {
            "request": request, "period_str": period_str, "entities": entities,
            "categories": [c["account_name"] for c in categories], "types": sorted(VALID_TYPES),
            "errors": errors,
            "form": {"external_ref": external_ref, "adjustment_type": adjustment_type, "narration": narration},
        }, status_code=400)

    return RedirectResponse(
        f"/periods/{period_str}/adjustments?flash=Created {external_ref} as draft&flash_kind=success",
        status_code=303)


@router.post("/periods/{period_str}/adjustments/apply-all")
def apply_all_route(period_str: str, conn: sqlite3.Connection = Depends(get_db)):
    period = period_repo.get_by_str(conn, period_str)
    try:
        n = adjustment_repo.apply_all(conn, period["period_id"], user=getpass.getuser())
        conn.commit()
        msg, kind = f"Applied {n} draft adjustment(s) — re-run Consolidate to see the effect", "success"
    except ValueError as e:
        msg, kind = str(e), "error"
    return RedirectResponse(f"/periods/{period_str}/adjustments?flash={msg}&flash_kind={kind}", status_code=303)


@router.post("/periods/{period_str}/adjustments/{ref}/delete")
def delete_adjustment_route(period_str: str, ref: str, conn: sqlite3.Connection = Depends(get_db)):
    period = period_repo.get_by_str(conn, period_str)
    row = conn.execute(
        "SELECT adjustment_id FROM adjustments WHERE period_id = ? AND external_ref = ?",
        (period["period_id"], ref),
    ).fetchone()
    if row:
        try:
            adjustment_repo.delete(conn, period["period_id"], row["adjustment_id"], user=getpass.getuser())
            conn.commit()
            msg, kind = f"Deleted {ref}", "success"
        except ValueError as e:
            msg, kind = str(e), "error"
    else:
        msg, kind = f"No adjustment {ref} found", "error"
    return RedirectResponse(f"/periods/{period_str}/adjustments?flash={msg}&flash_kind={kind}", status_code=303)


@router.post("/periods/{period_str}/adjustments/copy-prior")
def copy_prior_route(period_str: str, conn: sqlite3.Connection = Depends(get_db)):
    period = period_repo.get_by_str(conn, period_str)
    try:
        n = copy_prior_month(conn, period["period_id"], user=getpass.getuser())
        conn.commit()
        msg, kind = f"Copied {n} adjustment(s) from the prior period as drafts", "success"
    except ValueError as e:
        msg, kind = str(e), "error"
    return RedirectResponse(f"/periods/{period_str}/adjustments?flash={msg}&flash_kind={kind}", status_code=303)
