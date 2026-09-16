// Port of src/exporters/excel_pack_generator.py — every derived cell is a live Excel
// formula, not a static value, so the workbook is traceable directly in Excel:
//
//   Entity_<CODE> sheets (base data, from the DB)
//     -> Conso_TB_Matrix (entity columns reference Entity_<CODE>; Adjustments holds
//        GROUP-LEVEL adjustments only; Total = SUM across the entity columns AND Adjustments)
//       -> Conso_TB_Total (Adjustments/Total columns reference Conso_TB_Matrix's own)
//         -> PL_Current / BS_Current (leaves reference Conso_TB_Total; subtotals are
//            SUM/arithmetic formulas over rows within the same sheet; BS_Current's
//            Retained Earnings cross-references PL_Current's Net Income row directly)
//           -> Conso_TB_By_Period (one column per month; the anchor month's column is a
//              formula into Conso_TB_Total so the two can never disagree, other months are
//              written data, and the two YTD columns are SUMs over a month range)
//             -> PL_Comparative / BS_Comparative (same rows and the same subtotal formulas
//                as PL_Current / BS_Current, one column per period)
import { persistence } from "../db/persistence.js";
import * as entityRepo from "../db/entity-repo.js";
import * as groupCoaRepo from "../db/group-coa-repo.js";
import * as consolidatedRepo from "../db/consolidated-repo.js";
import * as mappingRepo from "../db/mapping-repo.js";
import * as adjustmentRepo from "../db/adjustment-repo.js";
import { runAll } from "../engines/validation.js";
import * as comparative from "../engines/comparative.js";
import { codepointCompare } from "../utils.js";

const IDR_FORMAT = "#,##0;(#,##0)";
const BOLD = { bold: true };
const GREEN_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC6EFCE" } };
const RED_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } };

function setColWidths(ws, widths) {
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });
}

function writeSummary(wb, periodId, periodLabel, validations) {
  const ws = wb.addWorksheet("Summary");
  ws.addRow(["Tally Consolidation Tool - Phase 1"]);
  ws.getCell("A1").font = { bold: true, size: 14 };
  ws.addRow(["Period", periodLabel]);
  ws.addRow([]);
  ws.addRow(["Entities"]);
  ws.getCell(`A${ws.rowCount}`).font = BOLD;
  for (const e of entityRepo.listAll()) {
    ws.addRow([e.entity_code, e.entity_name]);
  }
  ws.addRow([]);
  ws.addRow(["Validation status"]);
  ws.getCell(`A${ws.rowCount}`).font = BOLD;
  const passed = validations.filter((v) => v.passed).length;
  ws.addRow([`${passed}/${validations.length} checks passed`]);
  for (const v of validations) {
    ws.addRow([v.checkId, v.description, v.passed ? "PASS" : "FAIL"]);
    ws.getRow(ws.rowCount).getCell(3).fill = v.passed ? GREEN_FILL : RED_FILL;
  }
  setColWidths(ws, [40, 55]);
}

// Base layer: every leaf category for every entity, in identical canonical order across
// all entity sheets (even zero-balance ones) so row numbers are predictable and
// Conso_TB_Matrix can reference them by cell, not by re-deriving the value.
function writeEntitySheets(wb, periodId) {
  const entities = entityRepo.listAll();
  const coaLeaves = groupCoaRepo.listLeafCategories();
  // Shared with the Consolidated TB page. Each entity's cell is its TB plus any adjustment
  // booked against that entity, summed (see HANDOVER.md §9.6). Group-level adjustments are
  // deliberately NOT here — they belong to no entity and are carried by the matrix's own
  // Adjustments column instead.
  const { byAccountEntity } = consolidatedRepo.getBuckets(periodId);

  const entityRow = {};
  for (const e of entities) {
    const ws = wb.addWorksheet(`Entity_${e.entity_code}`);
    ws.addRow(["Account Code", "Account Name", "Section", "Closing Balance"]);
    ws.getRow(1).eachCell((c) => (c.font = BOLD));
    ws.views = [{ state: "frozen", ySplit: 1 }];
    const codeToRow = {};
    for (const row of coaLeaves) {
      const v = byAccountEntity.get(`${row.group_account_id}:${e.entity_id}`) || 0.0;
      ws.addRow([row.account_code, row.account_name, row.section, v]);
      ws.getRow(ws.rowCount).getCell(4).numFmt = IDR_FORMAT;
      codeToRow[row.account_code] = ws.rowCount;
    }
    entityRow[e.entity_code] = codeToRow;
    setColWidths(ws, [12, 40, 20, 16]);
  }
  return entityRow;
}

