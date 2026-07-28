import getpass
import sqlite3
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, Request, UploadFile, File, Form
from fastapi.responses import RedirectResponse, FileResponse

from src.db.repositories import entity_repo, period_repo, tb_repo, mapping_repo
from src.engines.validation_engine import run_all
from src.importers.tally_tb_parser import parse_file
from src.web.deps import get_db, templates

router = APIRouter()


@router.get("/periods/{period_str}/import")
def import_form(request: Request, period_str: str, conn: sqlite3.Connection = Depends(get_db)):
    entities = entity_repo.list_all(conn)
    return templates.TemplateResponse(request, "import.html", {
        "request": request, "period_str": period_str, "entities": entities,
    })


@router.post("/periods/{period_str}/import")
def import_tb(period_str: str, entity_code: str = Form(...), file: UploadFile = File(...),
              conn: sqlite3.Connection = Depends(get_db)):
    entity = entity_repo.get_by_code(conn, entity_code)
    if entity is None:
        return RedirectResponse(
            f"/periods/{period_str}/import?flash=Unknown entity {entity_code}&flash_kind=error", status_code=303)

    period_id = period_repo.get_or_create(conn, *period_repo.parse_period_str(period_str))

    with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as tmp:
        tmp.write(file.file.read())
        tmp_path = tmp.name
    try:
        parsed = parse_file(tmp_path)
        parsed.source_filename = file.filename  # keep the real uploaded filename, not the temp path
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    try:
        tb_repo.import_tb(conn, period_id, entity["entity_id"], parsed, imported_by=getpass.getuser())
    except ValueError as e:
        return RedirectResponse(f"/periods/{period_str}/import?flash={e}&flash_kind=error", status_code=303)
    mapping_repo.ensure_rows_exist(conn, period_id)
    conn.commit()

    msg = f"Imported {file.filename}: {len(parsed.lines)} lines"
    if parsed.warnings:
        msg += f", {len(parsed.warnings)} warning(s)"
    return RedirectResponse(
        f"/periods/{period_str}/import?flash={msg}&flash_kind=success", status_code=303)


@router.post("/periods/{period_str}/lock")
def lock_period(period_str: str, conn: sqlite3.Connection = Depends(get_db)):
    period = period_repo.get_by_str(conn, period_str)
    if period is None:
        return RedirectResponse(f"/?flash=No such period&flash_kind=error", status_code=303)
    results = run_all(conn, period["period_id"])
    errors = [r for r in results if not r.passed and r.severity == "Error"]
    if errors:
        msg = "Cannot lock: " + "; ".join(f"{r.check_id} failed" for r in errors)
        return RedirectResponse(f"/?period={period_str}&flash={msg}&flash_kind=error", status_code=303)
    period_repo.lock(conn, period["period_id"], user=getpass.getuser())
    conn.commit()
    return RedirectResponse(f"/?period={period_str}&flash=Period locked&flash_kind=success", status_code=303)


@router.post("/periods/{period_str}/unlock")
def unlock_period(period_str: str, conn: sqlite3.Connection = Depends(get_db)):
    period = period_repo.get_by_str(conn, period_str)
    if period is None:
        return RedirectResponse(f"/?flash=No such period&flash_kind=error", status_code=303)
    period_repo.unlock(conn, period["period_id"], user=getpass.getuser())
    conn.commit()
    return RedirectResponse(f"/?period={period_str}&flash=Period unlocked&flash_kind=success", status_code=303)


@router.get("/periods/{period_str}/export-pack")
def export_pack_download(period_str: str, conn: sqlite3.Connection = Depends(get_db)):
    from src.exporters.excel_pack_generator import export_pack
    period = period_repo.get_by_str(conn, period_str)
    if period is None:
        return RedirectResponse(f"/?flash=No such period&flash_kind=error", status_code=303)
    out_path = Path(tempfile.gettempdir()) / f"Consolidated Pack {period_str}.xlsx"
    export_pack(conn, period["period_id"], str(out_path))
    return FileResponse(str(out_path), filename=f"Consolidated Pack {period_str}.xlsx",
                          media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
