"""Regression tests for the Excel pack's comparative sheets.

Same approach as test_excel_pack.py, which these reuse the evaluator from: the workbook ships
live formulas with no cached values, so the only way to know what Excel will show is to
evaluate the chain here and diff it against the engine that drives the screens.

What makes these different from the single-period tests is the number of ways a column can be
wrong: pointing at the wrong month, summing the wrong range into a year-to-date figure,
rendering an unloaded month as zero, or dividing a percentage by another column's Net Sales.
Each of those is asked separately below.
"""

import pytest
from openpyxl.utils import column_index_from_string, get_column_letter

from src.engines import comparative_engine
from src.engines.statement_generator import compute_bs, compute_pl
from tests.conftest import ENTITY_FILES, FIXTURES_DIR, categorize_all
from tests.test_excel_pack import TOLERANCE, _account, _book, _export

MONTH_ABBR = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

ANCHOR_MONTH = 8
# September 2026 is loaded on purpose while the pack is exported for August. That is the real
# situation the month after a close — the next month's TBs are already in — and it is the only
# way a year-to-date column that sums too far shows up as a wrong number rather than the same
# number. Without it, summing through December is indistinguishable from stopping at August.
CURRENT_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9]
YTD_CURRENT_MONTHS = [m for m in CURRENT_MONTHS if m <= ANCHOR_MONTH]
PRIOR_MONTHS = [5, 6, 7, 8]
YTD_PRIOR_MONTHS = [m for m in PRIOR_MONTHS if m <= ANCHOR_MONTH]


def _label(year, month):
    return f"{MONTH_ABBR[month]}'{str(year)[2:]}"


def _column_values(wb, sheet, col_letter, first_row):
    """{row label: evaluated value} for one column of a comparative sheet."""
    ws = wb.wb[sheet]
    out = {}
    for r in range(first_row, ws.max_row + 1):
        label = ws.cell(r, 1).value
        raw = ws.cell(r, column_index_from_string(col_letter)).value
        if label is None or raw is None:
            continue
        out[str(label).strip()] = wb.cell(sheet, col_letter, r)
    return out


def _header_columns(wb, sheet, header_row=1):
    """{column heading: column letter}."""
    ws = wb.wb[sheet]
    out = {}
    for c in range(2, ws.max_column + 1):
        heading = ws.cell(header_row, c).value
        if heading:
            out[str(heading)] = get_column_letter(c)
    return out


def _row_labels(wb, sheet, first_row):
    ws = wb.wb[sheet]
    return [str(ws.cell(r, 1).value).strip() for r in range(first_row, ws.max_row + 1)
            if ws.cell(r, 1).value is not None]


@pytest.fixture
def multi_period(conn):
    """Jan-Aug 2026 and May-Aug 2025: a real year-to-date range, a partly-present prior year,
    and months that are genuinely absent.

    The TB fixtures are parsed once and imported into every period — reparsing them sixteen
    times is slow and proves nothing extra. Each month then gets a group-level adjustment of a
    different size, so no two columns hold identical numbers and a column mix-up cannot pass
    unnoticed.
    """
    from src.db.repositories import entity_repo, mapping_repo, period_repo, tb_repo
    from src.importers.tally_tb_parser import parse_file

    parsed_by_code = {
        code: parse_file(str(FIXTURES_DIR / filename)) for code, filename in ENTITY_FILES.items()
    }

    period_ids = {}
    for year, months in ((2026, CURRENT_MONTHS), (2025, PRIOR_MONTHS)):
        for month in months:
            period_id = period_repo.get_or_create(conn, year, month)
            for code, parsed in parsed_by_code.items():
                entity = entity_repo.get_by_code(conn, code)
                tb_repo.import_tb(conn, period_id, entity["entity_id"], parsed, imported_by="test")
            mapping_repo.ensure_rows_exist(conn, period_id)
            period_ids[(year, month)] = period_id
    conn.commit()
    categorize_all(conn)

    for (year, month), period_id in period_ids.items():
        amount = float((year - 2000) * 1_000_000 + month * 10_000)
        _book(conn, period_id, f"ADJ-{year}-{month:02d}", [
            {"entity_id": None, "group_account_id": _account(conn, "Rent Expense"),
             "debit_amount": amount, "credit_amount": 0.0},
            {"entity_id": None, "group_account_id": _account(conn, "Accrued Expenses"),
             "debit_amount": 0.0, "credit_amount": amount},
        ])

    return conn, period_ids


@pytest.fixture
def pack(multi_period, tmp_path):
    conn, period_ids = multi_period
    anchor = period_ids[(2026, ANCHOR_MONTH)]
    return conn, period_ids, anchor, _export(conn, anchor, tmp_path, "comparative.xlsx")


# --------------------------------------------------------------------------- structure

def test_comparative_sheets_are_present(pack):
    _conn, _ids, _anchor, wb = pack
    for sheet in ("Conso_TB_By_Period", "PL_Comparative", "BS_Comparative"):
        assert sheet in wb.wb.sheetnames


