// Port of src/engines/validation_engine.py
import { persistence } from "../db/persistence.js";
import { computePl, computeBs } from "./statements.js";
import { run as reCheckRun } from "./re-check.js";
import { resolveComparativePeriods } from "./comparative.js";

const TOLERANCE_IDR = 1;
const MATERIALITY_IDR = 0.0;

function result(checkId, description, severity, passed, details) {
  return { checkId, description, severity, passed, details };
}

// Each entity TB: period Dr/Cr sums tie to the exported Grand Total row.
function v1EntityGrandTotalTies(periodId) {
  const details = [];
  const rows = persistence.all(
    `SELECT tbi.import_id, e.entity_code, tbi.grand_total_period_dr, tbi.grand_total_period_cr,
            SUM(tbl.period_dr) AS sum_dr, SUM(tbl.period_cr) AS sum_cr
       FROM trial_balance_imports tbi
       JOIN entities e ON tbi.entity_id = e.entity_id
       JOIN trial_balance_lines tbl ON tbl.import_id = tbi.import_id
      WHERE tbi.period_id = ?
      GROUP BY tbi.import_id`,
    [periodId]
  );
  for (const r of rows) {
    if (Math.abs((r.sum_dr || 0) - (r.grand_total_period_dr || 0)) > TOLERANCE_IDR) {
      details.push(`${r.entity_code}: sum(period_dr)=${(r.sum_dr || 0).toFixed(2)} vs Grand Total ${(r.grand_total_period_dr || 0).toFixed(2)}`);
    }
    if (Math.abs((r.sum_cr || 0) - (r.grand_total_period_cr || 0)) > TOLERANCE_IDR) {
      details.push(`${r.entity_code}: sum(period_cr)=${(r.sum_cr || 0).toFixed(2)} vs Grand Total ${(r.grand_total_period_cr || 0).toFixed(2)}`);
    }
  }
  return result("V1", "Each entity TB ties to its exported Grand Total (Dr/Cr)", "Error", details.length === 0, details);
}

function v3v12MaterialMapped(periodId) {
  const rows = persistence.all(
    `SELECT e.entity_code, tbl.entity_ledger_name, (tbl.closing_dr - tbl.closing_cr) AS balance
       FROM trial_balance_lines tbl
       JOIN trial_balance_imports tbi ON tbl.import_id = tbi.import_id
       JOIN entities e ON tbi.entity_id = e.entity_id
      WHERE tbi.period_id = ? AND tbl.mapped_group_account_id IS NULL`,
    [periodId]
  );
  const details = rows
    .filter((r) => Math.abs(r.balance) > MATERIALITY_IDR)
    .map((r) => `${r.entity_code}: ${r.entity_ledger_name} (${r.balance.toFixed(2)})`);
  return result("V3/V12", "All material ledgers are categorized", "Error", details.length === 0, details);
}

function v5ConsolidatedBalances(periodId) {
  const row = persistence.get(
    `SELECT SUM(closing_dr) AS dr, SUM(closing_cr) AS cr FROM consolidated_tb WHERE period_id = ? AND source_type = 'total'`,
    [periodId]
  );
  const dr = row.dr || 0;
  const cr = row.cr || 0;
  const diff = Math.abs(dr - cr);
  const details = diff <= TOLERANCE_IDR ? [] : [`Consolidated total Dr=${dr.toFixed(2)} vs Cr=${cr.toFixed(2)} (diff ${diff.toFixed(2)})`];
  return result("V5", "Consolidated TB balances (total Dr = total Cr)", "Error", details.length === 0, details);
}

