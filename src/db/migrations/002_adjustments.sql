-- Phase 2: structured double-entry adjustments replacing manual TB edits.

CREATE TABLE IF NOT EXISTS adjustments (
    adjustment_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    period_id           INTEGER NOT NULL REFERENCES periods(period_id),
    external_ref        TEXT,
    adjustment_type      TEXT NOT NULL DEFAULT 'other'
                          CHECK (adjustment_type IN ('reclassification', 'accrual', 'provision',
                              'depreciation', 'tax', 'management', 'ic_elimination',
                              'opening_correction', 'other')),
    narration            TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    created_by           TEXT,
    copied_from_period_id INTEGER REFERENCES periods(period_id),
    status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'applied')),
    UNIQUE (period_id, external_ref)
);

CREATE TABLE IF NOT EXISTS adjustment_lines (
    line_id           INTEGER PRIMARY KEY AUTOINCREMENT,
    adjustment_id     INTEGER NOT NULL REFERENCES adjustments(adjustment_id),
    entity_id         INTEGER REFERENCES entities(entity_id),
    group_account_id  INTEGER NOT NULL REFERENCES group_coa(group_account_id),
    debit_amount      REAL NOT NULL DEFAULT 0,
    credit_amount     REAL NOT NULL DEFAULT 0,
    line_narration    TEXT
);
