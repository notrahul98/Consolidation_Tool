"""Guards for the comparative engine.

The `two_periods` fixture (May + June 2026) is deliberately the main test bed: it is the same
shape as the live database, where only part of the year is loaded and the prior year does not
exist at all. A YTD column that only works on a complete year is no use here.

Note that every P&L subtotal formula is linear, so summing monthly subtotals and recomputing
subtotals from summed leaves give the *same number*. The difference only becomes visible in
the % columns and the moment a formula changes. The tests below therefore check the subtotal
identities hold in every column and that percentages are computed per column, which is what
actually catches the mistake.
"""

import pytest

from src.db.repositories import period_repo
from src.engines import comparative_engine as ce
from src.engines.statement_generator import compute_bs, compute_pl
from tests.conftest import categorize_all, import_all_entities


def labelled(lines):
    return {line.label: line.value for line in lines if line.kind != "section"}


# --- context resolution -------------------------------------------------------------------

def test_resolves_ytd_ranges_and_month_pairs(two_periods):
    conn, _may_id, june_id = two_periods
    ctx = ce.resolve_comparative_periods(conn, june_id)

    assert (ctx.anchor_year, ctx.anchor_month) == (2026, 6)
    assert ctx.anchor_key == "2026-06"
    assert ctx.ytd_range_current == [(2026, m) for m in range(1, 7)]
    assert ctx.ytd_range_prior == [(2025, m) for m in range(1, 7)]
    assert len(ctx.month_pairs) == 12
    assert ctx.month_pairs[0] == ((2026, 1), (2025, 1))
    assert ctx.month_pairs[-1] == ((2026, 12), (2025, 12))


def test_reports_missing_and_open_months_in_current_year_only(two_periods):
    conn, _may_id, june_id = two_periods
    ctx = ce.resolve_comparative_periods(conn, june_id)

    # Jan-Apr 2026 were never imported; May and June exist but are not locked.
    assert ctx.missing == ["2026-01", "2026-02", "2026-03", "2026-04"]
    assert ctx.open_in_range == ["2026-05", "2026-06"]
    assert ctx.is_partial is True
    # The whole of 2025 is absent, but reporting twelve prior-year months as problems would
    # bury the warning that matters.
    assert not any(label.startswith("2025") for label in ctx.missing)


def test_locking_a_period_clears_it_from_the_open_warning(two_periods):
    conn, may_id, june_id = two_periods
    period_repo.lock(conn, may_id, user="test")
    conn.commit()

    ctx = ce.resolve_comparative_periods(conn, june_id)
    assert ctx.open_in_range == ["2026-06"]


def test_unknown_period_id_is_an_error(conn):
    with pytest.raises(ValueError, match="No period"):
        ce.resolve_comparative_periods(conn, 9999)


# --- P&L: YTD aggregation -----------------------------------------------------------------

def test_ytd_equals_the_sum_of_the_months_present(two_periods):
    conn, may_id, june_id = two_periods
    may = labelled(compute_pl(conn, may_id)[0])
    june = labelled(compute_pl(conn, june_id)[0])

    result = ce.compute_pl_comparative(conn, june_id)
    ytd = result.values[ce.YTD_CURRENT]

    for label in ("Sales", "Total Sales", "Net Sales", "Gross Profit",
                  "Operating Expenses", "Salaries & Wages",
                  "Net Income/(Loss) After Tax & Previous Year Expenses"):
        assert ytd[label] == pytest.approx(may[label] + june[label]), label


def test_ytd_net_income_is_the_sum_of_monthly_net_income(two_periods):
    conn, may_id, june_id = two_periods
    _, may_ni = compute_pl(conn, may_id)
    _, june_ni = compute_pl(conn, june_id)

    result = ce.compute_pl_comparative(conn, june_id)
    assert result.totals_by_column[ce.YTD_CURRENT] == pytest.approx(may_ni + june_ni)


def test_monthly_columns_match_the_single_period_statement(two_periods):
    conn, may_id, june_id = two_periods
    result = ce.compute_pl_comparative(conn, june_id)

    for key, period_id in (("2026-05", may_id), ("2026-06", june_id)):
        single = labelled(compute_pl(conn, period_id)[0])
        assert result.values[key] == pytest.approx(single)


def test_subtotal_identities_hold_in_every_column(two_periods):
    """The point of rebuilding from summed leaves: each subtotal still obeys the template's
    own formula rather than being an independent sum."""
    conn, _may_id, june_id = two_periods
    result = ce.compute_pl_comparative(conn, june_id)

    for column, values in result.values.items():
        assert values["Net Sales"] == pytest.approx(
            values["Total Sales"] - values["Sales Discount/Return"]), column
        assert values["Total Cost of Goods Sold"] == pytest.approx(
            values["COGS before Direct Cost & Forex Gain/Loss"]
            + values["Direct Costs"] - values["Direct Income"]), column
        assert values["Gross Profit"] == pytest.approx(
            values["Net Sales"] - values["Total Cost of Goods Sold"]), column
        assert values["Operative Profit/(Loss)"] == pytest.approx(
            values["Gross Profit"] - values["Operating Expenses"]), column
        assert values["Total Non Operating Expenses/(Income)"] == pytest.approx(
            values["Miscellaneous Expenses"] - values["Miscellaneous Incomes"]), column