// Conso_TB_Matrix: entity columns formula-reference Entity_<CODE> sheets; Adjustments is a
// static column holding GROUP-LEVEL adjustments only (there's no per-entity "Entity_ADJ"
// sheet to formula-reference, so this one column is a computed value rather than a
// cross-sheet formula). Total is a SUM formula across the entity columns AND the
// Adjustments column. Conso_TB_Total mirrors the same row layout and formula-references
// Conso_TB_Matrix's own Adjustments and Total columns.
//
// The Adjustments column must be group-level only, and the Total must span it:
//   * entity-specific adjustments are already inside the Entity_<CODE> sheets, so counting
//     them here as well would double them;
//   * group-level adjustments live in no entity column at all, so leaving them outside the
//     SUM drops them from the workbook entirely — the Balance Sheet then disagrees with the
//     tool while Total Assets, Total Liabilities and Equity, and Check all still tie,
//     because a balanced group-level journal hides inside the totals.
function writeMatrixAndTotal(wb, periodId, coaRows, entities, entityRow) {
  const { groupAdjustment } = consolidatedRepo.getBuckets(periodId);

  const ws = wb.addWorksheet("Conso_TB_Matrix");
  const header = ["Account Code", "Account Name", "Section", ...entities.map((e) => e.entity_code), "Adjustments", "Total"];
  ws.addRow(header);
  ws.getRow(1).eachCell((c) => (c.font = BOLD));
  ws.views = [{ state: "frozen", xSplit: 3, ySplit: 1 }];

  const entityStartCol = 4;
  const adjCol = entityStartCol + entities.length;
  const totalCol = adjCol + 1;
  const adjColLetter = colLetter(adjCol);
  const totalColLetter = colLetter(totalCol);

  const codeRow = {};
  for (const row of coaRows) {
    ws.addRow([row.account_code, row.account_name, row.section]);
    const r = ws.rowCount;
    codeRow[row.account_code] = r;
    if (!row.is_header) {
      entities.forEach((e, i) => {
        const col = entityStartCol + i;
        const entitySheetRow = entityRow[e.entity_code][row.account_code];
        const cell = ws.getRow(r).getCell(col);
        if (entitySheetRow) {
          cell.value = { formula: `'Entity_${e.entity_code}'!D${entitySheetRow}` };
        }
        cell.numFmt = IDR_FORMAT;
      });
      const adjCell = ws.getRow(r).getCell(adjCol);
      adjCell.value = groupAdjustment.get(row.group_account_id) || null;
      adjCell.numFmt = IDR_FORMAT;

      // Spans the entity columns THROUGH the Adjustments column — see the note above.
      const firstLetter = colLetter(entityStartCol);
      const totalCell = ws.getRow(r).getCell(totalCol);
      totalCell.value = { formula: `SUM(${firstLetter}${r}:${adjColLetter}${r})` };
      totalCell.numFmt = IDR_FORMAT;
    } else {
      ws.getRow(r).eachCell((c) => (c.font = BOLD));
    }
  }
  setColWidths(ws, [12, 40, 20, ...entities.map(() => 14), 14, 14]);

  const wsTotal = wb.addWorksheet("Conso_TB_Total");
  wsTotal.addRow(["Account Code", "Account Name", "Section", "Adjustments", "Total"]);
  wsTotal.getRow(1).eachCell((c) => (c.font = BOLD));
  wsTotal.views = [{ state: "frozen", xSplit: 3, ySplit: 1 }];
  for (const row of coaRows) {
    wsTotal.addRow([row.account_code, row.account_name, row.section]);
    const r = wsTotal.rowCount;
    if (r !== codeRow[row.account_code]) {
      throw new Error("Conso_TB_Total must mirror Conso_TB_Matrix row-for-row");
    }
    if (!row.is_header) {
      const adjCell = wsTotal.getRow(r).getCell(4);
      adjCell.value = { formula: `'Conso_TB_Matrix'!${adjColLetter}${r}` };
      adjCell.numFmt = IDR_FORMAT;
      const totalCell = wsTotal.getRow(r).getCell(5);
      totalCell.value = { formula: `'Conso_TB_Matrix'!${totalColLetter}${r}` };
      totalCell.numFmt = IDR_FORMAT;
    } else {
      wsTotal.getRow(r).eachCell((c) => (c.font = BOLD));
    }
  }
  setColWidths(wsTotal, [12, 40, 20, 16, 16]);

  return codeRow;
}

function writeMappingSheet(wb, periodId) {
  const ws = wb.addWorksheet("Mapping");
  ws.addRow(["Ledger Name", "Entities Present In", "Category", "Status"]);
  ws.getRow(1).eachCell((c) => (c.font = BOLD));
  ws.views = [{ state: "frozen", ySplit: 1 }];
  const entries = mappingRepo.distinctLedgersForPeriod(periodId).sort((a, b) => codepointCompare(a.ledgerName, b.ledgerName));
  for (const entry of entries) {
    let category = null;
    if (entry.groupAccountIds.size === 1) {
      const row = groupCoaRepo.getById(entry.groupAccountIds.values().next().value);
      category = row ? row.account_name : null;
    }
    const status = entry.groupAccountIds.size > 0 ? "Mapped" : "Unmapped";
    ws.addRow([entry.ledgerName, Array.from(new Set(entry.entities)).sort().join(", "), category, status]);
  }
  setColWidths(ws, [45, 22, 40, 14]);
}

