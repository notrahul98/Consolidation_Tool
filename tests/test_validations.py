from src.engines.validation_engine import run_all


def test_all_phase1_checks_pass_on_real_data(consolidated):
    conn, period_id, _ = consolidated
    results = run_all(conn, period_id)
    failed = [r for r in results if not r.passed]
    assert failed == [], f"Unexpected validation failures: {[(r.check_id, r.details) for r in failed]}"
    ids = {r.check_id for r in results}
    assert ids == {"V1", "V3/V12", "V9", "V5", "V8", "V6", "V7", "V2", "V14", "V18"}
