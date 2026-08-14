// Port of src/engines/stock_engine.py — Stock/COGS movement calculation and adjustment
// generation.
import { persistence } from "../db/persistence.js";
import * as periodRepo from "../db/period-repo.js";
import * as groupCoaRepo from "../db/group-coa-repo.js";
import { createAdjustment } from "./adjustments.js";

// One row per entity's stock movement for a period. Getters mirror the Python
// dataclass's @property methods exactly (effective value = override if set, else auto).
export class StockRow {
  constructor({
    entityId,
    entityCode,
    openingAuto,
    openingOverride,
    closingAuto,
    closingOverride,
    purchasesAuto,
    purchasesOverride,
    purchaseLedgerCount,
    tbOpeningInventory,
    balancingAccount,
  }) {
    this.entityId = entityId;
    this.entityCode = entityCode;
    this.openingAuto = openingAuto; // null = no prior period
    this.openingOverride = openingOverride;
    this.closingAuto = closingAuto;
    this.closingOverride = closingOverride;
    this.purchasesAuto = purchasesAuto;
    this.purchasesOverride = purchasesOverride;
    this.purchaseLedgerCount = purchaseLedgerCount; // 0 => show "nothing mapped" warning
    this.tbOpeningInventory = tbOpeningInventory; // current TB's own opening — for the break check
    this.balancingAccount = balancingAccount;
  }

  // Effective opening stock: override if set, else auto.
  get opening() {
    return this.openingOverride !== null && this.openingOverride !== undefined ? this.openingOverride : this.openingAuto;
  }

  // Effective closing stock: override if set, else auto.
  get closing() {
    return this.closingOverride !== null && this.closingOverride !== undefined ? this.closingOverride : this.closingAuto;
  }

  // Effective purchases: override if set, else auto.
  get purchases() {
    return this.purchasesOverride !== null && this.purchasesOverride !== undefined ? this.purchasesOverride : this.purchasesAuto;
  }

  // COGS = opening + purchases - closing
  get computedCogs() {
    if (this.opening === null || this.opening === undefined || this.closing === null || this.closing === undefined) return null;
    return this.opening + this.purchases - this.closing;
  }

  // What the P&L shows today: purchases only.
  get tbCogs() {
    return this.purchasesAuto;
  }

  // Difference between computed COGS and TB COGS: opening - closing
  get delta() {
    if (this.opening === null || this.opening === undefined || this.closing === null || this.closing === undefined) return null;
    return this.opening - this.closing;
  }

  // TB opening inventory minus effective opening stock. Non-zero indicates Tally
  // restated stock without a journal entry.
  get openingBreak() {
    if (this.opening === null || this.opening === undefined) return 0.0;
    return this.tbOpeningInventory - this.opening;
  }
}

