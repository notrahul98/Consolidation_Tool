"""Tests for the Retained Earnings movement check (Workstream C)."""

import pytest

from src.db.repositories import period_repo, entity_repo, group_coa_repo, consolidated_repo
from src.engines import re_check
from src.engines.consolidation_engine import consolidate_period
from tests.conftest import import_all_entities, categorize_all, MAY_ENTITY_FILES


def _make_period(conn, period_str):
    return period_repo.get_or_create(conn, *period_repo.parse_period_str(period_str))


def test_not_applicable_without_prior_period(conn):
    period_id = _make_period(conn, "2026-01")
    result = re_check.run(conn, period_id)
    assert result.applicable is False
    assert "No prior period" in result.reason


def test_not_applicable_when_prior_not_consolidated(conn):
    prior_id = _make_period(conn, "2026-05")
    current_id = _make_period(conn, "2026-06")
    # Prior period exists but has no consolidated_tb rows
    result = re_check.run(conn, current_id)
    assert result.applicable is False
    assert "not been consolidated" in result.reason


def test_gap_zero_on_synthetic_tying_data(conn):
    """Construct a minimal synthetic scenario where RE rolls forward exactly and assert
    the reported gap is zero."""
    prior_id = _make_period(conn, "2026-05")
    current_id = _make_period(conn, "2026-06")

    entity = entity_repo.get_by_code(conn, "BII")
    re_cat = group_coa_repo.get_by_name(conn, "Retained Earnings")
    sales_cat = group_coa_repo.get_by_name(conn, "Sales")

    # Prior period: RE closing (raw signed) = -1000, Sales (raw signed) = -500 -> income +500
    consolidated_repo.insert_row(conn, prior_id, re_cat["group_account_id"], entity["entity_id"],
                                  0, 0, 0, 1000, 0, 1000, source_type="entity_tb")
    consolidated_repo.insert_row(conn, prior_id, sales_cat["group_account_id"], entity["entity_id"],
                                  0, 0, 0, 500, 0, 500, source_type="entity_tb")
    consolidated_repo.insert_row(conn, prior_id, sales_cat["group_account_id"], None,
                                  0, 0, 0, 500, 0, 500, source_type="total")

    # Current period: RE closing (raw signed) must equal prior (-1000) + profit (500) = -500
    consolidated_repo.insert_row(conn, current_id, re_cat["group_account_id"], entity["entity_id"],
                                  0, 0, 0, 500, 0, 500, source_type="entity_tb")
    conn.commit()

    result = re_check.run(conn, current_id)
    assert result.applicable is True
    group_row = next(r for r in result.rows if r.entity_code is None)
    assert abs(group_row.gap) < 1


def test_gap_reported_when_re_does_not_move(conn):
    """When the current period's RE closing doesn't reflect the prior period's profit,
    the gap should be non-zero and reported."""
    prior_id = _make_period(conn, "2026-05")
    current_id = _make_period(conn, "2026-06")

    entity = entity_repo.get_by_code(conn, "BII")
    re_cat = group_coa_repo.get_by_name(conn, "Retained Earnings")
    sales_cat = group_coa_repo.get_by_name(conn, "Sales")

    consolidated_repo.insert_row(conn, prior_id, re_cat["group_account_id"], entity["entity_id"],
                                  0, 0, 0, 1000, 0, 1000, source_type="entity_tb")
    consolidated_repo.insert_row(conn, prior_id, sales_cat["group_account_id"], entity["entity_id"],
                                  0, 0, 0, 500, 0, 500, source_type="entity_tb")
    consolidated_repo.insert_row(conn, prior_id, sales_cat["group_account_id"], None,
                                  0, 0, 0, 500, 0, 500, source_type="total")

    # Current period: RE stayed flat at -1000 instead of rolling forward to -1500
    consolidated_repo.insert_row(conn, current_id, re_cat["group_account_id"], entity["entity_id"],
                                  0, 0, 0, 1000, 0, 1000, source_type="entity_tb")
    conn.commit()

    result = re_check.run(conn, current_id)
    group_row = next(r for r in result.rows if r.entity_code is None)
    assert abs(group_row.gap) > 1
    # expected = -1000 + 500 = -500; actual stayed at -1000; gap = -1000 - (-500) = -500
    assert abs(group_row.gap - (-500)) < 1