// Total = sum of entity_tb rows + adjustment rows (adjustments carry their own entity_id,
// including NULL for group-level ones) — not entity_tb alone, since applied adjustments
// land in the Total column but don't belong to any single entity's TB.
function v8EntityColumnsSumToTotal(periodId) {
  const rows = persistence.all(
    `SELECT gc.account_name,
            SUM(CASE WHEN ctb.source_type IN ('entity_tb', 'adjustment')
                     THEN ctb.closing_dr - ctb.closing_cr ELSE 0 END) AS entity_sum,
            SUM(CASE WHEN ctb.source_type = 'total' THEN ctb.closing_dr - ctb.closing_cr ELSE 0 END) AS total_sum
       FROM consolidated_tb ctb
       JOIN group_coa gc ON gc.group_account_id = ctb.group_account_id
      WHERE ctb.period_id = ?
      GROUP BY ctb.group_account_id`,
    [periodId]
  );
  const details = rows
    .filter((r) => Math.abs((r.entity_sum || 0) - (r.total_sum || 0)) > TOLERANCE_IDR)
    .map((r) => `${r.account_name}: entity+adjustment rows sum to ${(r.entity_sum || 0).toFixed(2)} vs total ${(r.total_sum || 0).toFixed(2)}`);
  return result("V8", "Entity + adjustment rows sum to the Total column for every account", "Error", details.length === 0, details);
}

// Each entity's raw imported TB (all lines, mapped or not) balances Dr=Cr on closing.
function v9SourceTbSelfBalances(periodId) {
  const rows = persistence.all(
    `SELECT e.entity_code, SUM(tbl.closing_dr) AS dr, SUM(tbl.closing_cr) AS cr
       FROM trial_balance_lines tbl
       JOIN trial_balance_imports tbi ON tbl.import_id = tbi.import_id
       JOIN entities e ON tbi.entity_id = e.entity_id
      WHERE tbi.period_id = ?
      GROUP BY tbi.import_id`,
    [periodId]
  );
  const details = rows
    .filter((r) => Math.abs((r.dr || 0) - (r.cr || 0)) > TOLERANCE_IDR)
    .map((r) => `${r.entity_code}: closing Dr=${(r.dr || 0).toFixed(2)} vs Cr=${(r.cr || 0).toFixed(2)}`);
  return result("V9", "Each entity's source TB self-balances (closing Dr = Cr)", "Error", details.length === 0, details);
}

function v6BsBalances(periodId) {
  const { totalAssets, totalLe } = computeBs(periodId);
  const diff = Math.abs(totalAssets - totalLe);
  const details = diff <= TOLERANCE_IDR ? [] : [`Total Assets=${totalAssets.toFixed(2)} vs Total Liabilities+Equity=${totalLe.toFixed(2)} (diff ${diff.toFixed(2)})`];
  return result("V6", "Balance Sheet balances (Total Assets = Total Liabilities + Equity)", "Error", details.length === 0, details);
}

// Net income computed independently from the P&L must equal the BS's "Current Year Profit"
// plug — this is really the same check as V6 from the other direction, but kept separate.
function v7PlFlowsToBs(periodId) {
  const { netIncome } = computePl(periodId);
  const row = persistence.get(
    `SELECT SUM(closing_dr) AS dr, SUM(closing_cr) AS cr
       FROM consolidated_tb ctb
       JOIN group_coa gc ON gc.group_account_id = ctb.group_account_id
      WHERE ctb.period_id = ? AND ctb.source_type = 'total' AND gc.statement_type = 'PL'`,
    [periodId]
  );
  const plSignedTotal = (row.dr || 0) - (row.cr || 0);
  const diff = Math.abs(netIncome - -plSignedTotal);
  const details = diff <= TOLERANCE_IDR ? [] : [`Computed net income ${netIncome.toFixed(2)} vs raw P&L ledger total ${(-plSignedTotal).toFixed(2)}`];
  return result("V7", "P&L net profit flows consistently to the BS current-year-profit line", "Error", details.length === 0, details);
}

function v2AdjustmentsBalance(periodId) {
  const rows = persistence.all(
    `SELECT a.adjustment_id, a.external_ref, SUM(al.debit_amount) AS dr, SUM(al.credit_amount) AS cr
       FROM adjustments a
       JOIN adjustment_lines al ON al.adjustment_id = a.adjustment_id
      WHERE a.period_id = ?
      GROUP BY a.adjustment_id`,
    [periodId]
  );
  const details = rows
    .filter((r) => Math.abs((r.dr || 0) - (r.cr || 0)) > TOLERANCE_IDR)
    .map((r) => `${r.external_ref}: debits=${(r.dr || 0).toFixed(2)} vs credits=${(r.cr || 0).toFixed(2)}`);
  return result("V2", "Each adjustment's debits equal its credits", "Error", details.length === 0, details);
}

