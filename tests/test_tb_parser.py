import pytest

from src.importers.tally_tb_parser import parse_file, extract_dr_cr
from tests.conftest import FIXTURES_DIR, ENTITY_FILES

EXPECTED_LINE_COUNTS = {"BII": 16, "KDI": 39, "KNS": 63, "VKS": 27}


@pytest.mark.parametrize("code,filename", ENTITY_FILES.items())
def test_parses_all_fixtures_without_warnings(code, filename):
    result = parse_file(str(FIXTURES_DIR / filename))
    assert result.warnings == []
    assert len(result.lines) == EXPECTED_LINE_COUNTS[code]


@pytest.mark.parametrize("code,filename", ENTITY_FILES.items())
def test_grand_total_debit_equals_credit(code, filename):
    result = parse_file(str(FIXTURES_DIR / filename))
    assert result.grand_total_period_dr == pytest.approx(result.grand_total_period_cr)
    assert result.grand_total_period_dr > 0


@pytest.mark.parametrize("code,filename", ENTITY_FILES.items())
def test_entity_tb_self_balances_on_opening_and_closing(code, filename):
    """Sum of signed (Dr positive / Cr negative) opening and closing balances across
    every ledger in a complete double-entry TB must net to zero."""
    result = parse_file(str(FIXTURES_DIR / filename))
    total_opening = sum(l.opening_dr - l.opening_cr for l in result.lines)
    total_closing = sum(l.closing_dr - l.closing_cr for l in result.lines)
    assert total_opening == pytest.approx(0, abs=1)
    assert total_closing == pytest.approx(0, abs=1)


def test_sign_can_differ_between_opening_and_closing_on_same_ledger():
    """Regression test for the real KNS 'Hutang Pajak' case: Opening tagged Cr,
    Closing tagged Dr on the same row — sign must never be inferred from the
    ledger's parent group, only read per-cell."""
    result = parse_file(str(FIXTURES_DIR / "TB KNS V3.xlsx"))
    hutang_pajak = next(l for l in result.lines if l.entity_ledger_name == "Hutang Pajak")
    assert hutang_pajak.opening_cr > 0 and hutang_pajak.opening_dr == 0
    assert hutang_pajak.closing_dr > 0 and hutang_pajak.closing_cr == 0


@pytest.mark.parametrize("fmt,expected", [
    ('""#,000" Dr"', "DR"),
    ('""0" Cr"', "CR"),
    ('""0', None),
    (None, None),
])
def test_extract_dr_cr(fmt, expected):
    assert extract_dr_cr(fmt) == expected
