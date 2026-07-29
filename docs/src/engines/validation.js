// Port of src/engines/validation_engine.py
import { persistence } from "../db/persistence.js";
import { computePl, computeBs } from "./statements.js";

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
  ];
}
