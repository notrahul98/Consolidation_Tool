// Port of src/engines/consolidation_engine.py — rolls up mapped entity TB lines + applied
// adjustments into the consolidated TB, mirroring the entity-columns + total matrix layout.
import { persistence } from "../db/persistence.js";
import * as consolidatedRepo from "../db/consolidated-repo.js";

const MATERIALITY_IDR = 0.0; // any non-zero closing balance is "material" for blocking purposes

// Re-stamp each TB line's cached mapped_group_account_id from the current
// entity_coa_mapping state, so consolidate always reflects the latest categorization.
function refreshLineMappings(periodId) {
  persistence.run(
    `UPDATE trial_balance_lines
        SET mapped_group_account_id = (
            SELECT ecm.group_account_id
              FROM entity_coa_mapping ecm
              JOIN trial_balance_imports tbi ON tbi.import_id = trial_balance_lines.import_id
             WHERE ecm.entity_id = tbi.entity_id
               AND ecm.entity_ledger_name = trial_balance_lines.entity_ledger_name
        )
      WHERE import_id IN (
          SELECT import_id FROM trial_balance_imports WHERE period_id = ?
      )`,
    [periodId]
  );
}

function findUnmappedMaterial(periodId) {
  const rows = persistence.all(
    `SELECT tbl.entity_ledger_name, e.entity_code,
            (tbl.closing_dr - tbl.closing_cr) AS balance
       FROM trial_balance_lines tbl
       JOIN trial_balance_imports tbi ON tbl.import_id = tbi.import_id
       JOIN entities e ON tbi.entity_id = e.entity_id
      WHERE tbi.period_id = ? AND tbl.mapped_group_account_id IS NULL`,
    [periodId]
  );
  return rows
    .filter((r) => Math.abs(r.balance) > MATERIALITY_IDR)
    .map((r) => [`${r.entity_code}: ${r.entity_ledger_name}`, r.balance]);
}

function appliedAdjustmentLines(periodId) {
  return persistence.all(
    `SELECT al.entity_id, al.group_account_id,
            SUM(al.debit_amount) AS debit_amount, SUM(al.credit_amount) AS credit_amount
       FROM adjustment_lines al
       JOIN adjustments a ON a.adjustment_id = al.adjustment_id
      WHERE a.period_id = ? AND a.status = 'applied'
      GROUP BY al.entity_id, al.group_account_id`,
    [periodId]
  );
}

export function consolidatePeriod(periodId) {
  const period = persistence.get("SELECT * FROM periods WHERE period_id = ?", [periodId]);
  if (period && period.status === "locked") {
    return { blocked: true, reason: "locked", unmappedMaterial: [], rowsWritten: 0 };
  }

  refreshLineMappings(periodId);

  const unmappedMaterial = findUnmappedMaterial(periodId);
  if (unmappedMaterial.length > 0) {
    return { blocked: true, reason: "unmapped", unmappedMaterial, rowsWritten: 0 };
  }

  consolidatedRepo.clearPeriod(periodId);
  let rowsWritten = 0;

  // entity_tb rows: pure TB data, unaffected by adjustments.
  const entityGroupRows = persistence.all(
    `SELECT tbi.entity_id, tbl.mapped_group_account_id AS group_account_id,
            SUM(tbl.opening_dr) AS opening_dr, SUM(tbl.opening_cr) AS opening_cr,
            SUM(tbl.period_dr) AS period_dr, SUM(tbl.period_cr) AS period_cr,
            SUM(tbl.closing_dr) AS closing_dr, SUM(tbl.closing_cr) AS closing_cr
       FROM trial_balance_lines tbl
       JOIN trial_balance_imports tbi ON tbl.import_id = tbi.import_id
      WHERE tbi.period_id = ? AND tbl.mapped_group_account_id IS NOT NULL
      GROUP BY tbi.entity_id, tbl.mapped_group_account_id`,
    [periodId]
  );

  // total[account] accumulates across entity_tb rows (all entities) + adjustment rows (all
  // entities, including group-level entity_id=NULL ones) — folding adjustments into a
  // separate source_type keeps the entity_tb rows a pure, untouched mirror of the TB.
  const total = new Map(); // group_account_id -> [odr, ocr, pdr, pcr, cdr, ccr]
  const totalFor = (id) => {
    if (!total.has(id)) total.set(id, [0, 0, 0, 0, 0, 0]);
    return total.get(id);
  };

  for (const r of entityGroupRows) {
    consolidatedRepo.insertRow(
      periodId,
      r.group_account_id,
      r.entity_id,
      r.opening_dr,
      r.opening_cr,
      r.period_dr,
      r.period_cr,
      r.closing_dr,
      r.closing_cr,
      "entity_tb"
    );
    rowsWritten++;
    const t = totalFor(r.group_account_id);
    t[0] += r.opening_dr;
    t[1] += r.opening_cr;
    t[2] += r.period_dr;
    t[3] += r.period_cr;
    t[4] += r.closing_dr;
    t[5] += r.closing_cr;
  }

  for (const r of appliedAdjustmentLines(periodId)) {
    const dr = r.debit_amount || 0.0;
    const cr = r.credit_amount || 0.0;
    // Adjustments have no opening dimension — they're a point-in-time correction to this
    // period's movement and closing balance only.
    consolidatedRepo.insertRow(periodId, r.group_account_id, r.entity_id, 0.0, 0.0, dr, cr, dr, cr, "adjustment");
    rowsWritten++;
    const t = totalFor(r.group_account_id);
    t[2] += dr;
    t[3] += cr;
    t[4] += dr;
    t[5] += cr;
  }

  for (const [groupAccountId, [odr, ocr, pdr, pcr, cdr, ccr]] of total.entries()) {
    consolidatedRepo.insertRow(periodId, groupAccountId, null, odr, ocr, pdr, pcr, cdr, ccr, "total");
    rowsWritten++;
  }

  return { blocked: false, unmappedMaterial: [], rowsWritten };
}