function writeValidationSheet(wb, validations) {
  const ws = wb.addWorksheet("Validation");
  ws.addRow(["Check", "Description", "Severity", "Status", "Details"]);
  ws.getRow(1).eachCell((c) => (c.font = BOLD));
  ws.views = [{ state: "frozen", ySplit: 1 }];
  for (const v of validations) {
    const detailText = v.details.length ? v.details.join("; ") : null;
    ws.addRow([v.checkId, v.description, v.severity, v.passed ? "PASS" : "FAIL", detailText]);
    ws.getRow(ws.rowCount).getCell(4).fill = v.passed ? GREEN_FILL : RED_FILL;
  }
  setColWidths(ws, [10, 50, 10, 10, 80]);
}

// Formula fragment pulling a leaf category from Conso_TB_Total, applying the Dr-positive
// -> display-magnitude sign flip via normal_balance.
function leafRef(name, nameToLeaf, codeRow, positiveOverride = false) {
  const info = nameToLeaf[name];
  const row = codeRow[info.account_code];
  const negate = info.normal_balance === "CR" && !positiveOverride;
  const ref = `'Conso_TB_Total'!E${row}`;
  return negate ? `-${ref}` : ref;
}

// --- Statement layouts ---------------------------------------------------------------------
// The P&L and BS row structures, written once and rendered into any column.
//
// PL_Current fills one column; PL_Comparative fills twenty-six. Defining the layout as data
// rather than as inline sheet calls is what keeps those two from being separate copies that
// drift — a subtotal formula changed in one and not the other would show up as a single wrong
// column in a fifty-column sheet, which is exactly the kind of thing nobody notices.
//
//   leaf    -> pull `name` from the trial balance, sign-flipped for display
//   group   -> header whose amount is SUM over its members' rows; `membersFirst` puts the
//              header after its members (the Balance Sheet's convention, unlike the P&L's)
//   calc    -> amount is fn(rowOf, col, ctx) -> formula fragment
//   section -> a bare label with no amount

const leaf = (label, level = 0, name = null, positiveOverride = false) => ({
  kind: "leaf", label, level, name: name || label, positiveOverride, bold: false,
});
const calc = (label, fn, bold = true, level = 0) => ({ kind: "calc", label, level, fn, bold });
const group = (label, members, membersFirst = false) => ({
  kind: "group", label, level: 0, members, membersFirst, bold: true,
});
const section = (label) => ({ kind: "section", label, level: 0, bold: true });

function expand(layout) {
  const rows = [];
  for (const spec of layout) {
    if (spec.kind !== "group") {
      rows.push(spec);
      continue;
    }
    const members = spec.members.map((m) => leaf(m, 1));
    rows.push(...(spec.membersFirst ? [...members, spec] : [spec, ...members]));
  }
  return rows;
}

