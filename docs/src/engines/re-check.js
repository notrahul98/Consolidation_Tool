// Port of src/engines/re_check.py — Retained Earnings movement check.
//
// expected_RE_closing(M) = RE_closing(M-1) + net_profit(M-1)
// gap                    = actual_RE_closing(M) - expected_RE_closing(M)
//
// RE_closing is the post-adjustment closing on the `Retained Earnings` ledger category —
// the brought-forward figure, *not* the BS face line (which computeBs builds as
// RE_bf + current_year_pl). Using the face line would compare the number against itself.
//
// Deliberately diagnostic rather than prescriptive — see the Python docstring for the full
// rationale. Severity is always Warning; this check never blocks locking a period.
import { persistence } from "../db/persistence.js";
import * as periodRepo from "../db/period-repo.js";
import * as consolidatedRepo from "../db/consolidated-repo.js";
import * as groupCoaRepo from "../db/group-coa-repo.js";
import { computePl } from "./statements.js";
import { codepointCompare } from "../utils.js";

const RE_ACCOUNT_NAME = "Retained Earnings";

// Post-adjustment Retained Earnings for the group: every entity's bucket PLUS group-level
// adjustments.
//
// Not the sum of per-entity buckets alone: an adjustment booked at group level carries no
// entity_id, so it lands in no entity's bucket and summing them silently omits it. That
// would pair an RE closing WITHOUT group-level adjustments against a priorNetProfit (from
// computePl) WITH them, and report a gap wrong by exactly those adjustments -- which is what
// happened on the real July 2026 data, off by the 13,608,330,781 shareholder-loan reclass.
function reClosingGroupTotal(periodId) {
  const account = groupCoaRepo.getByName(RE_ACCOUNT_NAME);
  if (!account) return 0.0;
  const accountId = account.group_account_id;
  const { byAccountEntity, groupAdjustment } = consolidatedRepo.getBuckets(periodId);
  let entitySum = 0.0;
  for (const [key, value] of byAccountEntity) {
    if (Number(key.split(":")[0]) === accountId) entitySum += value;
  }
  return entitySum + (groupAdjustment.get(accountId) || 0.0);
}

// One per entity, plus a group total row (entityCode = null).
export class RECheckRow {
  constructor({ entityCode, reClosingPrior, priorNetProfit, reClosingCurrent }) {
    this.entityCode = entityCode;
    this.reClosingPrior = reClosingPrior;
    this.priorNetProfit = priorNetProfit;
    this.reClosingCurrent = reClosingCurrent;
  }

  get expected() {
    return this.reClosingPrior + this.priorNetProfit;
  }

  get gap() {
    return this.reClosingCurrent - this.expected;
  }
}

// entityId -> post-adjustment closing balance on the Retained Earnings category. Summed
// (not last-wins) across source_type IN ('entity_tb', 'adjustment') rows.
function reClosingByEntity(periodId) {
  const rows = persistence.all(
    `SELECT ctb.entity_id, SUM(ctb.closing_dr) - SUM(ctb.closing_cr) AS balance
       FROM consolidated_tb ctb
       JOIN group_coa gc ON gc.group_account_id = ctb.group_account_id
      WHERE ctb.period_id = ? AND gc.account_name = ?
            AND ctb.source_type IN ('entity_tb', 'adjustment')
      GROUP BY ctb.entity_id`,
    [periodId, RE_ACCOUNT_NAME]
  );
  const map = new Map();
  for (const r of rows) {
    if (r.entity_id !== null && r.entity_id !== undefined) map.set(r.entity_id, r.balance || 0.0);
  }
  return map;
}

// entityId -> signed sum of consolidated_tb PL-category rows, sign-flipped to
// income-positive (matching V7's convention: incomePositive = -(closingDr - closingCr)).
function netProfitByEntity(periodId) {
  const rows = persistence.all(
    `SELECT ctb.entity_id, SUM(ctb.closing_dr) - SUM(ctb.closing_cr) AS balance
       FROM consolidated_tb ctb
       JOIN group_coa gc ON gc.group_account_id = ctb.group_account_id
      WHERE ctb.period_id = ? AND gc.statement_type = 'PL'
            AND ctb.source_type IN ('entity_tb', 'adjustment')
      GROUP BY ctb.entity_id`,
    [periodId]
  );
  const map = new Map();
  for (const r of rows) {
    if (r.entity_id !== null && r.entity_id !== undefined) map.set(r.entity_id, -(r.balance || 0.0));
  }
  return map;
}