// Recompute every *_auto from the TBs and prior period, upsert into stock_movement.
// Idempotent — safe to call on every page load. Preserves all *_override values.
export function refresh(periodId) {
  const entities = persistence.all(
    `SELECT DISTINCT e.entity_id, e.entity_code
       FROM trial_balance_imports tbi
       JOIN entities e ON tbi.entity_id = e.entity_id
      WHERE tbi.period_id = ?
      ORDER BY e.entity_code`,
    [periodId]
  );

  const priorPeriod = periodRepo.getPrior(periodId);

  const rows = [];
  for (const entity of entities) {
    const entityId = entity.entity_id;
    const entityCode = entity.entity_code;

    // Opening stock = prior period's post-adjustment Inventory closing, per entity
    let openingAuto = null;
    if (priorPeriod) {
      const priorData = persistence.get(
        `SELECT SUM(ctb.closing_dr) - SUM(ctb.closing_cr) AS inventory_balance
           FROM consolidated_tb ctb
           JOIN group_coa gc ON gc.group_account_id = ctb.group_account_id
          WHERE ctb.period_id = ? AND ctb.entity_id = ? AND gc.account_name = 'Inventory'
                AND ctb.source_type IN ('entity_tb', 'adjustment')
          GROUP BY ctb.entity_id`,
        [priorPeriod.period_id, entityId]
      );
      if (priorData && priorData.inventory_balance !== null) {
        openingAuto = priorData.inventory_balance;
      }
    }

    // Closing stock = current TB Inventory closing, per entity (ledgers mapped to "Inventory")
    const inventoryCategory = groupCoaRepo.getByName("Inventory");
    let closingAuto = 0.0;
    let tbOpeningInventory = 0.0;

    if (inventoryCategory) {
      const tbData = persistence.get(
        `SELECT SUM(tbl.closing_dr) - SUM(tbl.closing_cr) AS closing,
                SUM(tbl.opening_dr) - SUM(tbl.opening_cr) AS opening
           FROM trial_balance_lines tbl
           JOIN trial_balance_imports tbi ON tbl.import_id = tbi.import_id
           JOIN entity_coa_mapping ecm ON ecm.entity_id = tbi.entity_id AND ecm.entity_ledger_name = tbl.entity_ledger_name
          WHERE tbi.period_id = ? AND tbi.entity_id = ? AND ecm.group_account_id = ?
          GROUP BY tbi.entity_id`,
        [periodId, entityId, inventoryCategory.group_account_id]
      );
      if (tbData) {
        closingAuto = tbData.closing || 0.0;
        tbOpeningInventory = tbData.opening || 0.0;
      }
    }

    // Purchases = closing balance on ledgers mapped to "COGS before Direct Cost & Forex Gain/Loss"
    const cogsCategory = groupCoaRepo.getByName("COGS before Direct Cost & Forex Gain/Loss");
    let purchasesAuto = 0.0;
    let purchaseLedgerCount = 0;

    if (cogsCategory) {
      const purchasesData = persistence.get(
        `SELECT SUM(tbl.closing_dr) - SUM(tbl.closing_cr) AS purchases,
                COUNT(DISTINCT tbl.entity_ledger_name) AS ledger_count
           FROM trial_balance_lines tbl
           JOIN trial_balance_imports tbi ON tbl.import_id = tbi.import_id
           JOIN entity_coa_mapping ecm ON ecm.entity_id = tbi.entity_id AND ecm.entity_ledger_name = tbl.entity_ledger_name
          WHERE tbi.period_id = ? AND tbi.entity_id = ? AND ecm.group_account_id = ?
          GROUP BY tbi.entity_id`,
        [periodId, entityId, cogsCategory.group_account_id]
      );
      if (purchasesData) {
        purchasesAuto = purchasesData.purchases || 0.0;
        purchaseLedgerCount = purchasesData.ledger_count || 0;
      }
    }

    // Get existing overrides from stock_movement, if any
    const existing = persistence.get("SELECT * FROM stock_movement WHERE period_id = ? AND entity_id = ?", [
      periodId,
      entityId,
    ]);

    if (existing) {
      persistence.run(
        `UPDATE stock_movement
            SET opening_stock_auto = ?, closing_stock_auto = ?, purchases_auto = ?,
                tb_opening_inventory = ?, purchase_ledger_count = ?, updated_at = ?
          WHERE period_id = ? AND entity_id = ?`,
        [openingAuto, closingAuto, purchasesAuto, tbOpeningInventory, purchaseLedgerCount, new Date().toISOString(), periodId, entityId]
      );
    } else {
      persistence.run(
        `INSERT INTO stock_movement
           (period_id, entity_id, opening_stock_auto, closing_stock_auto, purchases_auto,
            tb_opening_inventory, purchase_ledger_count, balancing_account, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'inventory', ?)`,
        [periodId, entityId, openingAuto, closingAuto, purchasesAuto, tbOpeningInventory, purchaseLedgerCount, new Date().toISOString()]
      );
    }

    rows.push(
      new StockRow({
        entityId,
        entityCode,
        openingAuto,
        openingOverride: existing ? existing.opening_stock_override : null,
        closingAuto,
        closingOverride: existing ? existing.closing_stock_override : null,
        purchasesAuto,
        purchasesOverride: existing ? existing.purchases_override : null,
        purchaseLedgerCount,
        tbOpeningInventory,
        balancingAccount: existing ? existing.balancing_account : "inventory",
      })
    );
  }

  return rows;
}

