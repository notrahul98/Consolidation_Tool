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


def test_pl_and_bs_default_to_the_comparative_view(client):
    import html

    c, _conn, _period_id = client

    pl = html.unescape(c.get("/periods/2026-06/pl").text)
    assert 'class="comparative"' in pl
    assert "YTD Jun'26" in pl
    assert "YTD Jun'25" in pl
    assert "Jun'26" in pl and "Jun'25" in pl

    # The full grid is a month pair per calendar month of both years.
    every = html.unescape(c.get("/periods/2026-06/pl?months=all").text)
    assert "Jan'26" in every and "Dec'26" in every and "Jan'25" in every and "Dec'25" in every

    bs = html.unescape(c.get("/periods/2026-06/bs").text)
    assert "Jun'26" in bs
    assert "YTD" not in bs  # point-in-time only; a summed balance sheet is meaningless


def test_comparative_view_warns_about_missing_and_open_months(client):
    """The fixture has June alone, so Jan-May are absent and June is unlocked. Both need to
    be on screen — a YTD column covering one month of six is not wrong, but it is not what
    the heading claims either."""
    c, _conn, _period_id = client
    pl = c.get("/periods/2026-06/pl")

    assert "2026-01, 2026-02, 2026-03, 2026-04, 2026-05" in pl.text
    assert "Open (unlocked) periods in range" in pl.text
    assert "2026-06" in pl.text


def test_empty_month_pairs_are_hidden_by_default_and_restorable(client):
    """June alone means 22 of the 24 month columns are dashes. Hiding the pairs where
    neither year has data is the difference between a readable page and ten screens of
    scrolling; ?months=all puts the full grid back."""
    import html

    c, _conn, _period_id = client

    default = html.unescape(c.get("/periods/2026-06/pl").text)
    assert "11 months with no data in either year hidden" in default
    assert "Jun'26" in default
    assert "Jan'26" not in default
    assert "Show all 12 months" in default

    every = html.unescape(c.get("/periods/2026-06/pl?months=all").text)
    assert "Jan'26" in every and "Dec'26" in every
    assert "hidden" not in every
    assert "Hide empty months" in every


def test_missing_months_render_a_dash_not_a_zero(client):
    c, _conn, _period_id = client
    pl = c.get("/periods/2026-06/pl")
    assert "&mdash;" in pl.text or "—" in pl.text


def test_simple_view_is_still_reachable(client):
    from src.engines.statement_generator import compute_pl

    c, conn, period_id = client
    _lines, net_income = compute_pl(conn, period_id)

    pl = c.get("/periods/2026-06/pl?view=simple")
    assert pl.status_code == 200
    assert "% of Net Sales" in pl.text
    assert "YTD" not in pl.text
    assert f"({abs(net_income):,.0f})" in pl.text

    bs = c.get("/periods/2026-06/bs?view=simple")
    assert bs.status_code == 200
    assert "Amount (IDR)" in bs.text


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
