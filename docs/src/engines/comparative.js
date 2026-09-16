// Port of src/engines/comparative_engine.py — multi-column P&L and Balance Sheet: YTD
// current, YTD prior year, and every month of the fiscal year paired against the same month
// a year earlier. Mirrors the column layout of `Kreasi Financials FY Aug 2026.xlsx`.
//
// Two rules drive the whole design, and both are about *not* aggregating the wrong thing:
//
// 1. The P&L aggregates over leaves, never over subtotals. A YTD column is not the sum of
//    monthly Gross Profit rows; it is computePlFromTotals applied to summed *leaf* totals, so
//    every subtotal is recomputed by the one set of formulas that defines the statement.
//    Summing subtotal rows would give the same answer for a plain addition like Total Sales
//    and a wrong one wherever the template subtracts (Net Sales, Total COGS, Non-Operating),
//    and the two would drift apart the first time a formula changed in one place only.
//
// 2. The Balance Sheet does not aggregate at all. Each column is a point-in-time closing
//    position: computeBs on that month's own period. See the note on computeBsFromTotals for
//    why its Retained Earnings line must not be fed a YTD profit.
//
// Summing raw leaf totals (Dr-positive signed, pre-display-flip) rather than post-flip
// display values is deliberate and equivalent: the flip is a multiplication by ±1 driven by
// normal_balance, so it distributes over the sum.
//
// Missing months are not zeros. A month with no period row, or one imported but never
// consolidated, is reported in readiness.missing and its column value is null so the UI can
// render "—". It still contributes nothing to the YTD sum, which is what makes a partially
// loaded year usable: with only May–Aug present, YTD Aug shows the sum of those four months
// and the banner says which months are absent.
import { persistence } from "../db/persistence.js";
import * as periodRepo from "../db/period-repo.js";
import { computeBsFromTotals, computePlFromTotals, totalsForPeriod } from "./statements.js";

export const YTD_CURRENT = "ytd_current";
export const YTD_PRIOR = "ytd_prior";

// Calendar Jan–Dec, matching config/fiscal.json on the Python side. Kept as a constant rather
// than fetched, because the browser app seeds itself from static JSON at boot and this is a
// locked decision; if the financial year ever moves, both files change together.
const FISCAL_YEAR_START_MONTH = 1;
const FISCAL_YEAR_END_MONTH = 12;

export function fiscalMonths() {
  const start = FISCAL_YEAR_START_MONTH;
  const end = FISCAL_YEAR_END_MONTH;
  const months = [];
  if (start <= end) {
    for (let m = start; m <= end; m += 1) months.push(m);
    return months;
  }
  // A year straddling December, e.g. Apr–Mar.
  for (let m = start; m <= 12; m += 1) months.push(m);
  for (let m = 1; m <= end; m += 1) months.push(m);
  return months;
}

export function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

// Which months each column of the report draws on, and what is wrong with the range.
export class ComparativeContext {
  constructor({ anchorYear, anchorMonth, ytdRangeCurrent, ytdRangePrior, monthPairs, readiness }) {
    this.anchorYear = anchorYear;
    this.anchorMonth = anchorMonth;
    this.ytdRangeCurrent = ytdRangeCurrent;
    this.ytdRangePrior = ytdRangePrior;
    this.monthPairs = monthPairs;
    this.readiness = readiness;
  }

  get anchorKey() {
    return monthKey(this.anchorYear, this.anchorMonth);
  }

  get missing() {
    return this.readiness.missing;
  }

  get openInRange() {
    return this.readiness.open;
  }

  get staleInRange() {
    return this.readiness.stale;
  }

  // True when the YTD columns cover fewer months than the range claims. The figures are still
  // correct for the months present — they are just not the whole year to date.
  get isPartial() {
    return this.missing.length > 0;
  }
}

// Given an anchor period (e.g. 2026-08), lay out every column the report will show.
//
// Readiness is assessed over the *current* year's YTD range only. The prior year is routinely
// absent in full — this database starts at May 2026 — and reporting twelve missing 2025
// months as problems would bury the one warning that matters.
export function resolveComparativePeriods(periodId) {
  const period = persistence.get("SELECT year, month FROM periods WHERE period_id = ?", [periodId]);
  if (!period) throw new Error(`No period with period_id ${periodId}`);
  const { year, month } = period;

  const months = fiscalMonths();
  const index = months.indexOf(month);
  const throughAnchor = index === -1 ? months : months.slice(0, index + 1);

  return new ComparativeContext({
    anchorYear: year,
    anchorMonth: month,
    ytdRangeCurrent: throughAnchor.map((m) => [year, m]),
    ytdRangePrior: throughAnchor.map((m) => [year - 1, m]),
    monthPairs: months.map((m) => [
      [year, m],
      [year - 1, m],
    ]),
    readiness: periodRepo.comparativeReadiness(throughAnchor.map((m) => [year, m])),
  });
}

// Leaf totals for one month, or null when that month has nothing consolidated.
//
// null and an all-zero map are different answers and are kept that way: null becomes "—", a
// real zero becomes 0.
function totalsForMonth(year, month) {
  const period = periodRepo.getByYearMonth(year, month);
  if (!period) return null;
  const totals = totalsForPeriod(period.period_id);
  return totals.size ? totals : null;
}

