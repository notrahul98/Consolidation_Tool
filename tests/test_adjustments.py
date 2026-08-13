import json

import pytest

from src.db.repositories import adjustment_repo, entity_repo, group_coa_repo, period_repo
from src.engines.adjustment_engine import create_adjustment, copy_prior_month, update_adjustment, validate
from src.engines.consolidation_engine import consolidate_period
from src.engines.validation_engine import run_all


def _sample_lines(conn, entity_code, debit_amount, credit_category, debit_category):
    entity = entity_repo.get_by_code(conn, entity_code)
    debit_cat = group_coa_repo.get_by_name(conn, debit_category)
    credit_cat = group_coa_repo.get_by_name(conn, credit_category)
    return [
        {"entity_id": entity["entity_id"], "group_account_id": debit_cat["group_account_id"],
         "debit_amount": debit_amount, "credit_amount": 0.0},
        {"entity_id": entity["entity_id"], "group_account_id": credit_cat["group_account_id"],
         "debit_amount": 0.0, "credit_amount": debit_amount},
    ]


def test_validate_rejects_unbalanced_entry():
    errors = validate("test", [
        {"debit_amount": 100, "credit_amount": 0},
        {"debit_amount": 0, "credit_amount": 50},
    ])
    assert any("does not balance" in e for e in errors)


def test_validate_rejects_single_line():
    errors = validate("test", [{"debit_amount": 100, "credit_amount": 0}])
    assert any("at least 2 lines" in e for e in errors)


def test_validate_rejects_missing_narration():
    errors = validate("", [
        {"debit_amount": 100, "credit_amount": 0},
        {"debit_amount": 0, "credit_amount": 100},
    ])
    assert any("narration" in e.lower() for e in errors)


def test_validate_rejects_line_with_both_debit_and_credit():
    errors = validate("test", [
        {"debit_amount": 100, "credit_amount": 50},
        {"debit_amount": 0, "credit_amount": 50},
    ])
    assert any("both a debit and a credit" in e for e in errors)


def test_create_adjustment_rejects_unbalanced(consolidated):
    conn, period_id, _ = consolidated
    lines = _sample_lines(conn, "KNS", 100.0, "Bank Charges", "Travel Expense - Domestic")
    lines[1]["credit_amount"] = 50.0  # unbalance it
    with pytest.raises(ValueError, match="does not balance"):
        create_adjustment(conn, period_id, "ADJ-TEST-1", "reclassification", "test", lines, user="test")


def test_reclassification_adjustment_moves_value_between_categories(consolidated):
    conn, period_id, _ = consolidated
    before_lines, _ = __import__("src.engines.statement_generator", fromlist=["compute_pl"]).compute_pl(conn, period_id)
    before = {l.label: l.value for l in before_lines}

    lines = _sample_lines(conn, "KNS", 97714092.0, "Staff Welfare", "Travel Expense - International")
    create_adjustment(conn, period_id, "ADJ-TEST-RECLASS", "reclassification",
                        "move travel cost out of staff welfare", lines, user="test")
    adjustment_repo.apply_all(conn, period_id, user="test")
    conn.commit()

    result = consolidate_period(conn, period_id)
    conn.commit()
    assert not result["blocked"]

    from src.engines.statement_generator import compute_pl
    after_lines, _ = compute_pl(conn, period_id)
    after = {l.label: l.value for l in after_lines}

    assert after["Staff Welfare"] == pytest.approx(before["Staff Welfare"] - 97714092.0)
    assert after["Travel Expense - International"] == pytest.approx(
        before["Travel Expense - International"] + 97714092.0)

    results = run_all(conn, period_id)
    failed = [r for r in results if not r.passed]
    assert failed == [], f"Unexpected validation failures: {[(r.check_id, r.details) for r in failed]}"


def test_draft_adjustment_triggers_v14_warning(consolidated):
    conn, period_id, _ = consolidated
    lines = _sample_lines(conn, "KNS", 1000.0, "Bank Charges", "Travel Expense - Domestic")
    create_adjustment(conn, period_id, "ADJ-TEST-DRAFT", "other", "left as draft on purpose", lines, user="test")
    conn.commit()

    results = run_all(conn, period_id)
    v14 = next(r for r in results if r.check_id == "V14")
    assert v14.passed is False
    assert "ADJ-TEST-DRAFT" in v14.details[0]