def test_comparative_rows_mirror_the_single_period_sheets(pack):
    """Both are rendered from one layout. If they ever diverge, someone comparing the two
    sheets is reading two different statements without being told."""
    _conn, _ids, _anchor, wb = pack
    assert _row_labels(wb, "PL_Current", 2) == _row_labels(wb, "PL_Comparative", 3)
    assert _row_labels(wb, "BS_Current", 2) == _row_labels(wb, "BS_Comparative", 2)


def test_bs_comparative_has_no_ytd_columns(pack):
    """A balance sheet is a point in time; summing one across months is meaningless."""
    _conn, _ids, _anchor, wb = pack
    assert not [h for h in _header_columns(wb, "BS_Comparative") if h.startswith("YTD")]


def test_anchor_month_column_references_conso_tb_total(pack):
    """The anchor month exists in both the single-period chain and the comparative one. It is
    a reference, not a second copy of the number, so the two cannot drift apart."""
    _conn, _ids, _anchor, wb = pack
    ws = wb.wb["Conso_TB_By_Period"]
    anchor_col = _header_columns(wb, "Conso_TB_By_Period")["Aug'26"]

    checked = 0
    for row in range(2, ws.max_row + 1):
        code = ws.cell(row, 1).value
        if code is None:
            continue
        raw = ws[f"{anchor_col}{row}"].value
        assert isinstance(raw, str) and raw.startswith("='Conso_TB_Total'!"), (code, raw)
        assert wb.cell("Conso_TB_By_Period", anchor_col, row) == pytest.approx(
            wb.cell("Conso_TB_Total", "E", wb.row_of("Conso_TB_Total", code)), abs=TOLERANCE), code
        checked += 1
    assert checked > 50, "expected every leaf category to be covered"


# --------------------------------------------------------------------------- the numbers

def test_every_pl_month_column_matches_the_engine(pack):
    """Evaluates the full formula chain for each month column and diffs it against compute_pl
    for that period — the check the single-period sheet gets, twelve times over."""
    conn, period_ids, _anchor, wb = pack
    columns = _header_columns(wb, "PL_Comparative")

    for (year, month), period_id in period_ids.items():
        excel = _column_values(wb, "PL_Comparative", columns[_label(year, month)], 3)
        tool = {l.label: l.value for l in compute_pl(conn, period_id)[0] if l.value is not None}
        bad = [(k, excel[k], tool[k]) for k in tool if k in excel and abs(excel[k] - tool[k]) > TOLERANCE]
        assert not bad, f"{_label(year, month)}: {bad[:5]}"


def test_every_bs_month_column_matches_the_engine(pack):
    conn, period_ids, _anchor, wb = pack
    columns = _header_columns(wb, "BS_Comparative")

    for (year, month), period_id in period_ids.items():
        excel = _column_values(wb, "BS_Comparative", columns[_label(year, month)], 2)
        tool = {l.label: l.value for l in compute_bs(conn, period_id)[0] if l.value is not None}
        bad = [(k, excel[k], tool[k]) for k in tool if k in excel and abs(excel[k] - tool[k]) > TOLERANCE]
        assert not bad, f"{_label(year, month)}: {bad[:5]}"


def test_ytd_columns_match_the_comparative_engine(pack):
    conn, _ids, anchor, wb = pack
    result = comparative_engine.compute_pl_comparative(conn, anchor)
    columns = _header_columns(wb, "PL_Comparative")

    for heading, key in (("YTD Aug'26", comparative_engine.YTD_CURRENT),
                         ("YTD Aug'25", comparative_engine.YTD_PRIOR)):
        excel = _column_values(wb, "PL_Comparative", columns[heading], 3)
        bad = [
            (label, value, result.value(key, label))
            for label, value in excel.items()
            if result.value(key, label) is not None and abs(value - result.value(key, label)) > TOLERANCE
        ]
        assert not bad, f"{heading}: {bad[:5]}"


def test_ytd_column_is_the_sum_of_the_months_it_spans(pack):
    """The YTD cell is a live SUM over a month range, so it must equal those months added up —
    including in the prior year, where only four of the eight months exist."""
    _conn, _ids, _anchor, wb = pack
    columns = _header_columns(wb, "PL_Comparative")

    for year, months, heading in ((2026, YTD_CURRENT_MONTHS, "YTD Aug'26"),
                                  (2025, YTD_PRIOR_MONTHS, "YTD Aug'25")):
        ytd = _column_values(wb, "PL_Comparative", columns[heading], 3)
        summed = {}
        for month in months:
            for label, value in _column_values(wb, "PL_Comparative", columns[_label(year, month)], 3).items():
                summed[label] = summed.get(label, 0.0) + value
        bad = [(k, ytd[k], summed[k]) for k in ytd if k in summed and abs(ytd[k] - summed[k]) > TOLERANCE]
        assert not bad, f"{heading}: {bad[:5]}"