def test_percentages_are_per_column_not_aggregated(two_periods):
    """% is value / that column's own Net Sales. Non-linear, so this is where summing the
    wrong thing would actually show up in a number."""
    conn, _may_id, june_id = two_periods
    result = ce.compute_pl_comparative(conn, june_id)

    for column in (ce.YTD_CURRENT, "2026-05", "2026-06"):
        values = result.values[column]
        percents = result.percents[column]
        net_sales = values["Net Sales"]
        assert net_sales != 0, column
        assert percents["Gross Profit"] == pytest.approx(values["Gross Profit"] / net_sales)
        assert percents["Net Sales"] == pytest.approx(1.0)

    # The YTD percentage is its own ratio, not the sum of the monthly ones.
    ytd_pct = result.percents[ce.YTD_CURRENT]["Gross Profit"]
    monthly_sum = result.percents["2026-05"]["Gross Profit"] + result.percents["2026-06"]["Gross Profit"]
    assert ytd_pct != pytest.approx(monthly_sum)


# --- P&L: sparse ranges -------------------------------------------------------------------

def test_missing_months_have_no_column_data(two_periods):
    conn, _may_id, june_id = two_periods
    result = ce.compute_pl_comparative(conn, june_id)

    for absent in ("2026-01", "2026-04", "2026-07", "2026-12", "2025-05", "2025-06"):
        assert not result.has_data(absent), absent
        # None, so the UI renders "—". A real zero would be indistinguishable from a month
        # that genuinely netted to nothing.
        assert result.value(absent, "Sales") is None


def test_absent_prior_year_yields_no_ytd_prior_column(two_periods):
    conn, _may_id, june_id = two_periods
    result = ce.compute_pl_comparative(conn, june_id)

    assert ce.YTD_PRIOR in result.columns
    assert not result.has_data(ce.YTD_PRIOR)
    assert result.value(ce.YTD_PRIOR, "Net Sales") is None


def test_columns_cover_both_years_and_both_ytd_keys(two_periods):
    conn, _may_id, june_id = two_periods
    result = ce.compute_pl_comparative(conn, june_id)

    assert result.columns[:2] == [ce.YTD_CURRENT, ce.YTD_PRIOR]
    for month in range(1, 13):
        assert f"2026-{month:02d}" in result.columns
        assert f"2025-{month:02d}" in result.columns


def test_single_month_ytd_equals_that_month(consolidated):
    """June alone: the YTD column must equal the month, not double it."""
    conn, period_id, _ = consolidated
    single = labelled(compute_pl(conn, period_id)[0])
    result = ce.compute_pl_comparative(conn, period_id)

    assert result.values[ce.YTD_CURRENT] == pytest.approx(single)


def test_row_structure_survives_a_range_with_no_data(conn):
    """An anchor period that exists but was never consolidated still renders its labels."""
    period_id = period_repo.get_or_create(conn, 2026, 3)
    conn.commit()
    result = ce.compute_pl_comparative(conn, period_id)

    assert [line.label for line in result.lines][:4] == [
        "Sales", "Total Sales", "Sales Discount/Return", "Net Sales"]
    assert result.values == {}
    assert result.context.missing == ["2026-01", "2026-02", "2026-03"]


# --- Balance Sheet ------------------------------------------------------------------------

def test_bs_columns_are_point_in_time_not_summed(two_periods):
    conn, may_id, june_id = two_periods
    result = ce.compute_bs_comparative(conn, june_id)

    for key, period_id in (("2026-05", may_id), ("2026-06", june_id)):
        single = labelled(compute_bs(conn, period_id)[0])
        assert result.values[key] == pytest.approx(single)

    # Explicitly not additive: June's total assets are June's, not May + June.
    may_assets = result.values["2026-05"]["TOTAL ASSETS"]
    june_assets = result.values["2026-06"]["TOTAL ASSETS"]
    assert june_assets != pytest.approx(may_assets + june_assets)


def test_bs_has_no_ytd_columns(two_periods):
    conn, _may_id, june_id = two_periods
    result = ce.compute_bs_comparative(conn, june_id)

    assert ce.YTD_CURRENT not in result.columns
    assert ce.YTD_PRIOR not in result.columns
    assert len(result.columns) == 24


def test_bs_check_row_stays_balanced_in_each_column(two_periods):
    conn, _may_id, june_id = two_periods
    result = ce.compute_bs_comparative(conn, june_id)

    for column, values in result.values.items():
        assert values["Check"] == pytest.approx(0.0, abs=1.0), column