function plLayout() {
  const opexMembers = [
    "Staff and Staff related Costs", "Marketing Expenses", "Sales Expenses", "Utlities",
    "Profit/Loss Sharing", "Rent Expense", "Depreciation", "Consumables",
    "Maintenance Expenses", "Taxes, Licenses & Permits", "Other Expenses", "Travel Expenses",
  ];
  return expand([
    leaf("Sales", 1),
    calc("Total Sales", (R, C) => `${C}${R["Sales"]}`),
    leaf("Sales Discount/Return", 1),
    calc("Net Sales", (R, C) => `${C}${R["Total Sales"]}-${C}${R["Sales Discount/Return"]}`),

    leaf("COGS before Direct Cost & Forex Gain/Loss", 1),
    leaf("Direct Income", 1),
    leaf("Direct Costs", 1),
    calc("Total Cost of Goods Sold",
      (R, C) => `${C}${R["COGS before Direct Cost & Forex Gain/Loss"]}+${C}${R["Direct Costs"]}-${C}${R["Direct Income"]}`),
    calc("Gross Profit", (R, C) => `${C}${R["Net Sales"]}-${C}${R["Total Cost of Goods Sold"]}`),

    group("Staff and Staff related Costs", ["Salaries & Wages", "Bonus & Incentives", "Commission", "Staff Insurance", "Staff Welfare"]),
    group("Marketing Expenses", ["Advertising Expense", "Entertainment"]),
    group("Sales Expenses", ["Freight, Storage & Handling", "Sales Fees", "Packaging and Labeling"]),
    group("Utlities", ["Telephone Expense", "Electricity Expense"]),
    leaf("Profit/Loss Sharing"),
    leaf("Rent Expense"),
    leaf("Depreciation"),
    group("Consumables", ["Printing & Stationery", "Pantry Expenses"]),
    group("Maintenance Expenses", ["Repairs & Maintenance", "Security Expense"]),
    leaf("Taxes, Licenses & Permits"),
    group("Other Expenses", [
      "Sample Expenses", "Interest Expense", "Interest on  Shareholder loan", "Warehouse Expense",
      "Consulting & Professional Fee", "General Insurance Expense", "Postage & Courier Expenses",
      "Tax Expenses", "Transport Expense", "Office Expenses", "Modern Market Trading Terms",
      "Stock Write Off", "Bad Debts",
    ]),
    group("Travel Expenses", ["Travel Expense - International", "Travel Expense - Domestic"]),

    calc("Operating Expenses", (R, C) => opexMembers.map((m) => `${C}${R[m]}`).join("+")),
    calc("Operative Profit/(Loss)", (R, C) => `${C}${R["Gross Profit"]}-${C}${R["Operating Expenses"]}`),

    group("Miscellaneous Expenses", ["Misc. Expense", "Bank Charges", "Foreign Exchange (Gain) Loss"]),
    group("Miscellaneous Incomes", ["Other Income", "Other Income - CPCI Income"]),
    calc("Total Non Operating Expenses/(Income)",
      (R, C) => `${C}${R["Miscellaneous Expenses"]}-${C}${R["Miscellaneous Incomes"]}`),
    calc("Net Income/(Loss) Before Tax & Previous Year Expenses",
      (R, C) => `${C}${R["Operative Profit/(Loss)"]}-${C}${R["Total Non Operating Expenses/(Income)"]}`),

    group("Extraordinary / Previous Year Expenses", [
      "Tax Expenses - Prev Years", "Credit Note - Prev. Years", "Previous Year Rent Expenses",
      "Previous Year Commissions", "Corporate Tax",
    ]),
    calc("Net Income/(Loss) After Tax & Previous Year Expenses",
      (R, C) => `${C}${R["Net Income/(Loss) Before Tax & Previous Year Expenses"]}-${C}${R["Extraordinary / Previous Year Expenses"]}`),

    calc("Net Income Before Depreciation",
      (R, C) => `${C}${R["Net Income/(Loss) After Tax & Previous Year Expenses"]}+${C}${R["Depreciation"]}`),
    calc("Net Profit without interest on bank loan",
      (R, C) => `${C}${R["Net Income/(Loss) After Tax & Previous Year Expenses"]}+${C}${R["Interest Expense"]}`),
    calc("Net Profit without interest on shareholder loan",
      (R, C) => `${C}${R["Net Income/(Loss) After Tax & Previous Year Expenses"]}+${C}${R["Interest on  Shareholder loan"]}`),
  ]);
}

function bsLayout() {
  return expand([
    section("CURRENT ASSETS"),
    group("Total Current Assets", [
      "Cash & Cash Equivalent", "Accounts Receivable", "Inventory", "Prepaid Taxes",
      "Prepaid Expenses", "Short Term Deposits", "Other Receivables",
    ], true),

    section("NON CURRENT ASSETS"),
    leaf("Fixed Assets", 1),
    // Displayed as the raw (already-negative) balance — a contra-asset — so Net Fixed Assets
    // below is a plain addition, not a subtraction.
    leaf("Accumulated Depreciation", 1, null, true),
    calc("Net Fixed Assets", (R, C) => `${C}${R["Fixed Assets"]}+${C}${R["Accumulated Depreciation"]}`),
    leaf("Other Non-current Asset"),
    calc("Total Non-Current Assets", (R, C) => `${C}${R["Net Fixed Assets"]}+${C}${R["Other Non-current Asset"]}`),
    calc("TOTAL ASSETS", (R, C) => `${C}${R["Total Current Assets"]}+${C}${R["Total Non-Current Assets"]}`),

    section("LIABILITIES AND EQUITY"),
    section("LIABILITIES"),
    group("Total Short Term Liabilities", [
      "Accounts Payable", "Taxes Payable", "Accrued Expenses", "Loans & Advances taken",
      "Interco Balances", "Other Payables",
    ], true),

    section("EQUITY"),
    leaf("Share Capital", 1),
    // Retained Earnings = brought-forward P&L ledger balance + this period's P&L result,
    // cross-referenced straight from the P&L sheet. ctx supplies the reference because it
    // points at a different sheet and column for BS_Current than for BS_Comparative.
    calc("Retained Earnings", (R, C, X) => `(${X.reLeaf})+${X.plNetIncome(C)}`, false, 1),
    calc("Total Equity", (R, C) => `${C}${R["Share Capital"]}+${C}${R["Retained Earnings"]}`),
    calc("TOTAL LIABILITIES AND EQUITY", (R, C) => `${C}${R["Total Short Term Liabilities"]}+${C}${R["Total Equity"]}`),
    calc("Check", (R, C) => `${C}${R["TOTAL LIABILITIES AND EQUITY"]}-${C}${R["TOTAL ASSETS"]}`),
  ]);
}

