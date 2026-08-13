"""Shared dependencies for route modules — split out from app.py to avoid a circular
import (routes need `get_db`/`templates`, and app.py needs to import the routes)."""

import json
import sqlite3
from pathlib import Path

from fastapi.templating import Jinja2Templates

PROJECT_ROOT = Path(__file__).parent.parent.parent
CONFIG_DIR = PROJECT_ROOT / "config"


def _settings() -> dict:
    return json.loads((CONFIG_DIR / "app_settings.json").read_text(encoding="utf-8"))


def _db_path() -> str:
    """config's database_path is relative (e.g. "data/consolidation.db"), and a relative
    path resolves against the *process's* CWD — which is NOT reliably the project
    directory once this is launched by something other than a person `cd`-ed into it (a
    real bug found while verifying: uvicorn launched via a tool spawned with a different
    CWD silently created a fresh, empty database in the wrong directory). Resolve against
    PROJECT_ROOT explicitly, same as CONFIG_DIR already does, so it doesn't matter where
    the process is started from."""
    raw = _settings()["database_path"]
    path = Path(raw)
    return str(path if path.is_absolute() else PROJECT_ROOT / path)


def get_db():
    """Mirrors src/cli.py's _connect(): open, seed (idempotent), yield, close."""
    from src.db.database import get_connection
    from src.db.seed import seed_all

    conn = get_connection(_db_path())
    seed_all(conn)
    try:
        yield conn
    finally:
        conn.close()


def idr(value) -> str:
    if value is None:
        return ""
    value = float(value)
    formatted = f"{abs(value):,.0f}"
    return f"({formatted})" if value < 0 else formatted


def pct(value) -> str:
    if value is None:
        return ""
    return f"{float(value) * 100:.1f}%"


def _inject_period_status(request) -> dict:
    """Every page's URL carries {period_str} in its path when it's period-scoped. Rather
    than trust each route handler to remember to pass period_status into its own template
    context (a real bug found in RCA: only the dashboard route did, so the locked-period
    badge silently disappeared on every other page), resolve it here once, centrally, for
    every render — a route can still override it by passing period_status explicitly.

    Also resolves consolidation_stale the same way, for the same reason (source plan §4.4):
    an edited/applied/deleted adjustment since the last consolidate should show an amber
    banner on every period-scoped page, not just the one the edit happened to be made from."""
    period_str = request.path_params.get("period_str")
    if not period_str:
        return {}
    try:
        year_str, month_str = period_str.split("-")
        conn = sqlite3.connect(_db_path())
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute(
                "SELECT period_id, status FROM periods WHERE year = ? AND month = ?",
                (int(year_str), int(month_str)),
            ).fetchone()
            if row is None:
                return {}
            # Best-effort: this connection bypasses apply_migrations (unlike get_db()), so
            # a not-yet-migrated on-disk db shouldn't take down the period_status badge
            # that's worked here all along — only the new staleness banner degrades.
            stale = False
            try:
                from src.db.repositories import period_repo
                stale = period_repo.is_consolidation_stale(conn, row["period_id"])
            except sqlite3.Error:
                pass
        finally:
            conn.close()
        return {"period_status": row["status"], "consolidation_stale": stale}
    except (ValueError, sqlite3.Error):
        return {}


templates = Jinja2Templates(
    directory=str(Path(__file__).parent / "templates"),
    context_processors=[_inject_period_status],
)
templates.env.filters["idr"] = idr
templates.env.filters["pct"] = pct