// Write overrides only. Passing null/undefined leaves that field untouched.
export function saveOverrides(periodId, entityId, { opening = null, closing = null, purchases = null, balancingAccount = null, notes = null, user = null } = {}) {
  const updates = {};
  if (opening !== null) updates.opening_stock_override = opening;
  if (closing !== null) updates.closing_stock_override = closing;
  if (purchases !== null) updates.purchases_override = purchases;
  if (balancingAccount !== null) updates.balancing_account = balancingAccount;
  if (notes !== null) updates.notes = notes;
  if (user !== null) updates.updated_by = user;

  if (Object.keys(updates).length === 0) return;
  updates.updated_at = new Date().toISOString();

  const setClause = Object.keys(updates)
    .map((k) => `${k} = ?`)
    .join(", ");
  const values = [...Object.values(updates), periodId, entityId];

  persistence.run(`UPDATE stock_movement SET ${setClause} WHERE period_id = ? AND entity_id = ?`, values);
}

// Build/replace a draft `inventory_movement` adjustment from the current stock_movement
// state. Two lines per entity with a non-zero delta. Throws if the period is locked.
export function generateAdjustment(periodId, externalRef, user = null) {
  periodRepo.requireOpen(periodId, "generate stock adjustment");

  const stockRows = persistence.all("SELECT * FROM stock_movement WHERE period_id = ?", [periodId]);

  const cogsCategory = groupCoaRepo.getByName("COGS before Direct Cost & Forex Gain/Loss");
  const inventoryCategory = groupCoaRepo.getByName("Inventory");
  const reCategory = groupCoaRepo.getByName("Retained Earnings");

  if (!cogsCategory || !inventoryCategory || !reCategory) {
    throw new Error("Missing required categories: COGS, Inventory, or Retained Earnings");
  }

  const lines = [];
  for (const row of stockRows) {
    const entityCode = persistence.get("SELECT entity_code FROM entities WHERE entity_id = ?", [row.entity_id]).entity_code;
    const stock = new StockRow({
      entityId: row.entity_id,
      entityCode,
      openingAuto: row.opening_stock_auto,
      openingOverride: row.opening_stock_override,
      closingAuto: row.closing_stock_auto,
      closingOverride: row.closing_stock_override,
      purchasesAuto: row.purchases_auto,
      purchasesOverride: row.purchases_override,
      purchaseLedgerCount: row.purchase_ledger_count || 0,
      tbOpeningInventory: row.tb_opening_inventory || 0.0,
      balancingAccount: row.balancing_account,
    });

    const delta = stock.delta;
    if (delta === null || delta === 0) continue;

    const balancingCat = stock.balancingAccount === "inventory" ? inventoryCategory : reCategory;

    if (delta > 0) {
      // Drew down
      lines.push({
        entityId: stock.entityId,
        groupAccountId: cogsCategory.group_account_id,
        debitAmount: delta,
        creditAmount: 0.0,
        lineNarration: `${stock.entityCode}: Stock drawdown`,
      });
      lines.push({
        entityId: stock.entityId,
        groupAccountId: balancingCat.group_account_id,
        debitAmount: 0.0,
        creditAmount: delta,
        lineNarration: `${stock.entityCode}: Stock drawdown (balancing)`,
      });
    } else {
      // Built up (delta < 0)
      lines.push({
        entityId: stock.entityId,
        groupAccountId: balancingCat.group_account_id,
        debitAmount: -delta,
        creditAmount: 0.0,
        lineNarration: `${stock.entityCode}: Stock buildup (balancing)`,
      });
      lines.push({
        entityId: stock.entityId,
        groupAccountId: cogsCategory.group_account_id,
        debitAmount: 0.0,
        creditAmount: -delta,
        lineNarration: `${stock.entityCode}: Stock buildup`,
      });
    }
  }

  return createAdjustment(periodId, externalRef, "inventory_movement", "Stock/COGS adjustment", lines, user);
}