def test_locked_period_rejects_new_adjustments(consolidated):
    conn, period_id, _ = consolidated
    period_repo.lock(conn, period_id, user="test")
    conn.commit()
    lines = _sample_lines(conn, "KNS", 1000.0, "Bank Charges", "Travel Expense - Domestic")
    with pytest.raises(ValueError, match="locked"):
        create_adjustment(conn, period_id, "ADJ-TEST-LOCKED", "other", "should fail", lines, user="test")


def test_copy_prior_month_copies_lines_and_tags_narration(two_periods):
    conn, may_id, june_id = two_periods
    lines = _sample_lines(conn, "KNS", 500000.0, "Bank Charges", "Travel Expense - Domestic")
    create_adjustment(conn, may_id, "ADJ-MAY-001", "accrual", "a May accrual", lines, user="test")
    adjustment_repo.apply_all(conn, may_id, user="test")
    conn.commit()

    copied = copy_prior_month(conn, june_id, user="test")
    conn.commit()
    assert copied == 1

    june_adjustments = adjustment_repo.list_for_period(conn, june_id)
    assert len(june_adjustments) == 1
    copied_adj = june_adjustments[0]
    assert copied_adj["external_ref"] == "ADJ-MAY-001"
    assert copied_adj["status"] == "draft"
    assert "copied from 2026-05" in copied_adj["narration"]
    assert copied_adj["copied_from_period_id"] == may_id

    copied_lines = adjustment_repo.get_lines(conn, copied_adj["adjustment_id"])
    assert len(copied_lines) == 2
    assert sum(l["debit_amount"] for l in copied_lines) == pytest.approx(500000.0)


def test_ic_elimination_pattern_nets_to_zero_across_entities(consolidated):
    """The documented IC-elimination pattern (README "Recurring adjustment patterns"):
    same category, opposite entities, opposite sides — nets to zero in Conso_TB_Total's
    Interco Balances line while each entity's own column still carries the adjustment."""
    conn, period_id, _ = consolidated
    kdi = entity_repo.get_by_code(conn, "KDI")
    bii = entity_repo.get_by_code(conn, "BII")
    interco = group_coa_repo.get_by_name(conn, "Interco Balances")

    before_total = conn.execute(
        """SELECT SUM(closing_dr) - SUM(closing_cr) AS net FROM consolidated_tb
           WHERE period_id = ? AND source_type = 'total' AND group_account_id = ?""",
        (period_id, interco["group_account_id"]),
    ).fetchone()["net"] or 0.0

    lines = [
        {"entity_id": kdi["entity_id"], "group_account_id": interco["group_account_id"],
         "debit_amount": 18084500.0, "credit_amount": 0.0},
        {"entity_id": bii["entity_id"], "group_account_id": interco["group_account_id"],
         "debit_amount": 0.0, "credit_amount": 18084500.0},
    ]
    create_adjustment(conn, period_id, "ADJ-TEST-IC-01", "ic_elimination",
                        "eliminate KDI/BII interco balance", lines, user="test")
    adjustment_repo.apply_all(conn, period_id, user="test")
    conn.commit()

    result = consolidate_period(conn, period_id)
    conn.commit()
    assert not result["blocked"]

    after_total = conn.execute(
        """SELECT SUM(closing_dr) - SUM(closing_cr) AS net FROM consolidated_tb
           WHERE period_id = ? AND source_type = 'total' AND group_account_id = ?""",
        (period_id, interco["group_account_id"]),
    ).fetchone()["net"] or 0.0
    # the two lines are equal and opposite, so the Total column is unchanged...
    assert after_total == pytest.approx(before_total)

    # ...but each entity's own column moved individually.
    kdi_impact = conn.execute(
        """SELECT closing_dr - closing_cr AS net FROM consolidated_tb
           WHERE period_id = ? AND source_type = 'adjustment' AND group_account_id = ? AND entity_id = ?""",
        (period_id, interco["group_account_id"], kdi["entity_id"]),
    ).fetchone()["net"]
    bii_impact = conn.execute(
        """SELECT closing_dr - closing_cr AS net FROM consolidated_tb
           WHERE period_id = ? AND source_type = 'adjustment' AND group_account_id = ? AND entity_id = ?""",
        (period_id, interco["group_account_id"], bii["entity_id"]),
    ).fetchone()["net"]
    assert kdi_impact == pytest.approx(18084500.0)
    assert bii_impact == pytest.approx(-18084500.0)

    results = run_all(conn, period_id)
    failed = [r for r in results if not r.passed]
    assert failed == [], f"Unexpected validation failures: {[(r.check_id, r.details) for r in failed]}"


