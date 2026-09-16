"""Multi-column P&L and Balance Sheet: YTD current, YTD prior year, and every month of the
fiscal year paired against the same month a year earlier. Mirrors the column layout of
`Kreasi Financials FY Aug 2026.xlsx` (sheets `P&L` and `BS`).

Two rules drive the whole design, and both are about *not* aggregating the wrong thing:

1. **P&L aggregates over leaves, never over subtotals.** A YTD column is not the sum of
   monthly Gross Profit rows; it is `statement_generator.compute_pl_from_totals` applied to
   summed *leaf* totals, so every subtotal is recomputed by the one set of formulas that
   defines the statement. Summing subtotal rows would give the same answer for a plain
   addition like Total Sales and a wrong one wherever the template subtracts (Net Sales,
   Total COGS, Non-Operating), and the two would drift apart the first time a formula
   changed in one place only.

2. **The Balance Sheet does not aggregate at all.** Each column is a point-in-time closing
   position: `compute_bs` on that month's own period. See the note in
   `compute_bs_from_totals` for why its Retained Earnings line must not be fed a YTD profit.

Summing raw leaf totals (Dr-positive signed, pre-display-flip) rather than post-flip display
values is deliberate and equivalent: the flip is a multiplication by ±1 driven by
`normal_balance`, so it distributes over the sum. Doing it this way keeps a single code path
into the statement builders.

Missing months are not zeros. A month with no period row, or one imported but never
consolidated, is reported in `readiness['missing']` and its column value is None so the UI can
render "—". It still contributes nothing to the YTD sum, which is what makes a partially
loaded year usable: with only May–Aug present, YTD Aug shows the sum of those four months and
the banner says which months are absent.
"""

import json
import sqlite3
from pathlib import Path

from src.db.repositories import period_repo
from src.engines.statement_generator import (
    StatementLine,
    compute_bs_from_totals,
    compute_pl_from_totals,
    totals_for_period,
)

CONFIG_DIR = Path(__file__).parent.parent.parent / "config"

YTD_CURRENT = "ytd_current"
YTD_PRIOR = "ytd_prior"


def fiscal_config() -> dict:
    """Calendar Jan–Dec by default. Read from config so a change of financial year is a
    config edit, not a code change."""
    path = CONFIG_DIR / "fiscal.json"
    if not path.exists():
        return {"fiscal_year_start_month": 1, "fiscal_year_end_month": 12}
    return json.loads(path.read_text(encoding="utf-8"))


def fiscal_months() -> list[int]:
    cfg = fiscal_config()
    start = cfg.get("fiscal_year_start_month", 1)
    end = cfg.get("fiscal_year_end_month", 12)
    if start <= end:
        return list(range(start, end + 1))
    # A year straddling December, e.g. Apr–Mar. The month numbers still identify the columns;
    # the calendar year they belong to is resolved by the caller's anchor.
    return list(range(start, 13)) + list(range(1, end + 1))


def month_key(year: int, month: int) -> str:
    return f"{year}-{month:02d}"


class ComparativeContext:
    """Which months each column of the report draws on, and what is wrong with the range."""

    def __init__(self, anchor_year, anchor_month, ytd_range_current, ytd_range_prior,
                 month_pairs, readiness):
        self.anchor_year = anchor_year
        self.anchor_month = anchor_month
        self.ytd_range_current = ytd_range_current
        self.ytd_range_prior = ytd_range_prior
        self.month_pairs = month_pairs
        self.readiness = readiness

    @property
    def anchor_key(self) -> str:
        return month_key(self.anchor_year, self.anchor_month)

    @property
    def missing(self) -> list[str]:
        return self.readiness["missing"]

    @property
    def open_in_range(self) -> list[str]:
        return self.readiness["open"]

    @property
    def stale_in_range(self) -> list[str]:
        return self.readiness["stale"]

    @property
    def is_partial(self) -> bool:
        """True when the YTD columns cover fewer months than the range claims. The figures are
        still correct for the months present — they are just not the whole year to date."""
        return bool(self.missing)


def resolve_comparative_periods(conn: sqlite3.Connection, period_id: int) -> ComparativeContext:
    """Given an anchor period (e.g. 2026-08), lay out every column the report will show.

    Readiness is assessed over the *current* year's YTD range only. The prior year is
    routinely absent in full — this database starts at May 2026 — and reporting twelve
    missing 2025 months as problems would bury the one warning that matters.
    """
    period = conn.execute(
        "SELECT year, month FROM periods WHERE period_id = ?", (period_id,)
    ).fetchone()
    if period is None:
        raise ValueError(f"No period with period_id {period_id}")
    year, month = period["year"], period["month"]

    months = fiscal_months()
    through_anchor = months[: months.index(month) + 1] if month in months else months

    ytd_range_current = [(year, m) for m in through_anchor]
    ytd_range_prior = [(year - 1, m) for m in through_anchor]
    month_pairs = [((year, m), (year - 1, m)) for m in months]

    return ComparativeContext(
        anchor_year=year,
        anchor_month=month,
        ytd_range_current=ytd_range_current,
        ytd_range_prior=ytd_range_prior,
        month_pairs=month_pairs,
        readiness=period_repo.comparative_readiness(conn, ytd_range_current),
    )


