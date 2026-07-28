-- Phase 1 schema. adjustments/ic_* tables are deliberately not created yet (Phase 2/3).

CREATE TABLE IF NOT EXISTS entities (
    entity_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_code   TEXT NOT NULL UNIQUE,
    entity_name   TEXT NOT NULL,
    is_active     INTEGER NOT NULL DEFAULT 1,
    sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS group_coa (
    group_account_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    account_code       TEXT NOT NULL UNIQUE,
    account_name       TEXT NOT NULL,
    statement_type     TEXT NOT NULL CHECK (statement_type IN ('PL', 'BS')),
    section            TEXT,
    line_item_order    INTEGER NOT NULL,
    parent_account_id  INTEGER REFERENCES group_coa(group_account_id),
    normal_balance      TEXT CHECK (normal_balance IN ('DR', 'CR')),
    is_header          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS entity_coa_mapping (
    mapping_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id          INTEGER NOT NULL REFERENCES entities(entity_id),
    entity_ledger_name TEXT NOT NULL,
    group_account_id   INTEGER REFERENCES group_coa(group_account_id),
    mapping_status     TEXT NOT NULL DEFAULT 'unmapped' CHECK (mapping_status IN ('mapped', 'unmapped', 'ignored')),
    notes              TEXT,
    last_updated_by    TEXT,
    last_updated_at    TEXT,
    UNIQUE (entity_id, entity_ledger_name)
);

CREATE TABLE IF NOT EXISTS periods (
    period_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    year       INTEGER NOT NULL,
    month      INTEGER NOT NULL,
    status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'locked')),
    locked_at  TEXT,
    locked_by  TEXT,
    UNIQUE (year, month)
);

CREATE TABLE IF NOT EXISTS trial_balance_imports (
    import_id              INTEGER PRIMARY KEY AUTOINCREMENT,
    period_id              INTEGER NOT NULL REFERENCES periods(period_id),
    entity_id              INTEGER NOT NULL REFERENCES entities(entity_id),
    source_filename         TEXT NOT NULL,
    imported_at             TEXT NOT NULL,
    imported_by             TEXT,
    row_count               INTEGER NOT NULL,
    checksum                TEXT NOT NULL,
    grand_total_period_dr   REAL,
    grand_total_period_cr   REAL,
    UNIQUE (period_id, entity_id)
);

CREATE TABLE IF NOT EXISTS trial_balance_lines (
    line_id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id               INTEGER NOT NULL REFERENCES trial_balance_imports(import_id),
    entity_ledger_name      TEXT NOT NULL,
    tally_primary_group     TEXT,
    opening_dr              REAL NOT NULL DEFAULT 0,
    opening_cr              REAL NOT NULL DEFAULT 0,
    period_dr               REAL NOT NULL DEFAULT 0,
    period_cr               REAL NOT NULL DEFAULT 0,
    closing_dr              REAL NOT NULL DEFAULT 0,
    closing_cr              REAL NOT NULL DEFAULT 0,
    closing_tie_warning     INTEGER NOT NULL DEFAULT 0,
    mapped_group_account_id INTEGER REFERENCES group_coa(group_account_id)
);

CREATE TABLE IF NOT EXISTS consolidated_tb (
    row_id           INTEGER PRIMARY KEY AUTOINCREMENT,
    period_id        INTEGER NOT NULL REFERENCES periods(period_id),
    group_account_id INTEGER NOT NULL REFERENCES group_coa(group_account_id),
    entity_id        INTEGER REFERENCES entities(entity_id),
    source_type      TEXT NOT NULL DEFAULT 'entity_tb',
    opening_dr       REAL NOT NULL DEFAULT 0,
    opening_cr       REAL NOT NULL DEFAULT 0,
    period_dr        REAL NOT NULL DEFAULT 0,
    period_cr        REAL NOT NULL DEFAULT 0,
    closing_dr       REAL NOT NULL DEFAULT 0,
    closing_cr       REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_log (
    log_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT NOT NULL,
    user        TEXT,
    action      TEXT NOT NULL,
    table_name  TEXT NOT NULL,
    record_id   TEXT,
    old_value   TEXT,
    new_value   TEXT
);