def test_copy_prior_month_fails_with_no_prior_period(conn):
    from tests.conftest import import_all_entities, categorize_all
    period_id = import_all_entities(conn)
    categorize_all(conn)
    conn.commit()
    with pytest.raises(ValueError, match="No prior period"):
        copy_prior_month(conn, period_id, user="test")


# Workstream D — editing an already-applied adjustment

def test_update_applied_adjustment_resets_to_draft(consolidated):
    conn, period_id, _ = consolidated
    lines = _sample_lines(conn, "KNS", 1000.0, "Bank Charges", "Travel Expense - Domestic")
    create_adjustment(conn, period_id, "ADJ-TEST-EDIT", "other", "original narration", lines, user="test")
    adjustment_repo.apply_all(conn, period_id, user="test")
    conn.commit()

    adj = conn.execute(
        "SELECT * FROM adjustments WHERE period_id = ? AND external_ref = ?", (period_id, "ADJ-TEST-EDIT")
    ).fetchone()
    assert adj["status"] == "applied"

    new_lines = _sample_lines(conn, "KNS", 2000.0, "Bank Charges", "Travel Expense - Domestic")
    update_adjustment(conn, period_id, adj["adjustment_id"], "other", "edited narration", new_lines, user="test")
    conn.commit()

    updated = conn.execute(
        "SELECT * FROM adjustments WHERE adjustment_id = ?", (adj["adjustment_id"],)
    ).fetchone()
    assert updated["status"] == "draft"
    assert updated["narration"] == "edited narration"

    updated_lines = adjustment_repo.get_lines(conn, adj["adjustment_id"])
    assert sum(l["debit_amount"] for l in updated_lines) == pytest.approx(2000.0)


def test_update_writes_before_and_after_to_audit_log(consolidated):
    conn, period_id, _ = consolidated
    lines = _sample_lines(conn, "KNS", 1000.0, "Bank Charges", "Travel Expense - Domestic")
    create_adjustment(conn, period_id, "ADJ-TEST-AUDIT", "other", "before edit", lines, user="test")
    conn.commit()

    adj = conn.execute(
        "SELECT * FROM adjustments WHERE period_id = ? AND external_ref = ?", (period_id, "ADJ-TEST-AUDIT")
    ).fetchone()

    new_lines = _sample_lines(conn, "KNS", 3000.0, "Bank Charges", "Travel Expense - Domestic")
    update_adjustment(conn, period_id, adj["adjustment_id"], "other", "after edit", new_lines, user="test")
    conn.commit()

    audit_rows = conn.execute(
        "SELECT * FROM audit_log WHERE table_name = 'adjustments' AND record_id = ? AND action = 'edit'",
        (str(adj["adjustment_id"]),),
    ).fetchall()
    assert len(audit_rows) == 1
    before = json.loads(audit_rows[0]["old_value"])
    after = json.loads(audit_rows[0]["new_value"])

    assert before["narration"] == "before edit"
    assert after["narration"] == "after edit"
    assert before["lines"][0]["debit"] == pytest.approx(1000.0) or before["lines"][1]["debit"] == pytest.approx(1000.0)
    assert any(l["debit"] == pytest.approx(3000.0) for l in after["lines"])
    assert before["external_ref"] == "ADJ-TEST-AUDIT"
    assert after["external_ref"] == "ADJ-TEST-AUDIT"