def test_ytd_stops_at_the_anchor_month(pack):
    """September 2026 is loaded, but this pack was exported for August. A year-to-date column
    that keeps summing past the anchor is the easiest mistake to make here and the hardest to
    spot, because every column still looks plausible."""
    _conn, _ids, _anchor, wb = pack
    columns = _header_columns(wb, "PL_Comparative")
    ytd = _column_values(wb, "PL_Comparative", columns["YTD Aug'26"], 3)
    september = _column_values(wb, "PL_Comparative", columns["Sep'26"], 3)

    assert september["Net Sales"] != 0, "the fixture must have data after the anchor to test this"

    through_august = 0.0
    for month in YTD_CURRENT_MONTHS:
        through_august += _column_values(wb, "PL_Comparative", columns[_label(2026, month)], 3)["Net Sales"]
    assert ytd["Net Sales"] == pytest.approx(through_august, abs=TOLERANCE)
    assert ytd["Net Sales"] != pytest.approx(through_august + september["Net Sales"], abs=TOLERANCE)


def test_group_level_adjustment_reaches_the_comparative_columns(pack):
    """The original bug re-asked of the new sheets. A group-level adjustment belongs to no
    entity, so it is the thing most likely to be dropped by a new aggregation path — and a
    balanced one hides, because every total still ties without it."""
    conn, period_ids, _anchor, wb = pack
    columns = _header_columns(wb, "PL_Comparative")

    for year, month in ((2026, 3), (2026, 8), (2025, 6)):
        booked = float((year - 2000) * 1_000_000 + month * 10_000)
        excel = _column_values(wb, "PL_Comparative", columns[_label(year, month)], 3)
        tool = {l.label: l.value for l in compute_pl(conn, period_ids[(year, month)])[0]}
        assert excel["Rent Expense"] == pytest.approx(tool["Rent Expense"], abs=TOLERANCE)
        assert excel["Rent Expense"] >= booked, "the adjustment is missing from this column"


# --------------------------------------------------------------------------- blanks and %

def test_months_with_no_data_are_blank_rather_than_zero(pack):
    """Jan-Apr 2025 and Oct-Dec 2026 were never loaded. Their columns must be empty: a zero
    reads as a month in which nothing happened."""
    _conn, _ids, _anchor, wb = pack
    for sheet, first_row in (("PL_Comparative", 3), ("BS_Comparative", 2)):
        columns = _header_columns(wb, sheet)
        ws = wb.wb[sheet]
        for heading in ("Jan'25", "Apr'25", "Oct'26", "Dec'26"):
            col = column_index_from_string(columns[heading])
            values = [ws.cell(r, col).value for r in range(first_row, ws.max_row + 1)]
            assert all(v is None for v in values), f"{sheet} {heading} should be blank"


def test_every_month_of_both_years_still_gets_a_column(pack):
    """The sheet keeps the template's shape whether or not the data is there yet, so loading
    history fills columns in rather than moving them."""
    _conn, _ids, _anchor, wb = pack
    columns = _header_columns(wb, "PL_Comparative")
    for year in (2026, 2025):
        for month in range(1, 13):
            assert _label(year, month) in columns


def test_percent_column_divides_by_its_own_columns_net_sales(pack):
    """Each amount column has its own % column against that column's Net Sales — not the
    anchor month's, which is what happens when the formula is copied sideways."""
    _conn, _ids, _anchor, wb = pack
    ws = wb.wb["PL_Comparative"]
    columns = _header_columns(wb, "PL_Comparative")
    row_index = {label: 3 + i for i, label in enumerate(_row_labels(wb, "PL_Comparative", 3))}

    for heading in ("YTD Aug'26", "May'26", "Jun'25"):
        amount_col = columns[heading]
        pct_col = get_column_letter(column_index_from_string(amount_col) + 1)
        r = row_index["Gross Profit"]
        assert ws[f"{pct_col}{r}"].value == f"={amount_col}{r}/{amount_col}${row_index['Net Sales']}"


def test_percentages_evaluate_against_the_engine(pack):
    conn, _ids, anchor, wb = pack
    result = comparative_engine.compute_pl_comparative(conn, anchor)
    columns = _header_columns(wb, "PL_Comparative")
    row_index = {label: 3 + i for i, label in enumerate(_row_labels(wb, "PL_Comparative", 3))}

    for heading, key in (("YTD Aug'26", comparative_engine.YTD_CURRENT), ("May'26", "2026-05")):
        pct_col = get_column_letter(column_index_from_string(columns[heading]) + 1)
        for label in ("Gross Profit", "Operating Expenses", "Net Sales"):
            excel = wb.cell("PL_Comparative", pct_col, row_index[label])
            assert excel == pytest.approx(result.percent(key, label), abs=1e-6), f"{heading} {label}"
