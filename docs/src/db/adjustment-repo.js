// Port of src/db/repositories/adjustment_repo.py
import { persistence } from "./persistence.js";
import * as periodRepo from "./period-repo.js";
import { log as auditLog } from "../services/audit-service.js";

export const VALID_TYPES = new Set([
  "reclassification",
  "accrual",
  "provision",
  "depreciation",
  "tax",
  "management",
  "ic_elimination",
  "opening_correction",
  "inventory_movement",
  "other",
]);

// Upsert by (period_id, external_ref): if it exists, replace its lines wholesale and log
// to the audit trail.
export function createOrReplace(periodId, externalRef, adjustmentType, narration, lines, user = null, copiedFromPeriodId = null) {
  const existing = persistence.get("SELECT adjustment_id FROM adjustments WHERE period_id = ? AND external_ref = ?", [
    periodId,
    externalRef,
  ]);

  let adjustmentId;
  if (existing) {
    adjustmentId = existing.adjustment_id;
    persistence.run("DELETE FROM adjustment_lines WHERE adjustment_id = ?", [adjustmentId]);
    persistence.run(`UPDATE adjustments SET adjustment_type = ?, narration = ?, status = 'draft' WHERE adjustment_id = ?`, [
      adjustmentType,
      narration,
      adjustmentId,
    ]);
    auditLog("update", "adjustments", String(adjustmentId), { newValue: narration, user });
  } else {
    adjustmentId = persistence.insert(
      `INSERT INTO adjustments
         (period_id, external_ref, adjustment_type, narration, created_at, created_by,
          copied_from_period_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
      [periodId, externalRef, adjustmentType, narration, new Date().toISOString(), user, copiedFromPeriodId]
    );
    auditLog("create", "adjustments", String(adjustmentId), { newValue: narration, user });
  }

  for (const line of lines) {
    persistence.run(
      `INSERT INTO adjustment_lines
         (adjustment_id, entity_id, group_account_id, debit_amount, credit_amount, line_narration)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        adjustmentId,
        line.entityId ?? null,
        line.groupAccountId,
        line.debitAmount ?? 0.0,
        line.creditAmount ?? 0.0,
        line.lineNarration ?? null,
      ]
    );
  }

  return adjustmentId;
}

export function getLines(adjustmentId) {
  return persistence.all("SELECT * FROM adjustment_lines WHERE adjustment_id = ?", [adjustmentId]);
}

export function listForPeriod(periodId) {
  return persistence.all("SELECT * FROM adjustments WHERE period_id = ? ORDER BY adjustment_id", [periodId]);
}

export function applyAll(periodId, user = null) {
  periodRepo.requireOpen(periodId, "apply adjustments");
  const rows = persistence.all("SELECT adjustment_id FROM adjustments WHERE period_id = ? AND status = 'draft'", [
    periodId,
  ]);
  for (const r of rows) {
    persistence.run("UPDATE adjustments SET status = 'applied' WHERE adjustment_id = ?", [r.adjustment_id]);
    auditLog("apply", "adjustments", String(r.adjustment_id), { user });
  }
  return rows.length;
}

export function deleteAdjustment(periodId, adjustmentId, user = null) {
  periodRepo.requireOpen(periodId, "delete an adjustment");
  persistence.run("DELETE FROM adjustment_lines WHERE adjustment_id = ?", [adjustmentId]);
  persistence.run("DELETE FROM adjustments WHERE adjustment_id = ?", [adjustmentId]);
  auditLog("delete", "adjustments", String(adjustmentId), { user });
}