// Write the row labels down column A; returns {label: sheet row}. Rows are identical across
// every amount column, so this runs once per sheet.
function placeLabels(ws, rows) {
  const rowOf = {};
  for (const spec of rows) {
    ws.addRow([`${"    ".repeat(spec.level)}${spec.label}`]);
    const r = ws.rowCount;
    if (spec.bold) ws.getRow(r).getCell(1).font = BOLD;
    rowOf[spec.label] = r;
  }
  return rowOf;
}

// Write one amount column's formulas. `ref(name, positiveOverride)` returns the leaf reference
// fragment, which is the only thing that differs between a single-period sheet and one
// comparative column.
function fillColumn(ws, rows, rowOf, colIndex, ref, ctx = {}) {
  const col = colLetter(colIndex);
  for (const spec of rows) {
    if (spec.kind === "section") continue;
    const r = rowOf[spec.label];
    let formula;
    if (spec.kind === "leaf") {
      formula = ref(spec.name, spec.positiveOverride);
    } else if (spec.kind === "group") {
      formula = `SUM(${col}${rowOf[spec.members[0]]}:${col}${rowOf[spec.members[spec.members.length - 1]]})`;
    } else {
      formula = spec.fn(rowOf, col, ctx);
    }
    const cell = ws.getRow(r).getCell(colIndex);
    cell.value = { formula };
    cell.numFmt = IDR_FORMAT;
    if (spec.bold) cell.font = BOLD;
  }
}

function writePlSheet(wb, nameToLeaf, codeRow) {
  const ws = wb.addWorksheet("PL_Current");
  ws.addRow(["Line Item", "Amount (IDR)", "% of Net Sales"]);
  ws.getRow(1).eachCell((c) => (c.font = BOLD));
  ws.views = [{ state: "frozen", ySplit: 1 }];

  const rows = plLayout();
  const rowOf = placeLabels(ws, rows);
  fillColumn(ws, rows, rowOf, 2, (name, pos) => leafRef(name, nameToLeaf, codeRow, pos));

  const netSalesRow = rowOf["Net Sales"];
  for (const r of Object.values(rowOf)) {
    const cell = ws.getRow(r).getCell(3);
    cell.value = { formula: `B${r}/$B$${netSalesRow}` };
    cell.numFmt = "0.0%";
  }

  setColWidths(ws, [55, 20, 15]);
  return rowOf["Net Income/(Loss) After Tax & Previous Year Expenses"];
}

function writeBsSheet(wb, nameToLeaf, codeRow, plNetIncomeRow) {
  const ws = wb.addWorksheet("BS_Current");
  ws.addRow(["Line Item", "Amount (IDR)"]);
  ws.getRow(1).eachCell((c) => (c.font = BOLD));
  ws.views = [{ state: "frozen", ySplit: 1 }];

  const rows = bsLayout();
  const rowOf = placeLabels(ws, rows);
  const ref = (name, pos) => leafRef(name, nameToLeaf, codeRow, pos);
  fillColumn(ws, rows, rowOf, 2, ref, {
    reLeaf: ref("Retained Earnings", false),
    plNetIncome: () => `'PL_Current'!B${plNetIncomeRow}`,
  });

  setColWidths(ws, [55, 20]);
}

// --- Comparative sheets ----------------------------------------------------------------------

const MONTH_ABBR = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (year, month) => `${MONTH_ABBR[month]}'${String(year).slice(2)}`;