def test_per_entity_rows_sum_to_group_row(conn):
    prior_id = _make_period(conn, "2026-05")
    current_id = _make_period(conn, "2026-06")

    entity_a = entity_repo.get_by_code(conn, "BII")
    entity_b = entity_repo.get_by_code(conn, "KDI")
    re_cat = group_coa_repo.get_by_name(conn, "Retained Earnings")
    sales_cat = group_coa_repo.get_by_name(conn, "Sales")

    # Entity A
    consolidated_repo.insert_row(conn, prior_id, re_cat["group_account_id"], entity_a["entity_id"],
                                  0, 0, 0, 1000, 0, 1000, source_type="entity_tb")
    consolidated_repo.insert_row(conn, prior_id, sales_cat["group_account_id"], entity_a["entity_id"],
                                  0, 0, 0, 300, 0, 300, source_type="entity_tb")
    consolidated_repo.insert_row(conn, current_id, re_cat["group_account_id"], entity_a["entity_id"],
                                  0, 0, 0, 1300, 0, 1300, source_type="entity_tb")

    # Entity B
    consolidated_repo.insert_row(conn, prior_id, re_cat["group_account_id"], entity_b["entity_id"],
                                  0, 0, 0, 2000, 0, 2000, source_type="entity_tb")
    consolidated_repo.insert_row(conn, prior_id, sales_cat["group_account_id"], entity_b["entity_id"],
                                  0, 0, 0, 200, 0, 200, source_type="entity_tb")
    consolidated_repo.insert_row(conn, current_id, re_cat["group_account_id"], entity_b["entity_id"],
                                  0, 0, 0, 2200, 0, 2200, source_type="entity_tb")

    # Total row for group compute_pl to tie
    consolidated_repo.insert_row(conn, prior_id, sales_cat["group_account_id"], None,
                                  0, 0, 0, 500, 0, 500, source_type="total")
    conn.commit()

    result = re_check.run(conn, current_id)
    entity_rows = [r for r in result.rows if r.entity_code is not None]
    group_row = next(r for r in result.rows if r.entity_code is None)

    assert abs(sum(r.re_closing_prior for r in entity_rows) - group_row.re_closing_prior) < 1
    assert abs(sum(r.re_closing_current for r in entity_rows) - group_row.re_closing_current) < 1


def test_group_row_net_profit_matches_compute_pl(conn):
    """Guards the two-different-methods risk: the group row's prior_net_profit must use
    compute_pl directly so it ties to the P&L page exactly."""
    from src.engines.statement_generator import compute_pl

    prior_id = _make_period(conn, "2026-05")
    current_id = _make_period(conn, "2026-06")

    entity = entity_repo.get_by_code(conn, "BII")
    re_cat = group_coa_repo.get_by_name(conn, "Retained Earnings")
    sales_cat = group_coa_repo.get_by_name(conn, "Sales")

    consolidated_repo.insert_row(conn, prior_id, re_cat["group_account_id"], entity["entity_id"],
                                  0, 0, 0, 1000, 0, 1000, source_type="entity_tb")
    consolidated_repo.insert_row(conn, prior_id, sales_cat["group_account_id"], entity["entity_id"],
                                  0, 0, 0, 777, 0, 777, source_type="entity_tb")
    consolidated_repo.insert_row(conn, prior_id, sales_cat["group_account_id"], None,
                                  0, 0, 0, 777, 0, 777, source_type="total")
    consolidated_repo.insert_row(conn, current_id, re_cat["group_account_id"], entity["entity_id"],
                                  0, 0, 0, 1000, 0, 1000, source_type="entity_tb")
    conn.commit()

    result = re_check.run(conn, current_id)
    group_row = next(r for r in result.rows if r.entity_code is None)

    _, expected_net_income = compute_pl(conn, prior_id)
    assert group_row.prior_net_profit == expected_net_income


def test_linked_adjustments_include_pl_and_re_lines_from_both_periods(conn):
    from src.engines import adjustment_engine

    prior_id = _make_period(conn, "2026-05")
    current_id = _make_period(conn, "2026-06")

    entity = entity_repo.get_by_code(conn, "BII")
    re_cat = group_coa_repo.get_by_name(conn, "Retained Earnings")
    sales_cat = group_coa_repo.get_by_name(conn, "Sales")

    consolidated_repo.insert_row(conn, prior_id, re_cat["group_account_id"], entity["entity_id"],
                                  0, 0, 0, 1000, 0, 1000, source_type="entity_tb")
    consolidated_repo.insert_row(conn, current_id, re_cat["group_account_id"], entity["entity_id"],
                                  0, 0, 0, 1000, 0, 1000, source_type="entity_tb")
    conn.commit()

    # Adjustment in prior period touching RE and Sales
    adjustment_engine.create_adjustment(
        conn, prior_id, "ADJ-PRIOR-RE", "reclassification", "Prior period RE/Sales adj",
        [
            {"entity_id": entity["entity_id"], "group_account_id": re_cat["group_account_id"],
             "debit_amount": 100.0, "credit_amount": 0.0, "line_narration": "RE line"},
            {"entity_id": entity["entity_id"], "group_account_id": sales_cat["group_account_id"],
             "debit_amount": 0.0, "credit_amount": 100.0, "line_narration": "Sales line"},
        ], user="test",
    )

    # Adjustment in current period touching Sales only (still a PL category)
    adjustment_engine.create_adjustment(
        conn, current_id, "ADJ-CURRENT-PL", "accrual", "Current period PL adj",
        [
            {"entity_id": entity["entity_id"], "group_account_id": sales_cat["group_account_id"],
             "debit_amount": 50.0, "credit_amount": 0.0, "line_narration": "Sales debit"},
            {"entity_id": entity["entity_id"], "group_account_id": re_cat["group_account_id"],
             "debit_amount": 0.0, "credit_amount": 50.0, "line_narration": "RE credit"},
        ], user="test",
    )
    conn.commit()

    result = re_check.run(conn, current_id)
    refs = {a["external_ref"] for a in result.linked_adjustments}
    assert "ADJ-PRIOR-RE" in refs
    assert "ADJ-CURRENT-PL" in refs
    periods_seen = {a["period_str"] for a in result.linked_adjustments}
    assert "2026-05" in periods_seen
    assert "2026-06" in periods_seen


