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

// The single aggregation of consolidated_tb used by BOTH the Consolidated TB page and the
// Excel pack, so the screen and the workbook cannot drift apart.
//
//   byAccountEntity  "<accountId>:<entityId>" -> that entity's TB plus any adjustment booked
//                    directly against that entity, summed (never overwritten — see the
//                    entity+adjustment bug in HANDOVER.md §9.6).
//   groupAdjustment  accountId -> adjustments carrying no entity. They belong to no entity
//                    column, so they must be added on top of the entity columns to reach
//                    the total.
//   total            accountId -> the authoritative 'total' row, the same figure the P&L
//                    and Balance Sheet read.
//
// The trap this exists to close: group-level adjustment rows and 'total' rows BOTH carry
// entity_id IS NULL, so bucketing by entity_id alone silently merges them (the total then
// double-counts every group-level adjustment). Separate by source_type first, always.
export function getBuckets(periodId) {
  const byAccountEntity = new Map();
  const groupAdjustment = new Map();
  const total = new Map();

  for (const r of getMatrix(periodId)) {
    const accountId = r.group_account_id;
    const signed = (r.closing_dr || 0) - (r.closing_cr || 0);
    const entityId = r.entity_id === undefined ? null : r.entity_id;
    if (r.source_type === "total") {
      total.set(accountId, (total.get(accountId) || 0) + signed);
    } else if (r.source_type === "adjustment" && entityId === null) {
      groupAdjustment.set(accountId, (groupAdjustment.get(accountId) || 0) + signed);
    } else {
      const k = `${accountId}:${entityId === null ? "null" : entityId}`;
      byAccountEntity.set(k, (byAccountEntity.get(k) || 0) + signed);
    }
  }

  return { byAccountEntity, groupAdjustment, total };
}