def test_bs_missing_months_are_none(two_periods):
    conn, _may_id, june_id = two_periods
    result = ce.compute_bs_comparative(conn, june_id)

    assert not result.has_data("2026-02")
    assert result.value("2026-02", "TOTAL ASSETS") is None


# --- leaf-total summing -------------------------------------------------------------------

def test_sum_totals_adds_signed_balances_and_keeps_normal_balance():
    summed = ce._sum_totals([
        {"Sales": (-100.0, "CR"), "Rent Expense": (30.0, "DR")},
        {"Sales": (-50.0, "CR")},
        {"Bad Debts": (7.0, "DR")},
    ])
    assert summed["Sales"] == (-150.0, "CR")
    assert summed["Rent Expense"] == (30.0, "DR")
    assert summed["Bad Debts"] == (7.0, "DR")


def test_statement_labels_are_unique(two_periods):
    """`values` is a dict keyed on label, so a duplicated row label would silently drop a
    line. Both statements are checked because the layouts differ."""
    conn, _may_id, june_id = two_periods
    for result in (ce.compute_pl_comparative(conn, june_id),
                   ce.compute_bs_comparative(conn, june_id)):
        labels = [line.label for line in result.lines if line.kind != "section"]
        assert len(labels) == len(set(labels)), [l for l in labels if labels.count(l) > 1]


# --- readiness ----------------------------------------------------------------------------

def test_readiness_flags_imported_but_unconsolidated_as_missing(conn):
    """A period row with no consolidated_tb rows has no figures to show. Treating it as
    present would put a zero column on the report instead of a dash."""
    import_all_entities(conn, "2026-06")
    categorize_all(conn)
    conn.commit()

    readiness = period_repo.comparative_readiness(conn, [(2026, 5), (2026, 6)])
    assert readiness["missing"] == ["2026-05", "2026-06"]
    assert readiness["open"] == []


def test_readiness_flags_stale_consolidation(two_periods):
    from src.db.repositories import group_coa_repo
    from src.engines import adjustment_engine

    conn, _may_id, june_id = two_periods
    assert period_repo.comparative_readiness(conn, [(2026, 6)])["stale"] == []

    rent = group_coa_repo.get_by_name(conn, "Rent Expense")
    accruals = group_coa_repo.get_by_name(conn, "Accrued Expenses")
    adjustment_engine.create_adjustment(
        conn, june_id, "ADJ-TEST-1", "reclassification", "staleness probe",
        [{"group_account_id": rent["group_account_id"], "entity_id": None,
          "debit_amount": 100.0, "credit_amount": 0.0},
         {"group_account_id": accruals["group_account_id"], "entity_id": None,
          "debit_amount": 0.0, "credit_amount": 100.0}],
        user="test",
    )
    conn.commit()

    assert period_repo.comparative_readiness(conn, [(2026, 6)])["stale"] == ["2026-06"]


def test_fiscal_config_is_calendar_year():
    assert ce.fiscal_months() == list(range(1, 13))


# --- consolidated monthly matrix ----------------------------------------------------------

def test_matrix_has_one_column_per_month_with_data(two_periods):
    conn, _may_id, june_id = two_periods
    context, columns, totals = ce.consolidated_matrix(conn, june_id)

    assert columns == ["2026-05", "2026-06"]
    assert set(totals) == {"2026-05", "2026-06"}
    # Jan-Apr have no period rows at all, so they get no column rather than an empty one.
    assert context.missing == ["2026-01", "2026-02", "2026-03", "2026-04"]


def test_matrix_values_are_the_consolidated_total_for_that_month(two_periods):
    """Each cell must be the same figure the single-period view's Total column shows, which is
    entity balances plus entity-level and group-level adjustments."""
    from src.db.repositories import consolidated_repo

    conn, may_id, june_id = two_periods
    _context, _columns, totals = ce.consolidated_matrix(conn, june_id)

    for key, period_id in (("2026-05", may_id), ("2026-06", june_id)):
        _by_entity, _group_adj, total = consolidated_repo.get_buckets(conn, period_id)
        assert totals[key] == total


def test_matrix_stops_at_the_anchor_month(consolidated):
    """June is the anchor; a July that exists must not appear in June's matrix."""
    from src.db.repositories import period_repo
    from src.engines.consolidation_engine import consolidate_period
    from tests.conftest import import_all_entities

    conn, june_id, _ = consolidated
    july_id = import_all_entities(conn, "2026-07")
    consolidate_period(conn, july_id)
    conn.commit()
    assert period_repo.get_by_year_month(conn, 2026, 7) is not None

    _context, columns, _totals = ce.consolidated_matrix(conn, june_id)
    assert columns == ["2026-06"]


def test_matrix_carries_no_year_to_date_column(two_periods):
    """These rows mix balance sheet and P&L accounts; summing a balance sheet account across
    months would be meaningless, so the matrix deliberately offers no total."""
    conn, _may_id, june_id = two_periods
    _context, columns, _totals = ce.consolidated_matrix(conn, june_id)
    assert not [c for c in columns if c.startswith("ytd")]
