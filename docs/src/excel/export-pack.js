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
import { persistence } from "../db/persistence.js";
import * as entityRepo from "../db/entity-repo.js";
import * as groupCoaRepo from "../db/group-coa-repo.js";
import * as consolidatedRepo from "../db/consolidated-repo.js";
import * as mappingRepo from "../db/mapping-repo.js";
import * as adjustmentRepo from "../db/adjustment-repo.js";
import { runAll } from "../engines/validation.js";
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

function writePlSheet(wb, nameToLeaf, codeRow) {
  const ws = wb.addWorksheet("PL_Current");
  ws.addRow(["Line Item", "Amount (IDR)", "% of Net Sales"]);
  ws.getRow(1).eachCell((c) => (c.font = BOLD));
  ws.views = [{ state: "frozen", ySplit: 1 }];
  const rowOf = {};

  const ref = (name, positiveOverride = false) => leafRef(name, nameToLeaf, codeRow, positiveOverride);

  function w(label, formula, level = 0, bold = false) {
    const indent = "    ".repeat(level);
    ws.addRow([`${indent}${label}`, formula ? { formula } : null]);
    const r = ws.rowCount;
    ws.getRow(r).getCell(2).numFmt = IDR_FORMAT;
    if (bold) {
      ws.getRow(r).getCell(1).font = BOLD;
      ws.getRow(r).getCell(2).font = BOLD;
    }
    rowOf[label] = r;
    return r;
  }

  function group(header, members) {
    const rHeader = w(header, null, 0, true);
    for (const m of members) w(m, ref(m), 1);
    const first = rowOf[members[0]];
    const last = rowOf[members[members.length - 1]];
    ws.getRow(rHeader).getCell(2).value = { formula: `SUM(B${first}:B${last})` };
    return header;
  }

  w("Sales", ref("Sales"), 1);
  w("Total Sales", `B${rowOf["Sales"]}`, 0, true);
  w("Sales Discount/Return", ref("Sales Discount/Return"), 1);
  w("Net Sales", `B${rowOf["Total Sales"]}-B${rowOf["Sales Discount/Return"]}`, 0, true);

  w("COGS before Direct Cost & Forex Gain/Loss", ref("COGS before Direct Cost & Forex Gain/Loss"), 1);
  w("Direct Income", ref("Direct Income"), 1);
  w("Direct Costs", ref("Direct Costs"), 1);
  w(
    "Total Cost of Goods Sold",
    `B${rowOf["COGS before Direct Cost & Forex Gain/Loss"]}+B${rowOf["Direct Costs"]}-B${rowOf["Direct Income"]}`,
    0,
    true
  );

  w("Gross Profit", `B${rowOf["Net Sales"]}-B${rowOf["Total Cost of Goods Sold"]}`, 0, true);

  group("Staff and Staff related Costs", ["Salaries & Wages", "Bonus & Incentives", "Commission", "Staff Insurance", "Staff Welfare"]);
  group("Marketing Expenses", ["Advertising Expense", "Entertainment"]);
  group("Sales Expenses", ["Freight, Storage & Handling", "Sales Fees", "Packaging and Labeling"]);
  group("Utlities", ["Telephone Expense", "Electricity Expense"]);
  w("Profit/Loss Sharing", ref("Profit/Loss Sharing"), 0);
  w("Rent Expense", ref("Rent Expense"), 0);
  w("Depreciation", ref("Depreciation"), 0);
  group("Consumables", ["Printing & Stationery", "Pantry Expenses"]);
  group("Maintenance Expenses", ["Repairs & Maintenance", "Security Expense"]);
  w("Taxes, Licenses & Permits", ref("Taxes, Licenses & Permits"), 0);
  group("Other Expenses", [
    "Sample Expenses", "Interest Expense", "Interest on  Shareholder loan", "Warehouse Expense",
    "Consulting & Professional Fee", "General Insurance Expense", "Postage & Courier Expenses",
    "Tax Expenses", "Transport Expense", "Office Expenses", "Modern Market Trading Terms",
    "Stock Write Off", "Bad Debts",
  ]);
  group("Travel Expenses", ["Travel Expense - International", "Travel Expense - Domestic"]);

  const opexMembers = [
    "Staff and Staff related Costs", "Marketing Expenses", "Sales Expenses", "Utlities",
    "Profit/Loss Sharing", "Rent Expense", "Depreciation", "Consumables",
    "Maintenance Expenses", "Taxes, Licenses & Permits", "Other Expenses", "Travel Expenses",
  ];
  const opexFormula = opexMembers.map((m) => `B${rowOf[m]}`).join("+");
  w("Operating Expenses", opexFormula, 0, true);

  w("Operative Profit/(Loss)", `B${rowOf["Gross Profit"]}-B${rowOf["Operating Expenses"]}`, 0, true);

  group("Miscellaneous Expenses", ["Misc. Expense", "Bank Charges", "Foreign Exchange (Gain) Loss"]);
  group("Miscellaneous Incomes", ["Other Income", "Other Income - CPCI Income"]);
  w("Total Non Operating Expenses/(Income)", `B${rowOf["Miscellaneous Expenses"]}-B${rowOf["Miscellaneous Incomes"]}`, 0, true);

  w(
    "Net Income/(Loss) Before Tax & Previous Year Expenses",
    `B${rowOf["Operative Profit/(Loss)"]}-B${rowOf["Total Non Operating Expenses/(Income)"]}`,
    0,
    true
  );

  group("Extraordinary / Previous Year Expenses", [
    "Tax Expenses - Prev Years", "Credit Note - Prev. Years", "Previous Year Rent Expenses",
    "Previous Year Commissions", "Corporate Tax",
  ]);
  w(
    "Net Income/(Loss) After Tax & Previous Year Expenses",
    `B${rowOf["Net Income/(Loss) Before Tax & Previous Year Expenses"]}-B${rowOf["Extraordinary / Previous Year Expenses"]}`,
    0,
    true
  );

  const netIncomeRow = rowOf["Net Income/(Loss) After Tax & Previous Year Expenses"];
  w("Net Income Before Depreciation", `B${netIncomeRow}+B${rowOf["Depreciation"]}`, 0, true);
  w("Net Profit without interest on bank loan", `B${netIncomeRow}+B${rowOf["Interest Expense"]}`, 0, true);
  w("Net Profit without interest on shareholder loan", `B${netIncomeRow}+B${rowOf["Interest on  Shareholder loan"]}`, 0, true);

  const netSalesRow = rowOf["Net Sales"];
  for (const r of Object.values(rowOf)) {
    const cell = ws.getRow(r).getCell(3);
    cell.value = { formula: `B${r}/$B$${netSalesRow}` };
    cell.numFmt = "0.0%";
  }

  setColWidths(ws, [55, 20, 15]);

  return netIncomeRow;
}