// Conso_TB_By_Period: one column per month of the current and prior year, plus the two
// year-to-date columns, for every leaf category.
//
// This is the base layer the comparative statements reference, playing the same role for
// months that the Entity_<CODE> sheets play for entities. Months are laid out as two
// contiguous year blocks rather than interleaved pairs so each YTD column is a single SUM over
// a range — traceable in one click, instead of twelve cells added together.
//
// The anchor month's column is a formula into Conso_TB_Total rather than a written value, so
// the comparative sheets and PL_Current/BS_Current cannot show different numbers for the same
// month. Every other month is written as data: there is no per-month entity sheet to
// reference, exactly as the Adjustments column has no Entity_ADJ sheet to reference.
//
// A month with nothing consolidated is left genuinely empty, not zero — the comparative sheets
// then leave that column blank rather than asserting the business did no trade.
function writeByPeriodSheet(wb, coaLeaves, codeRow, context) {
  const ws = wb.addWorksheet("Conso_TB_By_Period");
  const months = comparative.fiscalMonths();
  const currentYear = context.anchorYear;
  const priorYear = context.anchorYear - 1;

  const firstDataCol = 4;
  const colOf = {};
  const header = ["Account Code", "Account Name", "Section"];
  [currentYear, priorYear].forEach((year, offset) => {
    months.forEach((m, i) => {
      colOf[comparative.monthKey(year, m)] = firstDataCol + offset * months.length + i;
      header.push(monthLabel(year, m));
    });
  });
  const ytdCurrentCol = firstDataCol + 2 * months.length;
  const ytdPriorCol = ytdCurrentCol + 1;
  header.push(`YTD ${monthLabel(currentYear, context.anchorMonth)}`);
  header.push(`YTD ${monthLabel(priorYear, context.anchorMonth)}`);
  ws.addRow(header);
  ws.getRow(1).eachCell((c) => (c.font = BOLD));
  ws.views = [{ state: "frozen", xSplit: 3, ySplit: 1 }];

  const monthly = new Map();
  for (const year of [currentYear, priorYear]) {
    for (const m of months) monthly.set(comparative.monthKey(year, m), comparative.totalsForMonth(year, m));
  }
  const hasData = new Set([...monthly].filter(([, v]) => v !== null && v !== undefined).map(([k]) => k));

  const anchorKey = context.anchorKey;
  const ytdCurrentLast = colLetter(colOf[comparative.monthKey(currentYear, context.anchorMonth)]);
  const ytdPriorLast = colLetter(colOf[comparative.monthKey(priorYear, context.anchorMonth)]);
  const firstColLetter = colLetter(firstDataCol);
  const priorFirstColLetter = colLetter(firstDataCol + months.length);

  const rowOf = {};
  for (const lf of coaLeaves) {
    ws.addRow([lf.account_code, lf.account_name, lf.section]);
    const r = ws.rowCount;
    rowOf[lf.account_code] = r;
    for (const [key, totals] of monthly) {
      if (!totals) continue;
      const cell = ws.getRow(r).getCell(colOf[key]);
      if (key === anchorKey) {
        cell.value = { formula: `'Conso_TB_Total'!E${codeRow[lf.account_code]}` };
      } else {
        const entry = totals.get(lf.account_name);
        cell.value = entry ? entry[0] : 0.0;
      }
      cell.numFmt = IDR_FORMAT;
    }
    const ytdCurrent = ws.getRow(r).getCell(ytdCurrentCol);
    ytdCurrent.value = { formula: `SUM(${firstColLetter}${r}:${ytdCurrentLast}${r})` };
    ytdCurrent.numFmt = IDR_FORMAT;
    const ytdPrior = ws.getRow(r).getCell(ytdPriorCol);
    ytdPrior.value = { formula: `SUM(${priorFirstColLetter}${r}:${ytdPriorLast}${r})` };
    ytdPrior.numFmt = IDR_FORMAT;
  }

  setColWidths(ws, [12, 40, 20, ...new Array(2 * months.length + 2).fill(15)]);

  return {
    row: rowOf,
    col: colOf,
    ytdCurrent: ytdCurrentCol,
    ytdPrior: ytdPriorCol,
    hasData,
    months,
    currentYear,
    priorYear,
  };
}

// Leaf reference into one column of Conso_TB_By_Period, with the same Dr-positive ->
// display-magnitude sign flip that leafRef applies for the single-period sheets.
function byPeriodRef(name, nameToLeaf, byPeriod, colIndex, positiveOverride = false) {
  const info = nameToLeaf[name];
  const ref = `'Conso_TB_By_Period'!${colLetter(colIndex)}${byPeriod.row[info.account_code]}`;
  const negate = info.normal_balance === "CR" && !positiveOverride;
  return negate ? `-${ref}` : ref;
}

// The column plan: YTD pair first (P&L only), then each month of the year immediately followed
// by the same month a year earlier, exactly as the reference workbook orders them.
//
// Every month gets a column whether or not it has data, so the sheet's shape matches the
// template and stays stable as history is loaded; columns without data are left blank.
function comparativeColumns(byPeriod, context, includeYtd) {
  const plan = [];
  if (includeYtd) {
    plan.push({
      key: comparative.YTD_CURRENT, source: byPeriod.ytdCurrent,
      label: `YTD ${monthLabel(byPeriod.currentYear, context.anchorMonth)}`,
      hasData: byPeriod.months.some((m) => byPeriod.hasData.has(comparative.monthKey(byPeriod.currentYear, m))),
    });
    plan.push({
      key: comparative.YTD_PRIOR, source: byPeriod.ytdPrior,
      label: `YTD ${monthLabel(byPeriod.priorYear, context.anchorMonth)}`,
      hasData: byPeriod.months.some((m) => byPeriod.hasData.has(comparative.monthKey(byPeriod.priorYear, m))),
    });
  }
  for (const m of byPeriod.months) {
    for (const year of [byPeriod.currentYear, byPeriod.priorYear]) {
      const key = comparative.monthKey(year, m);
      plan.push({ key, source: byPeriod.col[key], label: monthLabel(year, m), hasData: byPeriod.hasData.has(key) });
    }
  }
  return plan;
}