function v14DraftAdjustments(periodId) {
  const rows = persistence.all("SELECT external_ref FROM adjustments WHERE period_id = ? AND status = 'draft'", [periodId]);
  const details = rows.map((r) => `${r.external_ref} is still in draft — not yet applied`);
  return result("V14", "No adjustments left pending in draft status", "Warning", details.length === 0, details);
}

function v18LockedPeriodImmutable(periodId) {
  const period = persistence.get("SELECT * FROM periods WHERE period_id = ?", [periodId]);
  if (period.status !== "locked") {
    return result("V18", "Locked periods carry no unapplied draft adjustments", "Error", true, []);
  }
  const rows = persistence.all("SELECT external_ref FROM adjustments WHERE period_id = ? AND status = 'draft'", [periodId]);
  const details = rows.map((r) => `${r.external_ref} is draft in a locked period`);
  return result("V18", "Locked periods carry no unapplied draft adjustments", "Error", details.length === 0, details);
}

// Stock/COGS movement booked. Fails when the period has a non-zero Inventory balance and
// either (a) no applied inventory_movement adjustment exists, or (b) one exists but its
// amounts no longer match the current stock_movement figures (i.e. the figures were
// edited after the adjustment was generated).
function v19StockCogsBooked(periodId) {
  const inventoryEntities = persistence.all(
    `SELECT ctb.entity_id, e.entity_code,
            SUM(ctb.closing_dr) - SUM(ctb.closing_cr) AS inventory_balance
       FROM consolidated_tb ctb
       JOIN entities e ON ctb.entity_id = e.entity_id
       JOIN group_coa gc ON gc.group_account_id = ctb.group_account_id
      WHERE ctb.period_id = ? AND gc.account_name = 'Inventory'
            AND ctb.source_type = 'total'
      GROUP BY ctb.entity_id
     HAVING ABS(inventory_balance) > ?`,
    [periodId, TOLERANCE_IDR]
  );

  if (inventoryEntities.length === 0) {
    return result("V19", "Stock/COGS movement booked", "Warning", true, []);
  }

  const appliedAdj = persistence.get(
    `SELECT adjustment_id FROM adjustments
      WHERE period_id = ? AND adjustment_type = 'inventory_movement' AND status = 'applied'
      LIMIT 1`,
    [periodId]
  );

  if (!appliedAdj) {
    const details = ["Period has non-zero Inventory but no applied stock adjustment"];
    return result("V19", "Stock/COGS movement booked", "Warning", false, details);
  }

  const details = [];
  for (const inv of inventoryEntities) {
    const stock = persistence.get(
      `SELECT opening_stock_auto, opening_stock_override, closing_stock_auto, closing_stock_override,
              purchases_auto, purchases_override
         FROM stock_movement WHERE period_id = ? AND entity_id = ?`,
      [periodId, inv.entity_id]
    );

    if (!stock) {
      details.push(`${inv.entity_code}: non-zero Inventory but no stock_movement row`);
      continue;
    }

    const opening = stock.opening_stock_override !== null && stock.opening_stock_override !== undefined ? stock.opening_stock_override : stock.opening_stock_auto;
    const closing = stock.closing_stock_override !== null && stock.closing_stock_override !== undefined ? stock.closing_stock_override : stock.closing_stock_auto;
    if (opening === null || opening === undefined || closing === null || closing === undefined) continue;
    const delta = opening - closing;

    if (Math.abs(delta) > TOLERANCE_IDR) {
      // Only the magnitude matters here (direction is already fixed by
      // generateAdjustment's drawdown/buildup branches), so summing the signed
      // debit-credit and comparing absolute values sidesteps needing to know
      // Inventory's normal_balance direction.
      const adjBalance = persistence.get(
        `SELECT SUM(al.debit_amount - al.credit_amount) AS net
           FROM adjustment_lines al
           JOIN adjustments a ON al.adjustment_id = a.adjustment_id
           JOIN group_coa gc ON al.group_account_id = gc.group_account_id
          WHERE a.adjustment_id = ? AND al.entity_id = ? AND gc.account_name = 'Inventory'`,
        [appliedAdj.adjustment_id, inv.entity_id]
      );

      if (!adjBalance || Math.abs(Math.abs(adjBalance.net || 0) - Math.abs(delta)) > TOLERANCE_IDR) {
        details.push(`${inv.entity_code}: stock figures changed after adjustment generation`);
      }
    }
  }

  return result("V19", "Stock/COGS movement booked", "Warning", details.length === 0, details);
}

