// Port of src/db/repositories/tb_repo.py
import { persistence } from "./persistence.js";
import * as periodRepo from "./period-repo.js";
import { log as auditLog } from "../services/audit-service.js";

// Insert (or replace) a TB import for one entity+period.
export function importTb(periodId, entityId, parsed, importedBy = null) {
  periodRepo.requireOpen(periodId, "import a TB");

  const existing = persistence.get(
    "SELECT import_id FROM trial_balance_imports WHERE period_id = ? AND entity_id = ?",
    [periodId, entityId]
  );

  let importId;
  if (existing) {
    importId = existing.import_id;
    persistence.run("DELETE FROM trial_balance_lines WHERE import_id = ?", [importId]);
    persistence.run(
      `UPDATE trial_balance_imports
         SET source_filename = ?, imported_at = ?, imported_by = ?, row_count = ?,
             checksum = ?, grand_total_period_dr = ?, grand_total_period_cr = ?
       WHERE import_id = ?`,
      [
        parsed.sourceFilename,
        new Date().toISOString(),
        importedBy,
        parsed.lines.length,
        parsed.checksum,
        parsed.grandTotalPeriodDr,
        parsed.grandTotalPeriodCr,
        importId,
      ]
    );
    auditLog("re-import", "trial_balance_imports", String(importId), { newValue: parsed.sourceFilename, user: importedBy });
  } else {
    importId = persistence.insert(
      `INSERT INTO trial_balance_imports
         (period_id, entity_id, source_filename, imported_at, imported_by, row_count,
          checksum, grand_total_period_dr, grand_total_period_cr)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        periodId,
        entityId,
        parsed.sourceFilename,
        new Date().toISOString(),
        importedBy,
        parsed.lines.length,
        parsed.checksum,
        parsed.grandTotalPeriodDr,
        parsed.grandTotalPeriodCr,
      ]
    );
    auditLog("import", "trial_balance_imports", String(importId), { newValue: parsed.sourceFilename, user: importedBy });
  }

  for (const line of parsed.lines) {
    persistence.run(
      `INSERT INTO trial_balance_lines
         (import_id, entity_ledger_name, tally_primary_group, opening_dr, opening_cr,
          period_dr, period_cr, closing_dr, closing_cr, closing_tie_warning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        importId,
        line.entityLedgerName,
        line.tallyPrimaryGroup,
        line.openingDr,
        line.openingCr,
        line.periodDr,
        line.periodCr,
        line.closingDr,
        line.closingCr,
        line.closingTieWarning ? 1 : 0,
      ]
    );
  }
  return importId;
}

export function findDuplicateChecksum(periodId, entityId, checksum) {
  const row = persistence.get(
    `SELECT 1 FROM trial_balance_imports WHERE period_id = ? AND entity_id = ? AND checksum = ?`,
    [periodId, entityId, checksum]
  );
  return row !== null;
}

export function getLinesForPeriod(periodId) {
  return persistence.all(
    `SELECT tbl.*, tbi.entity_id, e.entity_code
       FROM trial_balance_lines tbl
       JOIN trial_balance_imports tbi ON tbl.import_id = tbi.import_id
       JOIN entities e ON tbi.entity_id = e.entity_id
      WHERE tbi.period_id = ?`,
    [periodId]
  );
}

export function getImportsForPeriod(periodId) {
  return persistence.all(
    `SELECT tbi.*, e.entity_code, e.entity_name
       FROM trial_balance_imports tbi
       JOIN entities e ON tbi.entity_id = e.entity_id
      WHERE tbi.period_id = ?`,
    [periodId]
  );
}

export function setLineMapping(lineId, groupAccountId) {
  persistence.run("UPDATE trial_balance_lines SET mapped_group_account_id = ? WHERE line_id = ?", [
    groupAccountId,
    lineId,
  ]);
}