// Add leaf totals across months, preserving each account's normal_balance.
//
// normal_balance is a property of the account, identical in every month it appears, so the
// first one seen wins. An account present in some months and absent in others simply
// contributes nothing for the months it is missing from.
export function sumTotals(perMonth) {
  const summed = new Map();
  for (const totals of perMonth) {
    for (const [name, [signed, normalBalance]] of totals) {
      const existing = summed.get(name);
      if (existing) summed.set(name, [existing[0] + signed, existing[1] || normalBalance]);
      else summed.set(name, [signed, normalBalance]);
    }
  }
  return summed;
}

// Row labels and structure from the single-period statement, plus a value per column.
//
// `lines` carries the layout (label, level, kind) exactly as the single-period statement
// produces it, so a page renders the same rows it always did. values/percents are
// Map<column, Map<label, number>>. Column keys are 'ytd_current', 'ytd_prior', and month keys
// like '2026-08'.
export class ComparativeResult {
  constructor({ context, lines, columns, values, percents, totalsByColumn }) {
    this.context = context;
    this.lines = lines;
    this.columns = columns;
    this.values = values;
    this.percents = percents;
    this.totalsByColumn = totalsByColumn;
  }

  value(column, label) {
    const col = this.values.get(column);
    if (!col) return null;
    const v = col.get(label);
    return v === undefined ? null : v;
  }

  percent(column, label) {
    const col = this.percents.get(column);
    if (!col) return null;
    const v = col.get(label);
    return v === undefined ? null : v;
  }

  hasData(column) {
    return this.values.has(column);
  }
}

// label -> value and label -> percent for one built statement. Section rows carry no amount
// and are skipped; labels are unique within both statements, so keying on label is safe.
function columnFromLines(lines) {
  const values = new Map();
  const percents = new Map();
  for (const line of lines) {
    if (line.kind === "section") continue;
    values.set(line.label, line.value);
    percents.set(line.label, line.percent);
  }
  return [values, percents];
}

// P&L with YTD current, YTD prior, and one column per month of each year.
//
// Every column — including the two YTD ones — is built by the same computePlFromTotals,
// differing only in which months' leaf totals were summed to feed it. That is what guarantees
// a YTD subtotal and a monthly subtotal obey the same formula.
export function computePlComparative(periodId) {
  const context = resolveComparativePeriods(periodId);

  const monthlyTotals = new Map();
  for (const [current, prior] of context.monthPairs) {
    for (const [year, month] of [current, prior]) {
      monthlyTotals.set(monthKey(year, month), totalsForMonth(year, month));
    }
  }

  const ytdTotals = (range) => {
    const present = range.map(([y, m]) => monthlyTotals.get(monthKey(y, m))).filter((t) => t !== null && t !== undefined);
    return present.length ? sumTotals(present) : null;
  };

  const columns = [YTD_CURRENT, YTD_PRIOR];
  const columnTotals = new Map([
    [YTD_CURRENT, ytdTotals(context.ytdRangeCurrent)],
    [YTD_PRIOR, ytdTotals(context.ytdRangePrior)],
  ]);
  for (const [current, prior] of context.monthPairs) {
    for (const [year, month] of [current, prior]) {
      const key = monthKey(year, month);
      columns.push(key);
      columnTotals.set(key, monthlyTotals.get(key));
    }
  }

  let lines = [];
  const values = new Map();
  const percents = new Map();
  const netIncome = new Map();

  for (const column of columns) {
    const totals = columnTotals.get(column);
    if (!totals) continue;
    const built = computePlFromTotals(totals);
    if (!lines.length) lines = built.lines;
    const [columnValues, columnPercents] = columnFromLines(built.lines);
    values.set(column, columnValues);
    percents.set(column, columnPercents);
    netIncome.set(column, built.netIncome);
  }

  // Nothing consolidated anywhere in range. Still return the row structure so the page renders
  // its labels with "—" throughout rather than showing an empty screen.
  if (!lines.length) lines = computePlFromTotals(new Map()).lines;

  return new ComparativeResult({ context, lines, columns, values, percents, totalsByColumn: netIncome });
}

// Balance Sheet as paired month-end positions — no YTD columns. Each column is one month's
// closing position and nothing is summed across months, because a summed balance sheet is
// meaningless.
export function computeBsComparative(periodId) {
  const context = resolveComparativePeriods(periodId);

  const columns = [];
  let lines = [];
  const values = new Map();
  const percents = new Map();
  const totalAssets = new Map();

  for (const [current, prior] of context.monthPairs) {
    for (const [year, month] of [current, prior]) {
      const key = monthKey(year, month);
      columns.push(key);
      const totals = totalsForMonth(year, month);
      if (!totals) continue;
      const built = computeBsFromTotals(totals);
      if (!lines.length) lines = built.lines;
      const [columnValues, columnPercents] = columnFromLines(built.lines);
      values.set(key, columnValues);
      percents.set(key, columnPercents);
      totalAssets.set(key, built.totalAssets);
    }
  }

  if (!lines.length) lines = computeBsFromTotals(new Map()).lines;

  return new ComparativeResult({ context, lines, columns, values, percents, totalsByColumn: totalAssets });
}
