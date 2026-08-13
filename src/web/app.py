"""FastAPI app — the interactive replacement for the CLI + Excel round-trip workflow.
Every route is a thin wrapper around the same engine/repository functions the CLI already
calls; no business logic lives here."""

from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="Tally Consolidation Tool")
app.mount("/static", StaticFiles(directory=str(Path(__file__).parent / "static")), name="static")

from src.web.routes import dashboard, periods, mapping, adjustments, statements, validation, audit, stock, re_check  # noqa: E402

app.include_router(dashboard.router)
app.include_router(periods.router)
app.include_router(mapping.router)
app.include_router(stock.router)
app.include_router(adjustments.router)
app.include_router(statements.router)
app.include_router(validation.router)
app.include_router(re_check.router)
app.include_router(audit.router)