def test_update_rejects_unbalanced_lines(consolidated):
    conn, period_id, _ = consolidated
    lines = _sample_lines(conn, "KNS", 1000.0, "Bank Charges", "Travel Expense - Domestic")
    create_adjustment(conn, period_id, "ADJ-TEST-BAL", "other", "narration", lines, user="test")
    conn.commit()

    adj = conn.execute(
        "SELECT * FROM adjustments WHERE period_id = ? AND external_ref = ?", (period_id, "ADJ-TEST-BAL")
    ).fetchone()

    bad_lines = _sample_lines(conn, "KNS", 1000.0, "Bank Charges", "Travel Expense - Domestic")
    bad_lines[1]["credit_amount"] = 500.0  # unbalance it
    with pytest.raises(ValueError, match="does not balance"):
        update_adjustment(conn, period_id, adj["adjustment_id"], "other", "narration", bad_lines, user="test")

    # Original lines untouched
    unchanged = adjustment_repo.get_lines(conn, adj["adjustment_id"])
    assert sum(l["debit_amount"] for l in unchanged) == pytest.approx(1000.0)


def test_update_blocked_on_locked_period(consolidated):
    conn, period_id, _ = consolidated
    lines = _sample_lines(conn, "KNS", 1000.0, "Bank Charges", "Travel Expense - Domestic")
    create_adjustment(conn, period_id, "ADJ-TEST-LOCK", "other", "narration", lines, user="test")
    conn.commit()

    adj = conn.execute(
        "SELECT * FROM adjustments WHERE period_id = ? AND external_ref = ?", (period_id, "ADJ-TEST-LOCK")
    ).fetchone()

    period_repo.lock(conn, period_id, user="test")
    conn.commit()

    new_lines = _sample_lines(conn, "KNS", 2000.0, "Bank Charges", "Travel Expense - Domestic")
    with pytest.raises(ValueError, match="locked"):
        update_adjustment(conn, period_id, adj["adjustment_id"], "other", "narration", new_lines, user="test")


def test_update_cannot_change_external_ref(consolidated):
    """update_adjustment always reads external_ref from the existing row — it doesn't
    accept one as a parameter — so it's structurally impossible to rename via this path."""
    conn, period_id, _ = consolidated
    lines = _sample_lines(conn, "KNS", 1000.0, "Bank Charges", "Travel Expense - Domestic")
    create_adjustment(conn, period_id, "ADJ-TEST-REF", "other", "narration", lines, user="test")
    conn.commit()

    adj = conn.execute(
        "SELECT * FROM adjustments WHERE period_id = ? AND external_ref = ?", (period_id, "ADJ-TEST-REF")
    ).fetchone()

    new_lines = _sample_lines(conn, "KNS", 2000.0, "Bank Charges", "Travel Expense - Domestic")
    update_adjustment(conn, period_id, adj["adjustment_id"], "other", "narration", new_lines, user="test")
    conn.commit()

    updated = conn.execute(
        "SELECT * FROM adjustments WHERE adjustment_id = ?", (adj["adjustment_id"],)
    ).fetchone()
    assert updated["external_ref"] == "ADJ-TEST-REF"


