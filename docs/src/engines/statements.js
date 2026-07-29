// Port of src/engines/statement_generator.py — computes the P&L and Balance Sheet from the
// consolidated TB, matching the exact line-item structure of the user's real template.
//
// Sign convention: consolidated_tb stores signed closing balances as (closing_dr - closing_cr)
// — "Dr positive". For statement *display*, every leaf is converted to its own natural
// positive-magnitude direction using group_coa.normal_balance (a Dr-normal leaf displays
// as-is; a Cr-normal leaf is negated). Subtotal rows are NOT a generic sum of that display
// value — each is computed via the explicit formula relationship the real template uses.
//
// Retained Earnings on the BS face is a single line combining the brought-forward P&L
// ledger balance *and* the current period's P&L result — not two separate BS lines,
// replicating the real template's Schedule 15.
import { persistence } from "../db/persistence.js";

// account_name -> [Dr-positive signed closing balance, normal_balance]
function totalsByAccountName(periodId) {
  const rows = persistence.all(
    `SELECT gc.account_name, gc.normal_balance,
            SUM(ctb.closing_dr) AS dr, SUM(ctb.closing_cr) AS cr
       FROM consolidated_tb ctb
       JOIN group_coa gc ON gc.group_account_id = ctb.group_account_id
      WHERE ctb.period_id = ? AND ctb.source_type = 'total'
      GROUP BY gc.account_name`,
    [periodId]
  );
  const map = new Map();
  for (const r of rows) map.set(r.account_name, [(r.dr || 0) - (r.cr || 0), r.normal_balance]);
  return map;
}

// kind: 'section' (bare label, no amount), 'leaf' (a mapped category), 'subtotal' (computed, bold)
function line(label, value, level = 0, kind = "leaf", percent = null) {
  return { label, value, level, kind, percent, isSubtotal: kind === "subtotal" };
}

function buildLeaf(totals) {
  return function leaf(name) {
    const entry = totals.get(name);
    if (!entry) return 0.0;
    const [signed, normalBalance] = entry;
    if (normalBalance === null || normalBalance === undefined) return 0.0;
    return normalBalance === "DR" ? signed : -signed;
  };
}

export function computePl(periodId) {
  const totals = totalsByAccountName(periodId);
  const leaf = buildLeaf(totals);
  const lines = [];
  const netSalesHolder = [1.0]; // filled in once Net Sales is known; guards divide-by-zero until then

  const pct = (value) => {
    const base = netSalesHolder[0];
    return base ? value / base : 0.0;
  };
  const add = (label, value, level = 0, kind = "leaf") => {
    lines.push(line(label, value, level, kind, value !== null ? pct(value) : null));
  };

  const totalSales = leaf("Sales");
  const salesDiscount = leaf("Sales Discount/Return");
  const netSales = totalSales - salesDiscount;
  netSalesHolder[0] = netSales || 1.0; // set before any add() so % is correct from the first row

  add("Sales", totalSales, 1);
  add("Total Sales", totalSales, 0, "subtotal");
  add("Sales Discount/Return", salesDiscount, 1);
  add("Net Sales", netSales, 0, "subtotal");

  const cogsBefore = leaf("COGS before Direct Cost & Forex Gain/Loss");
  const directIncome = leaf("Direct Income");
  const directCosts = leaf("Direct Costs");
  const totalCogs = cogsBefore + directCosts - directIncome;
  add("COGS before Direct Cost & Forex Gain/Loss", cogsBefore, 1);
  add("Direct Income", directIncome, 1);
  add("Direct Costs", directCosts, 1);
  add("Total Cost of Goods Sold", totalCogs, 0, "subtotal");

  const grossProfit = netSales - totalCogs;
  add("Gross Profit", grossProfit, 0, "subtotal");

  function group(header, members) {
    let total = 0.0;
    add(header, null, 0, "subtotal");
    const idx = lines.length - 1;
    for (const m of members) {
      const v = leaf(m);
      add(m, v, 1);
      total += v;
    }
    lines[idx].value = total;
    lines[idx].percent = pct(total);
    return total;
  }

  const staffCosts = group("Staff and Staff related Costs", [
    "Salaries & Wages", "Bonus & Incentives", "Commission", "Staff Insurance", "Staff Welfare",
  ]);
  const marketing = group("Marketing Expenses", ["Advertising Expense", "Entertainment"]);
  const salesExp = group("Sales Expenses", ["Freight, Storage & Handling", "Sales Fees", "Packaging and Labeling"]);
  const utilities = group("Utlities", ["Telephone Expense", "Electricity Expense"]);
  const plsharing = leaf("Profit/Loss Sharing");
  add("Profit/Loss Sharing", plsharing, 0);
  const rent = leaf("Rent Expense");
  add("Rent Expense", rent, 0);
  const depreciation = leaf("Depreciation");
  add("Depreciation", depreciation, 0);
  const consumables = group("Consumables", ["Printing & Stationery", "Pantry Expenses"]);
  const maintenance = group("Maintenance Expenses", ["Repairs & Maintenance", "Security Expense"]);
  const taxesLic = leaf("Taxes, Licenses & Permits");
  add("Taxes, Licenses & Permits", taxesLic, 0);
  const otherExp = group("Other Expenses", [
    "Sample Expenses", "Interest Expense", "Interest on  Shareholder loan", "Warehouse Expense",
    "Consulting & Professional Fee", "General Insurance Expense", "Postage & Courier Expenses",
    "Tax Expenses", "Transport Expense", "Office Expenses", "Modern Market Trading Terms",
    "Stock Write Off", "Bad Debts",
  ]);
  const travel = group("Travel Expenses", ["Travel Expense - International", "Travel Expense - Domestic"]);

  const operatingExpenses =
    staffCosts + marketing + salesExp + utilities + plsharing + rent + depreciation + consumables + maintenance + taxesLic + otherExp + travel;
  add("Operating Expenses", operatingExpenses, 0, "subtotal");

  const operativeProfit = grossProfit - operatingExpenses;
  add("Operative Profit/(Loss)", operativeProfit, 0, "subtotal");

  const miscExp = group("Miscellaneous Expenses", ["Misc. Expense", "Bank Charges", "Foreign Exchange (Gain) Loss"]);
  const miscInc = group("Miscellaneous Incomes", ["Other Income", "Other Income - CPCI Income"]);
  const totalNonop = miscExp - miscInc;
  add("Total Non Operating Expenses/(Income)", totalNonop, 0, "subtotal");

  const netIncomeBefore = operativeProfit - totalNonop;
  add("Net Income/(Loss) Before Tax & Previous Year Expenses", netIncomeBefore, 0, "subtotal");

  const extraordinary = group("Extraordinary / Previous Year Expenses", [
    "Tax Expenses - Prev Years", "Credit Note - Prev. Years", "Previous Year Rent Expenses",
    "Previous Year Commissions", "Corporate Tax",
  ]);
  const netIncomeAfter = netIncomeBefore - extraordinary;
  add("Net Income/(Loss) After Tax & Previous Year Expenses", netIncomeAfter, 0, "subtotal");

  add("Net Income Before Depreciation", netIncomeAfter + depreciation, 0, "subtotal");
  const interestExpense = leaf("Interest Expense");
  const interestShareholder = leaf("Interest on  Shareholder loan");
  add("Net Profit without interest on bank loan", netIncomeAfter + interestExpense, 0, "subtotal");
  add("Net Profit without interest on shareholder loan", netIncomeAfter + interestShareholder, 0, "subtotal");

  return { lines, netIncome: netIncomeAfter };
}

