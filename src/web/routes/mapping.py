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

    ledger_rows = mapping_repo.ledger_rows_for_period(conn, period["period_id"])
    ledger_rows.sort(key=lambda x: x["ledger_name"])
    categories = group_coa_repo.list_leaf_categories(conn)

    rows = []
    for entry in ledger_rows:
        if entry["needs_split"]:
            # Render split ledgers as a parent row with per-entity children
            rows.append({
                "ledger_name": entry["ledger_name"],
                "is_parent": True,
                "total_balance": entry["total_balance"],
                "badge": "Split across entities",
                "primary_groups": ", ".join(sorted(entry["entities"][i]["primary_group"] for i in range(len(entry["entities"])) if entry["entities"][i]["primary_group"])),
            })
            for ent in entry["entities"]:
                rows.append({
                    "ledger_name": entry["ledger_name"],
                    "is_child": True,
                    "entity_id": ent["entity_id"],
                    "entity_code": ent["entity_code"],
                    "primary_group": ent["primary_group"],
                    "balance": ent["balance"],
                    "current_category": ent["category_name"] or "",
                })
        else:
            # Simple row for ledgers that appear in only one entity or with consistent mapping
            rows.append({
                "ledger_name": entry["ledger_name"],
                "is_parent": False,
                "is_child": False,
                "entity_code": entry["entities"][0]["entity_code"] if entry["entities"] else "",
                "primary_group": entry["entities"][0]["primary_group"] if entry["entities"] else "",
                "total_balance": entry["total_balance"],
                "current_category": entry["uniform_category"] or "",
            })

    return templates.TemplateResponse(request, "mapping.html", {
        "request": request, "period_str": period_str, "rows": rows,
        "categories": [c["account_name"] for c in categories],
    })


@router.post("/periods/{period_str}/mapping")
def apply_mapping_form(period_str: str,
                         ledger_name: list[str] = Form(default=[]),
                         entity_code: list[str] = Form(default=[]),
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

    # Build a map of ledger_name -> needs_split for validation
    ledger_rows = mapping_repo.ledger_rows_for_period(conn, period["period_id"])
    split_ledgers = {row["ledger_name"] for row in ledger_rows if row["needs_split"]}

    applied = 0
    for name, ent_code, cat_name in zip(ledger_name, entity_code, category):
        if not cat_name:
            continue
        cat = group_coa_repo.get_by_name(conn, cat_name)
        if cat is None:
            continue

        # Guard: reject whole-ledger writes for split ledgers
        if name in split_ledgers and not ent_code:
            return RedirectResponse(
                f"/periods/{period_str}/mapping?flash=Cannot apply a single category to '{name}' across all entities — it has different mappings. Update each entity separately.&flash_kind=error",
                status_code=303)

        if ent_code:
            # Per-entity mapping
            entity = conn.execute(
                "SELECT entity_id FROM entities WHERE entity_code = ?", (ent_code,)
            ).fetchone()
            if entity is None:
                continue
            mapping_repo.apply_mapping_for_entity(
                conn, entity["entity_id"], name, cat["group_account_id"], user=getpass.getuser())
        else:
            # Whole-ledger mapping (only allowed for non-split ledgers)
            mapping_repo.apply_mapping(conn, name, cat["group_account_id"], user=getpass.getuser())
        applied += 1

    conn.commit()
    return RedirectResponse(
        f"/periods/{period_str}/mapping?flash=Categorized {applied} ledger(s)&flash_kind=success", status_code=303)