// PL_Comparative: the same P&L rows as PL_Current, one amount-and-% column pair per period.
// Built from the shared layout, so a subtotal formula cannot differ between the two sheets.
function writePlComparativeSheet(wb, nameToLeaf, byPeriod, context) {
  const ws = wb.addWorksheet("PL_Comparative");
  const plan = comparativeColumns(byPeriod, context, true);

  const header = ["Line Item"];
  const subhead = [""];
  for (const column of plan) {
    header.push(column.label, "");
    subhead.push("IDR", "%");
  }
  ws.addRow(header);
  ws.addRow(subhead);
  ws.getRow(1).eachCell((c) => (c.font = BOLD));
  ws.getRow(2).eachCell((c) => (c.font = BOLD));
  ws.views = [{ state: "frozen", xSplit: 1, ySplit: 2 }];

  const rows = plLayout();
  const rowOf = placeLabels(ws, rows);
  const widths = [55];

  plan.forEach((column, i) => {
    const amountCol = 2 + i * 2;
    widths.push(17, 9);
    // A period with nothing consolidated gets no formulas at all. Pointing the leaves at empty
    // cells would render it as a column of zeros, which reads as "we traded nothing" rather
    // than "this month has not been loaded".
    if (!column.hasData) return;
    fillColumn(ws, rows, rowOf, amountCol, (name, pos) => byPeriodRef(name, nameToLeaf, byPeriod, column.source, pos));
    const letter = colLetter(amountCol);
    for (const r of Object.values(rowOf)) {
      const cell = ws.getRow(r).getCell(amountCol + 1);
      cell.value = { formula: `${letter}${r}/${letter}$${rowOf["Net Sales"]}` };
      cell.numFmt = "0.0%";
    }
  });

  setColWidths(ws, widths);
  return rowOf["Net Income/(Loss) After Tax & Previous Year Expenses"];
}

// BS_Comparative: paired month-end positions, no year-to-date columns — a balance sheet is a
// point in time and summing one across months is meaningless.
//
// Each column's Retained Earnings picks up that month's own net income from the matching
// PL_Comparative column, mirroring how BS_Current cross-references PL_Current.
function writeBsComparativeSheet(wb, nameToLeaf, byPeriod, context, plComparativeNetIncomeRow) {
  const ws = wb.addWorksheet("BS_Comparative");
  const plan = comparativeColumns(byPeriod, context, false);
  const plPlan = comparativeColumns(byPeriod, context, true);
  const plColOf = {};
  plPlan.forEach((c, i) => (plColOf[c.key] = colLetter(2 + i * 2)));

  ws.addRow(["Line Item", ...plan.map((c) => c.label)]);
  ws.getRow(1).eachCell((c) => (c.font = BOLD));
  ws.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];

  const rows = bsLayout();
  const rowOf = placeLabels(ws, rows);

  plan.forEach((column, i) => {
    if (!column.hasData) return;
    const ref = (name, pos) => byPeriodRef(name, nameToLeaf, byPeriod, column.source, pos);
    fillColumn(ws, rows, rowOf, 2 + i, ref, {
      reLeaf: ref("Retained Earnings", false),
      plNetIncome: () => `'PL_Comparative'!${plColOf[column.key]}${plComparativeNetIncomeRow}`,
    });
  });

  setColWidths(ws, [55, ...new Array(plan.length).fill(17)]);
}

function writeAdjustmentsSheet(wb, periodId) {
  const ws = wb.addWorksheet("Adjustments");
  ws.addRow(["Adjustment Ref", "Type", "Narration", "Entity", "Category", "Debit", "Credit", "Line Narration", "Status", "Copied From"]);
  ws.getRow(1).eachCell((c) => (c.font = BOLD));
  ws.views = [{ state: "frozen", ySplit: 1 }];
  for (const adj of adjustmentRepo.listForPeriod(periodId)) {
    let copiedFrom = null;
    if (adj.copied_from_period_id) {
      const p = persistence.get("SELECT * FROM periods WHERE period_id = ?", [adj.copied_from_period_id]);
      copiedFrom = p ? `${p.year}-${String(p.month).padStart(2, "0")}` : null;
    }
    for (const line of adjustmentRepo.getLines(adj.adjustment_id)) {
      let entityCode = "";
      if (line.entity_id) {
        const e = persistence.get("SELECT entity_code FROM entities WHERE entity_id = ?", [line.entity_id]);
        entityCode = e ? e.entity_code : "";
      }
      const category = groupCoaRepo.getById(line.group_account_id);
      ws.addRow([
        adj.external_ref, adj.adjustment_type, adj.narration, entityCode,
        category ? category.account_name : "",
        line.debit_amount || null, line.credit_amount || null,
        line.line_narration, adj.status, copiedFrom,
      ]);
      ws.getRow(ws.rowCount).getCell(6).numFmt = IDR_FORMAT;
      ws.getRow(ws.rowCount).getCell(7).numFmt = IDR_FORMAT;
    }
  }
  setColWidths(ws, [16, 18, 45, 10, 40, 16, 16, 30, 10, 14]);
}