// Retained Earnings movement ties to prior period profit. Wraps re-check.run(). Detail
// line per entity whose abs(gap) > TOLERANCE_IDR, plus a group-level line. Passes when
// not applicable.
function v20ReMovementTiesToPriorProfit(periodId) {
  const reResult = reCheckRun(periodId);
  if (!reResult.applicable) {
    return result("V20", "Retained Earnings movement ties to prior period profit", "Warning", true, []);
  }

  const details = [];
  for (const row of reResult.rows) {
    if (Math.abs(row.gap) > TOLERANCE_IDR) {
      const label = row.entityCode ? row.entityCode : "Group total";
      details.push(`${label}: RE gap=${row.gap.toFixed(2)} (expected ${row.expected.toFixed(2)}, actual ${row.reClosingCurrent.toFixed(2)})`);
    }
  }

  return result("V20", "Retained Earnings movement ties to prior period profit", "Warning", details.length === 0, details);
}

// The YTD range's missing / open / stale months, as the comparative screens report them.
function comparativeReadiness(periodId) {
  return resolveComparativePeriods(periodId).readiness;
}

// Every month of the year to date has consolidated data. Warning.
//
// The comparative screens already show this as a banner, but a banner is only seen by whoever
// opens that page. Putting it in the validation list means it also reaches the Validation
// sheet in the Excel pack, where a reviewer looks at the numbers rather than at the tool. A
// partial year-to-date figure is not wrong, it just is not what its heading claims, so this
// never blocks locking.
function v21ComparativeRangeComplete(periodId) {
  const missing = comparativeReadiness(periodId).missing;
  const details = missing.map((m) => `No consolidated data for ${m}`);
  if (details.length) {
    details.push(`Year-to-date columns cover ${missing.length} fewer month(s) than the period implies`);
  }
  return result("V21", "Comparative range has data for every month to date", "Warning", details.length === 0, details);
}

// No open or stale periods inside the comparative range. Warning.
//
// An open month can still change and a stale one is showing figures a re-consolidate would
// move, so a year-to-date column built over either is provisional. Reported together because
// the reader's question is the same: can I rely on this total yet.
function v22ComparativeRangeSettled(periodId) {
  const readiness = comparativeReadiness(periodId);
  const details = readiness.open.map((m) => `${m} is open (unlocked) - its figures can still change`);
  for (const m of readiness.stale) details.push(`${m} has adjustments changed since its last consolidation`);
  return result("V22", "Comparative range contains no open or stale periods", "Warning", details.length === 0, details);
}

export function runAll(periodId) {
  return [
    v1EntityGrandTotalTies(periodId),
    v3v12MaterialMapped(periodId),
    v9SourceTbSelfBalances(periodId),
    v5ConsolidatedBalances(periodId),
    v8EntityColumnsSumToTotal(periodId),
    v6BsBalances(periodId),
    v7PlFlowsToBs(periodId),
    v2AdjustmentsBalance(periodId),
    v14DraftAdjustments(periodId),
    v18LockedPeriodImmutable(periodId),
    v19StockCogsBooked(periodId),
    v20ReMovementTiesToPriorProfit(periodId),
    v21ComparativeRangeComplete(periodId),
    v22ComparativeRangeSettled(periodId),
  ];
}
