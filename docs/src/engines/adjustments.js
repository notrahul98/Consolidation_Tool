// Port of src/engines/adjustment_engine.py — structured double-entry adjustments,
// replaces manually editing TB numbers. Debits must equal credits, no line may carry
// both a debit and a credit, at least 2 lines, narration required.
import { persistence } from "../db/persistence.js";
import * as adjustmentRepo from "../db/adjustment-repo.js";
import * as periodRepo from "../db/period-repo.js";

const TOLERANCE_IDR = 0;

export function validate(narration, lines, adjustmentType = null) {
  const errors = [];
  if (!narration || !narration.trim()) {
    errors.push("Adjustment narration is required");
  }
  if (adjustmentType !== null && !adjustmentRepo.VALID_TYPES.has(adjustmentType)) {
    errors.push(
      `Unknown adjustment type '${adjustmentType}' — must be one of ${Array.from(adjustmentRepo.VALID_TYPES).sort().join(", ")}`
    );
  }
  if (lines.length < 2) {
    errors.push("An adjustment needs at least 2 lines");
  }
  const totalDr = lines.reduce((s, l) => s + (l.debitAmount || 0.0), 0.0);
  const totalCr = lines.reduce((s, l) => s + (l.creditAmount || 0.0), 0.0);
  if (Math.abs(totalDr - totalCr) > TOLERANCE_IDR) {
    errors.push(`Adjustment does not balance: debits=${totalDr.toFixed(2)} credits=${totalCr.toFixed(2)}`);
  }
  lines.forEach((l, i) => {
    if ((l.debitAmount || 0.0) && (l.creditAmount || 0.0)) {
      errors.push(`Line ${i + 1}: cannot carry both a debit and a credit`);
    }
  });
  return errors;
}

export function createAdjustment(periodId, externalRef, adjustmentType, narration, lines, user = null) {
  const period = persistence.get("SELECT * FROM periods WHERE period_id = ?", [periodId]);
  if (period.status === "locked") {
    throw new Error(`Period ${period.year}-${String(period.month).padStart(2, "0")} is locked; cannot add adjustments`);
  }

  const errors = validate(narration, lines, adjustmentType);
  if (errors.length) {
    throw new Error(`Adjustment '${externalRef}' is invalid:\n` + errors.join("\n"));
  }

  return adjustmentRepo.createOrReplace(periodId, externalRef, adjustmentType, narration, lines, user);
}

// Copies every adjustment from the chronologically prior period into the target period as
// new drafts, narration tagged "(copied from [period])" — matching the user's existing
// copy-prior-month habit.
export function copyPriorMonth(targetPeriodId, user = null) {
  periodRepo.requireOpen(targetPeriodId, "copy adjustments into it");

  const prior = periodRepo.getPrior(targetPeriodId);
  if (!prior) {
    throw new Error("No prior period exists to copy adjustments from");
  }

  const sourceAdjustments = adjustmentRepo.listForPeriod(prior.period_id);
  let copied = 0;
  for (const adj of sourceAdjustments) {
    const lines = adjustmentRepo.getLines(adj.adjustment_id).map((l) => ({
      entityId: l.entity_id,
      groupAccountId: l.group_account_id,
      debitAmount: l.debit_amount,
      creditAmount: l.credit_amount,
      lineNarration: l.line_narration,
    }));
    let narration = adj.narration;
    const tag = `(copied from ${prior.year}-${String(prior.month).padStart(2, "0")})`;
    if (!narration.includes(tag)) narration = `${narration} ${tag}`;
    adjustmentRepo.createOrReplace(targetPeriodId, adj.external_ref, adj.adjustment_type, narration, lines, user, prior.period_id);
    copied++;
  }
  return copied;
}
