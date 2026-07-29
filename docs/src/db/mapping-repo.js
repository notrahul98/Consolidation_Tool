// Port of src/db/repositories/mapping_repo.py
import { persistence } from "./persistence.js";
import { log as auditLog } from "../services/audit-service.js";

// Make sure every (entity, ledger) seen in this period's TB has an entity_coa_mapping
// row (starting unmapped) so it shows up for categorization.
export function ensureRowsExist(periodId) {
  const ledgers = persistence.all(
    `SELECT DISTINCT tbi.entity_id, tbl.entity_ledger_name
       FROM trial_balance_lines tbl
       JOIN trial_balance_imports tbi ON tbl.import_id = tbi.import_id
      WHERE tbi.period_id = ?`,
    [periodId]
  );
  for (const row of ledgers) {
    persistence.run(
      `INSERT OR IGNORE INTO entity_coa_mapping (entity_id, entity_ledger_name, mapping_status)
       VALUES (?, ?, 'unmapped')`,
      [row.entity_id, row.entity_ledger_name]
    );
  }
}

// One row per distinct ledger name across all entities.
export function distinctLedgersForPeriod(periodId) {
  const rows = persistence.all(
    `SELECT tbl.entity_ledger_name, tbl.tally_primary_group, tbi.entity_id,
            e.entity_code, ecm.group_account_id, ecm.mapping_status,
            (tbl.closing_dr - tbl.closing_cr) AS closing_balance
       FROM trial_balance_lines tbl
       JOIN trial_balance_imports tbi ON tbl.import_id = tbi.import_id
       JOIN entities e ON tbi.entity_id = e.entity_id
       LEFT JOIN entity_coa_mapping ecm
              ON ecm.entity_id = tbi.entity_id AND ecm.entity_ledger_name = tbl.entity_ledger_name
      WHERE tbi.period_id = ?
      ORDER BY tbl.entity_ledger_name, e.entity_code`,
    [periodId]
  );

  const byName = new Map();
  for (const r of rows) {
    if (!byName.has(r.entity_ledger_name)) {
      byName.set(r.entity_ledger_name, {
        ledgerName: r.entity_ledger_name,
        entities: [],
        primaryGroups: new Set(),
        totalBalance: 0.0,
        groupAccountIds: new Set(),
      });
    }
    const entry = byName.get(r.entity_ledger_name);
    entry.entities.push(r.entity_code);
    if (r.tally_primary_group) entry.primaryGroups.add(r.tally_primary_group);
    entry.totalBalance += r.closing_balance || 0.0;
    if (r.group_account_id) entry.groupAccountIds.add(r.group_account_id);
  }
  return Array.from(byName.values());
}

// Apply a category to every entity where this ledger name appears. Returns rows affected.
export function applyMapping(ledgerName, groupAccountId, user = null) {
  const rows = persistence.all(
    "SELECT mapping_id, entity_id, group_account_id FROM entity_coa_mapping WHERE entity_ledger_name = ?",
    [ledgerName]
  );
  const status = groupAccountId ? "mapped" : "unmapped";
  for (const row of rows) {
    if (row.group_account_id !== groupAccountId) {
      auditLog("map", "entity_coa_mapping", String(row.mapping_id), {
        oldValue: String(row.group_account_id),
        newValue: String(groupAccountId),
        user,
      });
    }
    persistence.run(
      `UPDATE entity_coa_mapping
          SET group_account_id = ?, mapping_status = ?, last_updated_by = ?, last_updated_at = ?
        WHERE mapping_id = ?`,
      [groupAccountId, status, user, new Date().toISOString(), row.mapping_id]
    );
  }
  return rows.length;
}

// Like applyMapping, but scoped to a single entity — for ledgers booked to different
// categories in different entities.
export function applyMappingForEntity(entityId, ledgerName, groupAccountId, user = null) {
  const row = persistence.get(
    "SELECT mapping_id, group_account_id FROM entity_coa_mapping WHERE entity_id = ? AND entity_ledger_name = ?",
    [entityId, ledgerName]
  );
  if (!row) return;
  const status = groupAccountId ? "mapped" : "unmapped";
  if (row.group_account_id !== groupAccountId) {
    auditLog("map", "entity_coa_mapping", String(row.mapping_id), {
      oldValue: String(row.group_account_id),
      newValue: String(groupAccountId),
      user,
    });
  }
  persistence.run(
    `UPDATE entity_coa_mapping
        SET group_account_id = ?, mapping_status = ?, last_updated_by = ?, last_updated_at = ?
      WHERE mapping_id = ?`,
    [groupAccountId, status, user, new Date().toISOString(), row.mapping_id]
  );
}

export function getMapping(entityId, ledgerName) {
  return persistence.get("SELECT * FROM entity_coa_mapping WHERE entity_id = ? AND entity_ledger_name = ?", [
    entityId,
    ledgerName,
  ]);
}