export function computeBs(periodId) {
  const totals = totalsByAccountName(periodId);
  const leaf = buildLeaf(totals);
  const lines = [];

  const { netIncome: currentYearPl } = computePl(periodId);

  // BS convention (unlike the P&L's): line items first, subtotal last.
  function group(header, members) {
    let total = 0.0;
    for (const m of members) {
      const v = leaf(m);
      lines.push(line(m, v, 1));
      total += v;
    }
    lines.push(line(header, total, 0, "subtotal"));
    return total;
  }

  lines.push(line("CURRENT ASSETS", null, 0, "section"));
  const totalCa = group("Total Current Assets", [
    "Cash & Cash Equivalent", "Accounts Receivable", "Inventory", "Prepaid Taxes",
    "Prepaid Expenses", "Short Term Deposits", "Other Receivables",
  ]);

  lines.push(line("NON CURRENT ASSETS", null, 0, "section"));
  const fixedAssets = leaf("Fixed Assets");
  const accDep = leaf("Accumulated Depreciation");
  const netFixed = fixedAssets - accDep;
  lines.push(line("Fixed Assets", fixedAssets, 1));
  // Displayed as negative (a contra-asset), matching the real template's convention —
  // Net Fixed Assets is unaffected, it's a display-only sign flip.
  lines.push(line("Accumulated Depreciation", -accDep, 1));
  lines.push(line("Net Fixed Assets", netFixed, 0, "subtotal"));
  const otherNca = leaf("Other Non-current Asset");
  lines.push(line("Other Non-current Asset", otherNca, 0));
  const totalNca = netFixed + otherNca;
  lines.push(line("Total Non-Current Assets", totalNca, 0, "subtotal"));

  const totalAssets = totalCa + totalNca;
  lines.push(line("TOTAL ASSETS", totalAssets, 0, "subtotal"));

  lines.push(line("LIABILITIES AND EQUITY", null, 0, "section"));
  lines.push(line("LIABILITIES", null, 0, "section"));
  const totalStl = group("Total Short Term Liabilities", [
    "Accounts Payable", "Taxes Payable", "Accrued Expenses", "Loans & Advances taken",
    "Interco Balances", "Other Payables",
  ]);

  lines.push(line("EQUITY", null, 0, "section"));
  const shareCapital = leaf("Share Capital");
  // Retained Earnings on the face of the statement is one line — brought-forward P&L
  // ledger balance plus this period's P&L result.
  const retainedEarningsBf = leaf("Retained Earnings");
  const retainedEarnings = retainedEarningsBf + currentYearPl;
  lines.push(line("Share Capital", shareCapital, 1));
  lines.push(line("Retained Earnings", retainedEarnings, 1));
  const totalEquity = shareCapital + retainedEarnings;
  lines.push(line("Total Equity", totalEquity, 0, "subtotal"));

  const totalLe = totalStl + totalEquity;
  lines.push(line("TOTAL LIABILITIES AND EQUITY", totalLe, 0, "subtotal"));

  lines.push(line("Check", totalLe - totalAssets, 0, "subtotal"));

  return { lines, totalAssets, totalLe };
}
