"""Route-level smoke tests for the web layer. The engine/repo logic is already covered
by the rest of the suite — these confirm the FastAPI routes correctly wire form input
through to it (the two endpoints with real validation logic in the request path)."""

import pytest
from fastapi.testclient import TestClient

from src.web.app import app
from src.web.deps import get_db
from tests.conftest import categorize_all


@pytest.fixture
def client(consolidated):
    """sqlite connections are thread-affine, and TestClient dispatches each request to
    a worker thread — reusing one Connection object across requests fails with
    'objects created in a thread can only be used in that same thread'. Open a fresh
    connection per request instead, against the same on-disk test database file,
    matching how get_db() already behaves in production (fresh connection per request)."""
    conn, period_id, _ = consolidated
    db_path = conn.execute("PRAGMA database_list").fetchone()["file"]

    def override_get_db():
        from src.db.database import connect
        c = connect(db_path)
        try:
            yield c
        finally:
            c.close()

    app.dependency_overrides[get_db] = override_get_db
    yield TestClient(app), conn, period_id
    app.dependency_overrides.clear()


def test_dashboard_loads(client):
    c, conn, period_id = client
    resp = c.get("/?period=2026-06")
    assert resp.status_code == 200
    assert "Dashboard" in resp.text
    assert "299,656,250" in resp.text  # Total Sales, a known-good figure


def test_create_balanced_adjustment_succeeds(client):
    c, conn, period_id = client
    resp = c.post("/periods/2026-06/adjustments/new", data={
        "external_ref": "ADJ-ROUTE-TEST-1",
        "adjustment_type": "other",
        "narration": "route smoke test",
        "entity_code": ["KNS", "KNS"],
        "category": ["Bank Charges", "Misc. Expense"],
        "debit": ["500", ""],
        "credit": ["", "500"],
    }, follow_redirects=False)
    assert resp.status_code == 303
    assert "Created" in resp.headers["location"]

    list_resp = c.get("/periods/2026-06/adjustments")
    assert "ADJ-ROUTE-TEST-1" in list_resp.text
    assert "draft" in list_resp.text


def test_create_unbalanced_adjustment_shows_error_inline(client):
    c, conn, period_id = client
    resp = c.post("/periods/2026-06/adjustments/new", data={
        "external_ref": "ADJ-ROUTE-TEST-BAD",
        "adjustment_type": "other",
        "narration": "should fail",
        "entity_code": ["KNS", "KNS"],
        "category": ["Bank Charges", "Misc. Expense"],
        "debit": ["500", ""],
        "credit": ["", "400"],
    }, follow_redirects=False)
    assert resp.status_code == 400
    assert "does not balance" in resp.text

    # confirm it was never actually created
    list_resp = c.get("/periods/2026-06/adjustments")
    assert "ADJ-ROUTE-TEST-BAD" not in list_resp.text


def test_apply_mapping_via_form(client):
    c, conn, period_id = client
    resp = c.post("/periods/2026-06/mapping", data={
        "ledger_name": ["Sales"],
        "category": ["Sales"],
    }, follow_redirects=False)
    assert resp.status_code == 303
    assert "Categorized" in resp.headers["location"]


def test_pl_and_bs_pages_render_known_figures(client):
    """Asserts the route renders exactly what the (already-tested) engine computed for
    this same fixture — not a hardcoded production figure. The test fixture's simpler
    global-by-ledger-name mapping (conftest.py's FULL_MAPPING) legitimately differs from
    production's entity-aware mapping for one shared ledger name
    ('12% Interest on Shareholders Loan A/c' is a P&L expense for VKS but a tiny BS
    residual for KDI in production; the test fixture maps both the same way), so the
    exact figure isn't the same as the real Consolidated Pack — that's expected."""
    from src.engines.statement_generator import compute_pl, compute_bs

    c, conn, period_id = client
    expected_pl_lines, expected_net_income = compute_pl(conn, period_id)
    expected_bs_lines, expected_total_assets, _ = compute_bs(conn, period_id)

    pl = c.get("/periods/2026-06/pl")
    assert pl.status_code == 200
    assert f"({abs(expected_net_income):,.0f})" in pl.text

    bs = c.get("/periods/2026-06/bs")
    assert bs.status_code == 200
    assert f"{expected_total_assets:,.0f}" in bs.text


def test_validation_page_shows_all_checks_passing(client):
    c, conn, period_id = client
    resp = c.get("/periods/2026-06/validation")
    assert resp.status_code == 200
    assert resp.text.count("badge-pass") == 12
    assert "badge-fail" not in resp.text


@pytest.mark.parametrize("path", [
    "/periods/2026-06/mapping",
    "/periods/2026-06/adjustments",
    "/periods/2026-06/pl",
    "/periods/2026-06/bs",
    "/periods/2026-06/consolidated",
    "/periods/2026-06/validation",
    "/periods/2026-06/audit",
    "/periods/2026-06/import",
])
def test_nav_badge_shows_period_status_on_every_page(client, path):
    """Regression test for the RCA finding: only the dashboard route used to pass
    period_status into its template context, so the lock-status badge silently vanished
    on every other page. Now centrally injected for every period-scoped route."""
    c, conn, period_id = client
    resp = c.get(path)
    assert resp.status_code == 200
    assert "2026-06 &middot; open" in resp.text