function periodHasConsolidatedData(periodId) {
  return persistence.get("SELECT 1 FROM consolidated_tb WHERE period_id = ? LIMIT 1", [periodId]) !== null;
}

// Every adjustment line in either period that touches Retained Earnings or any
// PL-statement-type category, since both move the two sides of this reconciliation.
function linkedAdjustments(currentPeriodId, priorPeriodId) {
  const rows = persistence.all(
    `SELECT p.year, p.month, a.adjustment_id, a.external_ref, a.adjustment_type, a.status,
            a.narration, e.entity_code, gc.account_name, gc.statement_type,
            al.debit_amount, al.credit_amount
       FROM adjustment_lines al
       JOIN adjustments a ON al.adjustment_id = a.adjustment_id
       JOIN periods p ON a.period_id = p.period_id
       JOIN group_coa gc ON al.group_account_id = gc.group_account_id
       LEFT JOIN entities e ON al.entity_id = e.entity_id
      WHERE a.period_id IN (?, ?)
            AND (gc.account_name = ? OR gc.statement_type = 'PL')
      ORDER BY p.year, p.month, a.external_ref`,
    [currentPeriodId, priorPeriodId, RE_ACCOUNT_NAME]
  );

  return rows.map((r) => ({
    periodStr: `${r.year}-${String(r.month).padStart(2, "0")}`,
    adjustmentId: r.adjustment_id,
    externalRef: r.external_ref,
    type: r.adjustment_type,
    status: r.status,
    narration: r.narration,
    entityCode: r.entity_code,
    category: r.account_name,
    statementType: r.statement_type,
    debit: r.debit_amount,
    credit: r.credit_amount,
  }));
}

export function run(currentPeriodId) {
  const prior = periodRepo.getPrior(currentPeriodId);
  if (!prior) {
    return { applicable: false, reason: "No prior period exists", priorPeriodStr: null, rows: [], linkedAdjustments: [] };
  }

  const priorPeriodId = prior.period_id;
  if (!periodHasConsolidatedData(priorPeriodId)) {
    return {
      applicable: false,
      reason: "Prior period has not been consolidated",
      priorPeriodStr: periodRepo.asStr(prior),
      rows: [],
      linkedAdjustments: [],
    };
  }

  const rePrior = reClosingByEntity(priorPeriodId);
  const reCurrent = reClosingByEntity(currentPeriodId);
  const profitPrior = netProfitByEntity(priorPeriodId);

  const entityIds = Array.from(new Set([...rePrior.keys(), ...reCurrent.keys(), ...profitPrior.keys()])).sort((a, b) => a - b);
  const entityCodes = new Map(persistence.all("SELECT entity_id, entity_code FROM entities").map((r) => [r.entity_id, r.entity_code]));

  const rows = entityIds.map(
    (eid) =>
      new RECheckRow({
        entityCode: entityCodes.get(eid) ?? String(eid),
        reClosingPrior: rePrior.get(eid) ?? 0.0,
        priorNetProfit: profitPrior.get(eid) ?? 0.0,
        reClosingCurrent: reCurrent.get(eid) ?? 0.0,
      })
  );
  rows.sort((a, b) => codepointCompare(a.entityCode || "", b.entityCode || ""));

  // Group total row: every figure must come from a source that includes group-level
  // adjustments, or the gap is wrong by exactly those adjustments. Net profit uses computePl
  // and RE closing uses reClosingGroupTotal, so both tie to the P&L and BS pages. The
  // per-entity rows above necessarily exclude group-level adjustments -- those belong to no
  // entity -- so the entity rows will not add up to this row whenever any exist.
  const { netIncome: groupPriorProfit } = computePl(priorPeriodId);
  const groupRow = new RECheckRow({
    entityCode: null,
    reClosingPrior: reClosingGroupTotal(priorPeriodId),
    priorNetProfit: groupPriorProfit,
    reClosingCurrent: reClosingGroupTotal(currentPeriodId),
  });
  rows.push(groupRow);

  return {
    applicable: true,
    reason: null,
    priorPeriodStr: periodRepo.asStr(prior),
    rows,
    linkedAdjustments: linkedAdjustments(currentPeriodId, priorPeriodId),
  };
}
