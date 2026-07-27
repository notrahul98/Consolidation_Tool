"""A locked period must actually be immutable everywhere, not just for creating new
adjustments. This was a real, empirically-confirmed gap (see the RCA in project history):
tb_repo.import_tb, mapping changes via the web route, consolidation_engine.consolidate_period,
adjustment_repo.apply_all, and adjustment_repo.delete all had zero lock enforcement. Each is
covered here so it can't silently regress."""

import pytest
from fastapi.testclient import TestClient

from src.db.repositories import adjustment_repo, entity_repo, group_coa_repo, period_repo, tb_repo
from src.engines.adjustment_engine import copy_prior_month, create_adjustment
from src.engines.consolidation_engine import consolidate_period
from src.importers.tally_tb_parser import parse_file
from src.web.app import app
from src.web.deps import get_db
from tests.conftest import FIXTURES_DIR, categorize_all


def _client(conn):
    db_path = conn.execute("PRAGMA database_list").fetchone()["file"]

    def override_get_db():
        from src.db.database import connect
        c = connect(db_path)
        try:
            yield c
        finally:
            c.close()

    app.dependency_overrides[get_db] = override_get_db
    return TestClient(app)


def test_import_tb_rejects_locked_period(consolidated):
    conn, period_id, _ = consolidated
    period_repo.lock(conn, period_id, user="test")
    conn.commit()

    entity = entity_repo.get_by_code(conn, "BII")
    parsed = parse_file(str(FIXTURES_DIR / "TB BII Jun 26.xlsx"))
    with pytest.raises(ValueError, match="locked"):
        tb_repo.import_tb(conn, period_id, entity["entity_id"], parsed, imported_by="test")


def test_consolidate_period_rejects_locked_period(consolidated):
    conn, period_id, _ = consolidated
    period_repo.lock(conn, period_id, user="test")
    conn.commit()

    result = consolidate_period(conn, period_id)
    assert result["blocked"] is True
    assert result["reason"] == "locked"


def test_apply_all_rejects_locked_period(consolidated):
    conn, period_id, _ = consolidated
    entity = entity_repo.get_by_code(conn, "KNS")
    cat1 = group_coa_repo.get_by_name(conn, "Bank Charges")
    cat2 = group_coa_repo.get_by_name(conn, "Misc. Expense")
    lines = [
        {"entity_id": entity["entity_id"], "group_account_id": cat1["group_account_id"],
         "debit_amount": 10.0, "credit_amount": 0.0},
        {"entity_id": entity["entity_id"], "group_account_id": cat2["group_account_id"],
         "debit_amount": 0.0, "credit_amount": 10.0},
    ]
    create_adjustment(conn, period_id, "ADJ-LOCK-TEST", "other", "test", lines, user="test")
    conn.commit()

    period_repo.lock(conn, period_id, user="test")
    conn.commit()

    with pytest.raises(ValueError, match="locked"):
        adjustment_repo.apply_all(conn, period_id, user="test")


def test_delete_rejects_locked_period(consolidated):
    conn, period_id, _ = consolidated
    entity = entity_repo.get_by_code(conn, "KNS")
    cat1 = group_coa_repo.get_by_name(conn, "Bank Charges")
    cat2 = group_coa_repo.get_by_name(conn, "Misc. Expense")
    lines = [
        {"entity_id": entity["entity_id"], "group_account_id": cat1["group_account_id"],
         "debit_amount": 10.0, "credit_amount": 0.0},
        {"entity_id": entity["entity_id"], "group_account_id": cat2["group_account_id"],
         "debit_amount": 0.0, "credit_amount": 10.0},
    ]
    adjustment_id = create_adjustment(conn, period_id, "ADJ-LOCK-TEST-2", "other", "test", lines, user="test")
    conn.commit()

    period_repo.lock(conn, period_id, user="test")
    conn.commit()

    with pytest.raises(ValueError, match="locked"):
        adjustment_repo.delete(conn, period_id, adjustment_id, user="test")

    # confirm it's still there, untouched
    assert adjustment_repo.list_for_period(conn, period_id)


def test_copy_prior_month_rejects_locked_target_period(two_periods):
    conn, may_id, june_id = two_periods
    period_repo.lock(conn, june_id, user="test")
    conn.commit()
    with pytest.raises(ValueError, match="locked"):
        copy_prior_month(conn, june_id, user="test")


def test_mapping_route_rejects_locked_period(consolidated):
    conn, period_id, _ = consolidated
    period_repo.lock(conn, period_id, user="test")
    conn.commit()

    client = _client(conn)
    try:
        resp = client.post("/periods/2026-06/mapping", data={
            "ledger_name": ["Sales"], "category": ["Sales"],
        }, follow_redirects=False)
        assert resp.status_code == 303
        assert "locked" in resp.headers["location"]
    finally:
        app.dependency_overrides.clear()
