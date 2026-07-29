// Port of src/db/repositories/consolidated_repo.py
import { persistence } from "./persistence.js";

export function clearPeriod(periodId) {
  persistence.run("DELETE FROM consolidated_tb WHERE period_id = ?", [periodId]);
}

export function insertRow(
  periodId,
  groupAccountId,
  entityId,
  openingDr,
  openingCr,
  periodDr,
  periodCr,
  closingDr,
  closingCr,
  sourceType = "entity_tb"
) {
  persistence.run(
    `INSERT INTO consolidated_tb
       (period_id, group_account_id, entity_id, source_type,
        opening_dr, opening_cr, period_dr, period_cr, closing_dr, closing_cr)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [periodId, groupAccountId, entityId, sourceType, openingDr, openingCr, periodDr, periodCr, closingDr, closingCr]
  );
}

export function getMatrix(periodId) {
  return persistence.all(
    `SELECT ctb.*, gc.account_code, gc.account_name, gc.statement_type, gc.section,
            gc.line_item_order, e.entity_code
       FROM consolidated_tb ctb
       JOIN group_coa gc ON ctb.group_account_id = gc.group_account_id
       LEFT JOIN entities e ON ctb.entity_id = e.entity_id
      WHERE ctb.period_id = ?
      ORDER BY gc.line_item_order, e.sort_order`,
    [periodId]
  );
}
