// Port of src/db/repositories/period_repo.py
import { persistence } from "./persistence.js";
import { log as auditLog } from "../services/audit-service.js";

export function getOrCreate(year, month) {
  const row = persistence.get("SELECT period_id FROM periods WHERE year = ? AND month = ?", [year, month]);
  if (row) return row.period_id;
  return persistence.insert("INSERT INTO periods (year, month) VALUES (?, ?)", [year, month]);
}

// "2026-06" -> [2026, 6]
export function parsePeriodStr(periodStr) {
  const [year, month] = periodStr.split("-");
  return [parseInt(year, 10), parseInt(month, 10)];
}

export function getByStr(periodStr) {
  const [year, month] = parsePeriodStr(periodStr);
  return persistence.get("SELECT * FROM periods WHERE year = ? AND month = ?", [year, month]);
}

export function listAll() {
  return persistence.all("SELECT * FROM periods ORDER BY year DESC, month DESC");
}

export function asStr(periodRow) {
  return `${periodRow.year}-${String(periodRow.month).padStart(2, "0")}`;
}

// The chronologically preceding period, if one has been imported.
export function getPrior(periodId) {
  const current = persistence.get("SELECT * FROM periods WHERE period_id = ?", [periodId]);
  const [priorYear, priorMonth] = current.month > 1 ? [current.year, current.month - 1] : [current.year - 1, 12];
  return persistence.get("SELECT * FROM periods WHERE year = ? AND month = ?", [priorYear, priorMonth]);
}

// Guard for every write path that touches a period's data. Throws if locked — the single
// enforcement point every write path (TB import, mapping changes, consolidate, adjustment
// apply, adjustment delete) calls through, so "locked means immutable" is actually true
// everywhere, not just for creating new adjustments.
export function requireOpen(periodId, action = "modify this period") {
  const period = persistence.get("SELECT * FROM periods WHERE period_id = ?", [periodId]);
  if (period && period.status === "locked") {
    throw new Error(`Period ${period.year}-${String(period.month).padStart(2, "0")} is locked; cannot ${action}`);
  }
}

export function lock(periodId, user = null) {
  persistence.run("UPDATE periods SET status = 'locked', locked_at = ?, locked_by = ? WHERE period_id = ?", [
    new Date().toISOString(),
    user,
    periodId,
  ]);
  auditLog("lock", "periods", String(periodId), { user });
}

export function unlock(periodId, user = null) {
  persistence.run("UPDATE periods SET status = 'open', locked_at = NULL, locked_by = NULL WHERE period_id = ?", [
    periodId,
  ]);
  auditLog("unlock", "periods", String(periodId), { user });
}

// Records both a human-readable timestamp and the current high-water mark of
// audit_log.log_id. Staleness detection (below) uses the log_id marker, not the
// timestamp — see migration 005 for why: wall-clock comparison is unreliable when
// operations happen faster than clock resolution.
export function markConsolidated(periodId) {
  const row = persistence.get("SELECT COALESCE(MAX(log_id), 0) AS latest FROM audit_log");
  persistence.run("UPDATE periods SET consolidated_at = ?, consolidated_through_log_id = ? WHERE period_id = ?", [
    new Date().toISOString(),
    row.latest,
    periodId,
  ]);
}

// True when an adjustment for this period has been created, edited, applied, or deleted
// since the last successful consolidate. Compares the audit_log.log_id high-water mark
// recorded at that consolidate against the newest audit_log.log_id for
// table_name='adjustments' on that period's *current* adjustment ids — an adjustment
// deleted after consolidation won't be caught by this (its id no longer resolves to the
// period), which matches the source plan's described approach.
export function isConsolidationStale(periodId) {
  const period = persistence.get("SELECT consolidated_at, consolidated_through_log_id FROM periods WHERE period_id = ?", [periodId]);
  if (!period || period.consolidated_at === null || period.consolidated_at === undefined) return false;

  const adjustmentIds = persistence.all("SELECT adjustment_id FROM adjustments WHERE period_id = ?", [periodId]).map((r) => String(r.adjustment_id));
  if (adjustmentIds.length === 0) return false;

  const placeholders = adjustmentIds.map(() => "?").join(",");
  const row = persistence.get(
    `SELECT MAX(log_id) AS latest FROM audit_log WHERE table_name = 'adjustments' AND record_id IN (${placeholders})`,
    adjustmentIds
  );
  if (!row || row.latest === null || row.latest === undefined) return false;

  return row.latest > period.consolidated_through_log_id;
}
