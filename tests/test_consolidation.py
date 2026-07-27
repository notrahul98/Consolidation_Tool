import pytest

from src.engines.consolidation_engine import consolidate_period
from src.db.repositories import consolidated_repo
from tests.conftest import import_all_entities, categorize_all


def test_consolidate_blocks_when_material_ledgers_uncategorized(conn):
    period_id = import_all_entities(conn)
    result = consolidate_period(conn, period_id)
    assert result["blocked"] is True
    assert len(result["unmapped_material"]) > 0
    # nothing should have been written
    assert consolidated_repo.get_matrix(conn, period_id) == []


def test_consolidate_succeeds_once_fully_categorized(consolidated):
    conn, period_id, result = consolidated
    assert result["blocked"] is False
    assert result["rows_written"] > 0


def test_entity_columns_sum_to_total_column(consolidated):
    conn, period_id, _ = consolidated
    rows = consolidated_repo.get_matrix(conn, period_id)
    by_account = {}
    for r in rows:
        key = r["group_account_id"]
        entry = by_account.setdefault(key, {"entity_sum": 0.0, "total": None})
        signed = (r["closing_dr"] or 0) - (r["closing_cr"] or 0)
        if r["source_type"] == "entity_tb":
            entry["entity_sum"] += signed
        else:
            entry["total"] = signed

    for key, entry in by_account.items():
        assert entry["total"] is not None
        assert entry["entity_sum"] == pytest.approx(entry["total"], abs=1)


def test_consolidated_total_balances_dr_eq_cr(consolidated):
    conn, period_id, _ = consolidated
    rows = consolidated_repo.get_matrix(conn, period_id)
    total_dr = sum(r["closing_dr"] or 0 for r in rows if r["source_type"] == "total")
    total_cr = sum(r["closing_cr"] or 0 for r in rows if r["source_type"] == "total")
    assert total_dr == pytest.approx(total_cr, abs=1)