def _totals_for_month(conn: sqlite3.Connection, year: int, month: int) -> dict | None:
    """Leaf totals for one month, or None when that month has nothing consolidated.

    None and an all-zero dict are different answers and are kept that way: None becomes "—",
    a real zero becomes 0.
    """
    period = period_repo.get_by_year_month(conn, year, month)
    if period is None:
        return None
    totals = totals_for_period(conn, period["period_id"])
    return totals or None


def _sum_totals(per_month: list[dict]) -> dict:
    """Add leaf totals across months, preserving each account's normal_balance.

    normal_balance is a property of the account, identical in every month it appears, so the
    first one seen wins. An account present in some months and absent in others simply
    contributes nothing for the months it is missing from.
    """
    summed: dict[str, tuple[float, str]] = {}
    for totals in per_month:
        for name, (signed, normal_balance) in totals.items():
            previous, existing_nb = summed.get(name, (0.0, normal_balance))
            summed[name] = (previous + signed, existing_nb or normal_balance)
    return summed


class ComparativeResult:
    """Row labels and structure from the single-period statement, plus a value per column.

    `lines` carries the layout (label, level, kind) exactly as the single-period statement
    produces it, so a template renders the same rows it always did. `values[column][label]`
    and `percents[column][label]` carry the numbers. Column keys are 'ytd_current',
    'ytd_prior', and month keys like '2026-08'.
    """

    def __init__(self, context, lines, columns, values, percents, totals_by_column):
        self.context = context
        self.lines = lines
        self.columns = columns
        self.values = values
        self.percents = percents
        self.totals_by_column = totals_by_column

    def value(self, column: str, label: str):
        return self.values.get(column, {}).get(label)

    def percent(self, column: str, label: str):
        return self.percents.get(column, {}).get(label)

    def has_data(self, column: str) -> bool:
        return column in self.values


def _column_from_lines(lines: list[StatementLine]) -> tuple[dict, dict]:
    """label -> value and label -> percent for one built statement.

    Section rows carry no amount and are skipped. Labels are unique within both statements
    (checked by the tests), so a dict keyed on label is safe and keeps the template simple.
    """
    values, percents = {}, {}
    for line in lines:
        if line.kind == "section":
            continue
        values[line.label] = line.value
        percents[line.label] = line.percent
    return values, percents


def compute_pl_comparative(conn: sqlite3.Connection, period_id: int) -> ComparativeResult:
    """P&L with YTD current, YTD prior, and one column per month of each year.

    Every column — including the two YTD ones — is built by the same
    `compute_pl_from_totals`, differing only in which months' leaf totals were summed to feed
    it. That is what guarantees a YTD subtotal and a monthly subtotal obey the same formula.
    """
    context = resolve_comparative_periods(conn, period_id)

    monthly_totals: dict[str, dict | None] = {}
    for (cur_year, cur_month), (prior_year, prior_month) in context.month_pairs:
        monthly_totals[month_key(cur_year, cur_month)] = _totals_for_month(conn, cur_year, cur_month)
        monthly_totals[month_key(prior_year, prior_month)] = _totals_for_month(conn, prior_year, prior_month)

    def ytd_totals(month_range):
        present = [monthly_totals[month_key(y, m)] for y, m in month_range]
        present = [t for t in present if t is not None]
        return _sum_totals(present) if present else None

    columns: list[str] = [YTD_CURRENT, YTD_PRIOR]
    column_totals: dict[str, dict | None] = {
        YTD_CURRENT: ytd_totals(context.ytd_range_current),
        YTD_PRIOR: ytd_totals(context.ytd_range_prior),
    }
    for (cur, prior) in context.month_pairs:
        for year, month in (cur, prior):
            key = month_key(year, month)
            columns.append(key)
            column_totals[key] = monthly_totals[key]

    lines: list[StatementLine] = []
    values: dict[str, dict] = {}
    percents: dict[str, dict] = {}
    net_income: dict[str, float] = {}

    for column in columns:
        totals = column_totals[column]
        if totals is None:
            continue
        built, ni = compute_pl_from_totals(totals)
        if not lines:
            lines = built
        column_values, column_percents = _column_from_lines(built)
        values[column] = column_values
        percents[column] = column_percents
        net_income[column] = ni

    if not lines:
        # Nothing consolidated anywhere in range. Still return the row structure so the page
        # renders its labels with "—" throughout rather than showing an empty screen.
        lines, _ = compute_pl_from_totals({})

    return ComparativeResult(context, lines, columns, values, percents, net_income)


def compute_bs_comparative(conn: sqlite3.Connection, period_id: int) -> ComparativeResult:
    """Balance Sheet as paired month-end positions — no YTD columns.

    Each column is one month's closing position and nothing is summed across months, per the
    locked decision and because a summed balance sheet is meaningless.
    """
    context = resolve_comparative_periods(conn, period_id)

    columns: list[str] = []
    lines: list[StatementLine] = []
    values: dict[str, dict] = {}
    percents: dict[str, dict] = {}
    total_assets: dict[str, float] = {}

    for (cur, prior) in context.month_pairs:
        for year, month in (cur, prior):
            key = month_key(year, month)
            columns.append(key)
            totals = _totals_for_month(conn, year, month)
            if totals is None:
                continue
            built, assets, _liabilities_equity = compute_bs_from_totals(totals)
            if not lines:
                lines = built
            column_values, column_percents = _column_from_lines(built)
            values[key] = column_values
            percents[key] = column_percents
            total_assets[key] = assets

    if not lines:
        lines, _assets, _le = compute_bs_from_totals({})

    return ComparativeResult(context, lines, columns, values, percents, total_assets)