def test_edited_adjustment_changes_consolidated_tb_after_reapply_and_reconsolidate(consolidated):
    conn, period_id, _ = consolidated
    lines = _sample_lines(conn, "KNS", 100000.0, "Bank Charges", "Travel Expense - Domestic")
    create_adjustment(conn, period_id, "ADJ-TEST-E2E", "reclassification", "original", lines, user="test")
    adjustment_repo.apply_all(conn, period_id, user="test")
    conn.commit()
    consolidate_period(conn, period_id)
    conn.commit()

    adj = conn.execute(
        "SELECT * FROM adjustments WHERE period_id = ? AND external_ref = ?", (period_id, "ADJ-TEST-E2E")
    ).fetchone()
    bank_charges = group_coa_repo.get_by_name(conn, "Bank Charges")
    before_amount = conn.execute(
        """SELECT SUM(closing_dr) - SUM(closing_cr) AS net FROM consolidated_tb
           WHERE period_id = ? AND source_type = 'total' AND group_account_id = ?""",
        (period_id, bank_charges["group_account_id"]),
    ).fetchone()["net"]

    # Edit to a different amount
    new_lines = _sample_lines(conn, "KNS", 250000.0, "Bank Charges", "Travel Expense - Domestic")
    update_adjustment(conn, period_id, adj["adjustment_id"], "reclassification", "edited", new_lines, user="test")
    conn.commit()

    # Re-apply and re-consolidate
    adjustment_repo.apply_all(conn, period_id, user="test")
    conn.commit()
    consolidate_period(conn, period_id)
    conn.commit()

    after_amount = conn.execute(
        """SELECT SUM(closing_dr) - SUM(closing_cr) AS net FROM consolidated_tb
           WHERE period_id = ? AND source_type = 'total' AND group_account_id = ?""",
        (period_id, bank_charges["group_account_id"]),
    ).fetchone()["net"]

    # Bank Charges is credited in both the original and edited adjustment (it's the
    # credit_category argument to _sample_lines), so a larger credit further reduces
    # the raw (closing_dr - closing_cr) total by the increase in amount.
    assert after_amount == pytest.approx(before_amount - (250000.0 - 100000.0))


def test_is_consolidation_stale_after_edit(consolidated):
    conn, period_id, _ = consolidated
    lines = _sample_lines(conn, "KNS", 1000.0, "Bank Charges", "Travel Expense - Domestic")
    create_adjustment(conn, period_id, "ADJ-TEST-STALE", "other", "narration", lines, user="test")
    adjustment_repo.apply_all(conn, period_id, user="test")
    conn.commit()

    consolidate_period(conn, period_id)
    conn.commit()
    assert period_repo.is_consolidation_stale(conn, period_id) is False

    adj = conn.execute(
        "SELECT * FROM adjustments WHERE period_id = ? AND external_ref = ?", (period_id, "ADJ-TEST-STALE")
    ).fetchone()
    new_lines = _sample_lines(conn, "KNS", 2000.0, "Bank Charges", "Travel Expense - Domestic")
    update_adjustment(conn, period_id, adj["adjustment_id"], "other", "narration", new_lines, user="test")
    conn.commit()

    assert period_repo.is_consolidation_stale(conn, period_id) is True


def test_is_consolidation_stale_false_after_reconsolidate(consolidated):
    conn, period_id, _ = consolidated
    lines = _sample_lines(conn, "KNS", 1000.0, "Bank Charges", "Travel Expense - Domestic")
    create_adjustment(conn, period_id, "ADJ-TEST-STALE2", "other", "narration", lines, user="test")
    adjustment_repo.apply_all(conn, period_id, user="test")
    conn.commit()
    consolidate_period(conn, period_id)
    conn.commit()

    adj = conn.execute(
        "SELECT * FROM adjustments WHERE period_id = ? AND external_ref = ?", (period_id, "ADJ-TEST-STALE2")
    ).fetchone()
    new_lines = _sample_lines(conn, "KNS", 2000.0, "Bank Charges", "Travel Expense - Domestic")
    update_adjustment(conn, period_id, adj["adjustment_id"], "other", "narration", new_lines, user="test")
    conn.commit()
    assert period_repo.is_consolidation_stale(conn, period_id) is True

    adjustment_repo.apply_all(conn, period_id, user="test")
    conn.commit()
    consolidate_period(conn, period_id)
    conn.commit()
    assert period_repo.is_consolidation_stale(conn, period_id) is False


def test_edit_form_renders_prefilled(consolidated):
    from fastapi.testclient import TestClient
    from src.web.app import app
    from src.web.deps import get_db

    conn, period_id, _ = consolidated
    lines = _sample_lines(conn, "KNS", 1000.0, "Bank Charges", "Travel Expense - Domestic")
    create_adjustment(conn, period_id, "ADJ-TEST-FORM", "other", "prefill me", lines, user="test")
    conn.commit()

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
        resp = client.get("/periods/2026-06/adjustments/ADJ-TEST-FORM/edit")
        assert resp.status_code == 200
        assert "prefill me" in resp.text
        assert "ADJ-TEST-FORM" in resp.text
        assert 'readonly' in resp.text
    finally:
        app.dependency_overrides.clear()
