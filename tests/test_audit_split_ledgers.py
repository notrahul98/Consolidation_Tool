"""Unit tests for the split-ledger sweep's classification logic.

The distinction that matters is 'flattened' vs 'split': both have a ledger whose Tally
primary group differs across entities, but flattened means every entity now shares ONE
category, which is the fingerprint of a whole-ledger save having overwritten a real
per-entity split.
"""

import importlib.util
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "audit_split_ledgers", Path(__file__).parent.parent / "scripts" / "audit_split_ledgers.py")
audit = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(audit)


def entry(entity, group, category, statement_type=None, balance=0.0):
    return {"entity": entity, "group": group, "category": category,
            "statement_type": statement_type, "balance": balance}


def test_flattened_when_groups_differ_but_one_shared_category():
    # The real case: an expense in VKS and a liability in KDI, collapsed onto the liability.
    entries = [
        entry("KDI", "Current Liabilities", "Loans & Advances taken"),
        entry("VKS", "Indirect Expenses", "Loans & Advances taken"),
    ]
    assert audit.classify(entries) == "flattened"


def test_split_when_groups_and_categories_both_differ():
    entries = [
        entry("KDI", "Current Liabilities", "Loans & Advances taken"),
        entry("VKS", "Indirect Expenses", "Interest on  Shareholder loan"),
    ]
    assert audit.classify(entries) == "split"


def test_uncategorized_is_not_flattened():
    """A fresh import has no categories yet. Reporting every such ledger as a collapse
    would bury the real findings."""
    entries = [
        entry("KDI", "Current Liabilities", None),
        entry("VKS", "Indirect Expenses", None),
    ]
    assert audit.classify(entries) is None


def test_inconsistent_when_same_group_different_categories():
    entries = [
        entry("KDI", "Current Liabilities", "Other Payables"),
        entry("VKS", "Current Liabilities", "Loans & Advances taken"),
    ]
    assert audit.classify(entries) == "inconsistent"


def test_half_mapped_split_is_not_called_flattened():
    """One entity categorized, the other not, is incomplete work rather than a collapse.
    Validation V3/V12 already blocks consolidation on material unmapped ledgers."""
    entries = [
        entry("KDI", "Current Liabilities", "Loans & Advances taken"),
        entry("VKS", "Indirect Expenses", None),
    ]
    assert audit.classify(entries) is None


def test_consistent_single_entity_ledger_is_not_reported():
    assert audit.classify([entry("KNS", "Indirect Expenses", "Salaries & Wages")]) is None


def test_consistent_multi_entity_ledger_is_not_reported():
    entries = [
        entry("KDI", "Current Assets", "Cash & Cash Equivalent"),
        entry("KNS", "Current Assets", "Cash & Cash Equivalent"),
    ]
    assert audit.classify(entries) is None


def test_blank_primary_group_does_not_manufacture_a_split():
    """Tally leaves the group blank on some rows; an empty string must not count as a
    second distinct group."""
    entries = [
        entry("KDI", "", "Accounts Payable"),
        entry("VKS", "Current Liabilities", "Accounts Payable"),
    ]
    assert audit.classify(entries) is None


def test_statement_mismatch_flags_pl_group_mapped_to_bs_category():
    entries = [entry("VKS", "Indirect Expenses", "Loans & Advances taken", "BS", 272_263_373)]
    assert [m["entity"] for m in audit.statement_mismatches(entries)] == ["VKS"]


def test_statement_mismatch_ignores_agreeing_rows():
    entries = [entry("VKS", "Indirect Expenses", "Interest on  Shareholder loan", "PL")]
    assert audit.statement_mismatches(entries) == []


def test_statement_mismatch_ignores_unknown_group():
    entries = [entry("VKS", "Suspense A/c", "Other Receivables", "BS")]
    assert audit.statement_mismatches(entries) == []


def test_statement_mismatch_ignores_uncategorized():
    entries = [entry("VKS", "Indirect Expenses", None, None)]
    assert audit.statement_mismatches(entries) == []


@pytest.mark.parametrize("value,expected", [(0, "0"), (1234567, "1,234,567"), (-1234567, "(1,234,567)")])
def test_idr_formatting(value, expected):
    assert audit.idr(value) == expected


def test_sweep_detects_the_flattened_interest_ledger_end_to_end(consolidated, tmp_path, capsys,
                                                                monkeypatch):
    """End-to-end on the real fixtures. conftest's FULL_MAPPING deliberately maps by ledger
    name across all entities — exactly the whole-ledger behaviour this sweep hunts for — so
    the interest ledger must surface as FLATTENED, and --strict must exit non-zero."""
    import sqlite3

    conn, _, _ = consolidated
    db_path = tmp_path / "sweep.db"
    dest = sqlite3.connect(str(db_path))
    conn.backup(dest)
    dest.close()

    monkeypatch.setattr("sys.argv", ["audit_split_ledgers.py", "--db", str(db_path), "--strict"])
    with pytest.raises(SystemExit) as exit_info:
        audit.main()
    assert exit_info.value.code == 1

    out = capsys.readouterr().out
    flattened_section = out.split("[1] FLATTENED")[1].split("[2] SPLIT")[0]
    assert "12% Interest on Shareholders Loan A/c" in flattened_section
    assert "Current Liabilities" in flattened_section and "Indirect Expenses" in flattened_section
