// Port of src/engines/adjustment_engine.py — structured double-entry adjustments,
// replaces manually editing TB numbers. Debits must equal credits, no line may carry
// both a debit and a credit, at least 2 lines, narration required.
import { persistence } from "../db/persistence.js";
import * as adjustmentRepo from "../db/adjustment-repo.js";
import * as periodRepo from "../db/period-repo.js";
import * as groupCoaRepo from "../db/group-coa-repo.js";
import { log as auditLog } from "../services/audit-service.js";

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

// Resolves entity codes and category names so the audit log's before/after JSON reads
// like a human-reviewable journal entry, not raw foreign keys.
function snapshot(adjustmentRow, lines) {
  const lineSnapshots = lines.map((l) => {
    let entityCode = null;
    if (l.entity_id) {
      const e = persistence.get("SELECT entity_code FROM entities WHERE entity_id = ?", [l.entity_id]);
      entityCode = e ? e.entity_code : null;
    }
    const category = groupCoaRepo.getById(l.group_account_id);
    return {
      entity: entityCode,
      category: category ? category.account_name : null,
      debit: l.debit_amount,
      credit: l.credit_amount,
    };
  });
  return {
    externalRef: adjustmentRow.external_ref,
    type: adjustmentRow.adjustment_type,
    narration: adjustmentRow.narration,
    status: adjustmentRow.status,
    lines: lineSnapshots,
  };
}

// Edit an existing adjustment (draft or applied) in place. Validates, requires the period
// open, snapshots before/after into the audit log, and resets status to draft.
//
// externalRef is immutable here by design — it's always read from the existing row, never
// taken from the caller, so an edit can't collide with the (period_id, external_ref)
// upsert key or become indistinguishable from creating a second adjustment.
export function updateAdjustment(periodId, adjustmentId, adjustmentType, narration, lines, user = null) {
  periodRepo.requireOpen(periodId, "edit an adjustment");

  const existing = persistence.get("SELECT * FROM adjustments WHERE adjustment_id = ? AND period_id = ?", [adjustmentId, periodId]);
  if (!existing) {
    throw new Error(`Adjustment ${adjustmentId} not found in this period`);
  }

  const before = snapshot(existing, adjustmentRepo.getLines(adjustmentId));

  const errors = validate(narration, lines, adjustmentType);
  if (errors.length) {
    throw new Error(`Adjustment '${existing.external_ref}' is invalid:\n` + errors.join("\n"));
  }

  adjustmentRepo.createOrReplace(periodId, existing.external_ref, adjustmentType, narration, lines, user);

  const afterRow = persistence.get("SELECT * FROM adjustments WHERE adjustment_id = ?", [adjustmentId]);
  const after = snapshot(afterRow, adjustmentRepo.getLines(adjustmentId));

  auditLog("edit", "adjustments", String(adjustmentId), { oldValue: JSON.stringify(before), newValue: JSON.stringify(after), user });

  return adjustmentId;
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
