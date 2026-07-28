-- Adds 'inventory_movement' as a distinct adjustment_type (stock/COGS reconciliation is a
-- recurring, user-determined monthly entry — same mechanism as any other adjustment, just
-- worth its own tag for clarity in the audit trail and Adj_Bridge reporting).
-- SQLite can't ALTER a CHECK constraint in place, so recreate the table and copy data.
-- foreign_keys must be OFF for this, since adjustment_lines references adjustments and
-- SQLite checks FK validity on DROP TABLE when it's on.

PRAGMA foreign_keys = OFF;

CREATE TABLE adjustments_new (
    adjustment_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    period_id           INTEGER NOT NULL REFERENCES periods(period_id),
    external_ref        TEXT,
    adjustment_type      TEXT NOT NULL DEFAULT 'other'
                          CHECK (adjustment_type IN ('reclassification', 'accrual', 'provision',
                              'depreciation', 'tax', 'management', 'ic_elimination',
                              'opening_correction', 'inventory_movement', 'other')),
    narration            TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    created_by           TEXT,
    copied_from_period_id INTEGER REFERENCES periods(period_id),
    status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'applied')),
    UNIQUE (period_id, external_ref)
);

INSERT INTO adjustments_new SELECT * FROM adjustments;
DROP TABLE adjustments;
ALTER TABLE adjustments_new RENAME TO adjustments;

PRAGMA foreign_keys = ON;