function writeBsSheet(wb, nameToLeaf, codeRow, plNetIncomeRow) {
  const ws = wb.addWorksheet("BS_Current");
  ws.addRow(["Line Item", "Amount (IDR)"]);
  ws.getRow(1).eachCell((c) => (c.font = BOLD));
  ws.views = [{ state: "frozen", ySplit: 1 }];
  const rowOf = {};

  const ref = (name, positiveOverride = false) => leafRef(name, nameToLeaf, codeRow, positiveOverride);

  function w(label, formula, level = 0, bold = false, section = false) {
    if (section) {
      ws.addRow([label]);
      ws.getRow(ws.rowCount).eachCell((c) => (c.font = BOLD));
      rowOf[label] = ws.rowCount;
      return ws.rowCount;
    }
    const indent = "    ".repeat(level);
    ws.addRow([`${indent}${label}`, formula ? { formula } : null]);
    const r = ws.rowCount;
    ws.getRow(r).getCell(2).numFmt = IDR_FORMAT;
    if (bold) {
      ws.getRow(r).getCell(1).font = BOLD;
      ws.getRow(r).getCell(2).font = BOLD;
    }
    rowOf[label] = r;
    return r;
  }

  function group(header, members) {
    let firstRow = null;
    members.forEach((m, i) => {
      const r = w(m, ref(m), 1);
      if (i === 0) firstRow = r;
    });
    const lastRow = rowOf[members[members.length - 1]];
    w(header, `SUM(B${firstRow}:B${lastRow})`, 0, true);
    return header;
  }

  w("CURRENT ASSETS", null, 0, false, true);
  group("Total Current Assets", [
    "Cash & Cash Equivalent", "Accounts Receivable", "Inventory", "Prepaid Taxes",
    "Prepaid Expenses", "Short Term Deposits", "Other Receivables",
  ]);

  w("NON CURRENT ASSETS", null, 0, false, true);
  w("Fixed Assets", ref("Fixed Assets"), 1);
  // Displayed as the raw (already-negative) balance — a contra-asset — so Net Fixed Assets
  // below is a plain addition, not a subtraction.
  w("Accumulated Depreciation", ref("Accumulated Depreciation", true), 1);
  w("Net Fixed Assets", `B${rowOf["Fixed Assets"]}+B${rowOf["Accumulated Depreciation"]}`, 0, true);
  w("Other Non-current Asset", ref("Other Non-current Asset"), 0);
  w("Total Non-Current Assets", `B${rowOf["Net Fixed Assets"]}+B${rowOf["Other Non-current Asset"]}`, 0, true);

  w("TOTAL ASSETS", `B${rowOf["Total Current Assets"]}+B${rowOf["Total Non-Current Assets"]}`, 0, true);

  w("LIABILITIES AND EQUITY", null, 0, false, true);
  w("LIABILITIES", null, 0, false, true);
  group("Total Short Term Liabilities", [
    "Accounts Payable", "Taxes Payable", "Accrued Expenses", "Loans & Advances taken",
    "Interco Balances", "Other Payables",
  ]);

  w("EQUITY", null, 0, false, true);
  w("Share Capital", ref("Share Capital"), 1);
  // Retained Earnings = brought-forward P&L ledger balance (Conso_TB_Total) + this period's
  // P&L result, cross-referenced straight from PL_Current.
  w("Retained Earnings", `(${ref("Retained Earnings")})+'PL_Current'!B${plNetIncomeRow}`, 1);
  w("Total Equity", `B${rowOf["Share Capital"]}+B${rowOf["Retained Earnings"]}`, 0, true);

  w("TOTAL LIABILITIES AND EQUITY", `B${rowOf["Total Short Term Liabilities"]}+B${rowOf["Total Equity"]}`, 0, true);

  w("Check", `B${rowOf["TOTAL LIABILITIES AND EQUITY"]}-B${rowOf["TOTAL ASSETS"]}`, 0, true);

  setColWidths(ws, [55, 20]);
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