function writeAdjBridgeSheet(wb, periodId) {
  const ws = wb.addWorksheet("Adj_Bridge");
  ws.addRow(["Account Code", "Account Name", "TB Before Adjustments", "Adjustment Impact", "TB After (Total)"]);
  ws.getRow(1).eachCell((c) => (c.font = BOLD));
  ws.views = [{ state: "frozen", ySplit: 1 }];
  const rows = persistence.all(
    `SELECT gc.account_code, gc.account_name, gc.line_item_order,
            SUM(CASE WHEN ctb.source_type = 'entity_tb' THEN ctb.closing_dr - ctb.closing_cr ELSE 0 END) AS before_adj,
            SUM(CASE WHEN ctb.source_type = 'adjustment' THEN ctb.closing_dr - ctb.closing_cr ELSE 0 END) AS adj_impact,
            SUM(CASE WHEN ctb.source_type = 'total' THEN ctb.closing_dr - ctb.closing_cr ELSE 0 END) AS after_total
       FROM consolidated_tb ctb
       JOIN group_coa gc ON gc.group_account_id = ctb.group_account_id
      WHERE ctb.period_id = ?
      GROUP BY ctb.group_account_id
     HAVING adj_impact != 0
      ORDER BY gc.line_item_order`,
    [periodId]
  );
  for (const r of rows) {
    ws.addRow([r.account_code, r.account_name, r.before_adj, r.adj_impact, r.after_total]);
    [3, 4, 5].forEach((col) => (ws.getRow(ws.rowCount).getCell(col).numFmt = IDR_FORMAT));
  }
  setColWidths(ws, [12, 40, 20, 18, 18]);
}

function writeAuditLogSheet(wb) {
  const ws = wb.addWorksheet("Audit_Log");
  ws.addRow(["Timestamp", "User", "Action", "Table", "Record ID", "Old Value", "New Value"]);
  ws.getRow(1).eachCell((c) => (c.font = BOLD));
  ws.views = [{ state: "frozen", ySplit: 1 }];
  const rows = persistence.all("SELECT * FROM audit_log ORDER BY log_id DESC LIMIT 2000");
  for (const r of rows) {
    ws.addRow([r.timestamp, r.user, r.action, r.table_name, r.record_id, r.old_value, r.new_value]);
  }
  setColWidths(ws, [24, 16, 12, 22, 12, 30, 30]);
}

function colLetter(n) {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function buildExportPack(periodId) {
  const period = persistence.get("SELECT * FROM periods WHERE period_id = ?", [periodId]);
  const periodLabel = `${period.year}-${String(period.month).padStart(2, "0")}`;
  const validations = runAll(periodId);

  const entities = entityRepo.listAll();
  const coaRows = groupCoaRepo.listAll();
  const coaLeaves = groupCoaRepo.listLeafCategories();
  const nameToLeaf = {};
  for (const r of coaLeaves) nameToLeaf[r.account_name] = r;

  const wb = new ExcelJS.Workbook();
  writeSummary(wb, periodId, periodLabel, validations);
  const entityRow = writeEntitySheets(wb, periodId);
  const codeRow = writeMatrixAndTotal(wb, periodId, coaRows, entities, entityRow);
  const netIncomeRow = writePlSheet(wb, nameToLeaf, codeRow);
  writeBsSheet(wb, nameToLeaf, codeRow, netIncomeRow);

  const context = comparative.resolveComparativePeriods(periodId);
  const byPeriod = writeByPeriodSheet(wb, coaLeaves, codeRow, context);
  const comparativeNetIncomeRow = writePlComparativeSheet(wb, nameToLeaf, byPeriod, context);
  writeBsComparativeSheet(wb, nameToLeaf, byPeriod, context, comparativeNetIncomeRow);

  writeAdjustmentsSheet(wb, periodId);
  writeAdjBridgeSheet(wb, periodId);
  writeMappingSheet(wb, periodId);
  writeValidationSheet(wb, validations);
  writeAuditLogSheet(wb);

  return { workbook: wb, periodLabel };
}

export async function downloadExportPack(periodId) {
  const { workbook, periodLabel } = buildExportPack(periodId);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Consolidated Pack ${periodLabel}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