def test_v20_is_warning_and_never_blocks_lock(conn):
    from src.engines.validation_engine import _v20_re_movement_ties_to_prior_profit

    prior_id = _make_period(conn, "2026-05")
    current_id = _make_period(conn, "2026-06")

    entity = entity_repo.get_by_code(conn, "BII")
    re_cat = group_coa_repo.get_by_name(conn, "Retained Earnings")
    sales_cat = group_coa_repo.get_by_name(conn, "Sales")

    consolidated_repo.insert_row(conn, prior_id, re_cat["group_account_id"], entity["entity_id"],
                                  0, 0, 0, 1000, 0, 1000, source_type="entity_tb")
    consolidated_repo.insert_row(conn, prior_id, sales_cat["group_account_id"], entity["entity_id"],
                                  0, 0, 0, 500, 0, 500, source_type="entity_tb")
    consolidated_repo.insert_row(conn, prior_id, sales_cat["group_account_id"], None,
                                  0, 0, 0, 500, 0, 500, source_type="total")
    # Current period RE does NOT tie
    consolidated_repo.insert_row(conn, current_id, re_cat["group_account_id"], entity["entity_id"],
                                  0, 0, 0, 1000, 0, 1000, source_type="entity_tb")
    conn.commit()

    result = _v20_re_movement_ties_to_prior_profit(conn, current_id)
    assert result.severity == "Warning"
    assert result.passed is False
    assert result.check_id == "V20"


def test_re_page_renders(two_periods):
    from fastapi.testclient import TestClient
    from src.web.app import app
    from src.web.deps import get_db

    conn, may_id, june_id = two_periods
    db_path = conn.execute("PRAGMA database_list").fetchone()["file"]

    def override_get_db():
        from src.db.database import connect
        c = connect(db_path)
        try:
            yield c
        finally:
            c.close()

    app.dependency_overrides[get_db] = override_get_db
    try:
        client = TestClient(app)
        resp = client.get("/periods/2026-06/retained-earnings")
        assert resp.status_code == 200
        assert "Retained Earnings Movement" in resp.text
    finally:
        app.dependency_overrides.clear()


def test_group_row_includes_group_level_re_adjustments(consolidated):
    """A Retained Earnings adjustment booked at GROUP level (entity_id NULL) belongs to no
    entity bucket. If the group row sums entity buckets alone it omits that adjustment while
    prior_net_profit (from compute_pl) still includes group-level effects, and the reported
    gap is wrong by exactly the adjustment. Found on the real July 2026 data, where the
    13,608,330,781 shareholder-loan reclass was silently missing from the check."""
    from src.db.repositories import adjustment_repo, group_coa_repo, period_repo
    from src.engines.adjustment_engine import create_adjustment
    from src.engines.consolidation_engine import consolidate_period
    from src.engines import re_check

    conn, current_id, _ = consolidated
    prior_id = period_repo.get_or_create(conn, 2026, 5)
    # Give the prior period something consolidated so the check is applicable.
    re_cat = group_coa_repo.get_by_name(conn, "Retained Earnings")
    consolidated_repo.insert_row(conn, prior_id, re_cat["group_account_id"], None,
                                 0, 0, 0, 0, 0, 0, source_type="total")
    conn.commit()

    before = re_check.run(conn, current_id)
    group_before = next(r for r in before.rows if r.entity_code is None).re_closing_current

    amount = 9_876_543_210.0
    create_adjustment(conn, current_id, "ADJ-RE-GROUP", "reclassification",
                      "group-level RE reclass", [
                          {"entity_id": None, "group_account_id": re_cat["group_account_id"],
                           "debit_amount": amount, "credit_amount": 0.0},
                          {"entity_id": None,
                           "group_account_id": group_coa_repo.get_by_name(conn, "Loans & Advances taken")["group_account_id"],
                           "debit_amount": 0.0, "credit_amount": amount},
                      ], user="test")
    adjustment_repo.apply_all(conn, current_id, user="test")
    conn.commit()
    consolidate_period(conn, current_id)
    conn.commit()

    after = re_check.run(conn, current_id)
    group_after = next(r for r in after.rows if r.entity_code is None).re_closing_current
    entity_after = sum(r.re_closing_current for r in after.rows if r.entity_code is not None)

    assert group_after - group_before == pytest.approx(amount, abs=1), \
        "group row must move by the group-level RE adjustment"
    assert group_after - entity_after == pytest.approx(amount, abs=1), \
        "entity rows cannot carry a group-level adjustment; the group row must add it on top"
