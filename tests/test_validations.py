from src.engines.validation_engine import run_all


def test_all_phase1_checks_pass_on_real_data(consolidated):
    conn, period_id, _ = consolidated
    results = run_all(conn, period_id)
    # V21/V22 compare the whole year to date. This fixture is one open month, so they report
    # the eleven absent months and the unlocked period, correctly. Excluded by id rather than
    # by severity, so a regression in any other Warning check still fails here.
    failed = [r for r in results if not r.passed and r.check_id not in ("V21", "V22")]
    assert failed == [], f"Unexpected validation failures: {[(r.check_id, r.details) for r in failed]}"
    ids = {r.check_id for r in results}
    assert ids == {"V1", "V3/V12", "V9", "V5", "V8", "V6", "V7", "V2", "V14", "V18", "V19", "V20",
                   "V21", "V22"}


def test_v21_reports_months_missing_from_the_year_to_date(two_periods):
    """May and June exist; January to April do not. V21 names them and never blocks locking."""
    conn, _may_id, june_id = two_periods
    v21 = next(r for r in run_all(conn, june_id) if r.check_id == "V21")

    assert v21.severity == "Warning"
    assert v21.passed is False
    assert [d for d in v21.details if "2026-01" in d]
    assert [d for d in v21.details if "2026-04" in d]
    assert not [d for d in v21.details if "2026-05" in d or "2026-06" in d]
    # The prior year is absent in full and is not the reader's problem here.
    assert not [d for d in v21.details if "2025" in d]


def test_v21_passes_once_every_month_to_date_is_present(conn):
    """January anchors a range of one month, so a consolidated January is a complete range."""
    from src.db.repositories import consolidated_repo, group_coa_repo, period_repo

    period_id = period_repo.get_or_create(conn, 2026, 1)
    account = group_coa_repo.get_by_name(conn, "Sales")
    consolidated_repo.insert_row(conn, period_id, account["group_account_id"], None,
                                 0, 0, 0, 100, 0, 100, source_type="total")
    conn.commit()

    v21 = next(r for r in run_all(conn, period_id) if r.check_id == "V21")
    assert v21.passed is True, v21.details


def test_v22_reports_open_periods_and_clears_when_they_are_locked(two_periods):
    from src.db.repositories import period_repo

    conn, may_id, june_id = two_periods
    v22 = next(r for r in run_all(conn, june_id) if r.check_id == "V22")
    assert v22.severity == "Warning"
    assert sorted(d.split(" ")[0] for d in v22.details) == ["2026-05", "2026-06"]

    period_repo.lock(conn, may_id, user="test")
    conn.commit()
    v22 = next(r for r in run_all(conn, june_id) if r.check_id == "V22")
    assert [d.split(" ")[0] for d in v22.details] == ["2026-06"]


def test_v22_reports_a_stale_consolidation_in_range(two_periods):
    """A month whose adjustments moved since its last consolidate is showing figures a re-run
    would change, so a year-to-date column over it is provisional in the same way an open
    month is."""
    from src.db.repositories import group_coa_repo, period_repo
    from src.engines import adjustment_engine

    conn, may_id, june_id = two_periods
    period_repo.lock(conn, may_id, user="test")
    period_repo.lock(conn, june_id, user="test")
    conn.commit()
    assert next(r for r in run_all(conn, june_id) if r.check_id == "V22").passed is True

    period_repo.unlock(conn, june_id, user="test")
    rent = group_coa_repo.get_by_name(conn, "Rent Expense")
    accruals = group_coa_repo.get_by_name(conn, "Accrued Expenses")
    adjustment_engine.create_adjustment(
        conn, june_id, "ADJ-STALE-1", "accrual", "makes the consolidation stale",
        [{"group_account_id": rent["group_account_id"], "entity_id": None,
          "debit_amount": 100.0, "credit_amount": 0.0},
         {"group_account_id": accruals["group_account_id"], "entity_id": None,
          "debit_amount": 0.0, "credit_amount": 100.0}],
        user="test")
    conn.commit()

    v22 = next(r for r in run_all(conn, june_id) if r.check_id == "V22")
    assert v22.passed is False
    assert [d for d in v22.details if "2026-06" in d and "adjustments changed" in d]


def test_neither_comparative_check_can_block_locking(two_periods):
    """Both are diagnostics. Lockability is decided by Error-severity checks alone, so a
    partial or unlocked comparative range must never stand in the way of closing a period."""
    conn, _may_id, june_id = two_periods
    results = run_all(conn, june_id)

    comparative = [r for r in results if r.check_id in ("V21", "V22")]
    assert len(comparative) == 2
    assert all(r.severity == "Warning" for r in comparative)
    assert not [r for r in comparative if r.passed]
    assert not [r for r in results if r.severity == "Error" and not r.passed]
