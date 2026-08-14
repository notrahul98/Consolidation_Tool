-- Phase 7: Stock/COGS tracking and consolidation staleness detection

CREATE TABLE IF NOT EXISTS stock_movement (
    stock_id                INTEGER PRIMARY KEY AUTOINCREMENT,
    period_id               INTEGER NOT NULL REFERENCES periods(period_id),
    entity_id               INTEGER NOT NULL REFERENCES entities(entity_id),
    opening_stock_auto      REAL,
    opening_stock_override  REAL,
    closing_stock_auto      REAL,
    closing_stock_override  REAL,
    purchases_auto          REAL,
    purchases_override      REAL,
    tb_opening_inventory    REAL NOT NULL DEFAULT 0,
    purchase_ledger_count   INTEGER NOT NULL DEFAULT 0,
    balancing_account       TEXT NOT NULL DEFAULT 'inventory'
                              CHECK (balancing_account IN ('inventory', 'retained_earnings')),
    notes                   TEXT,
    updated_at              TEXT,
    updated_by              TEXT,
    UNIQUE (period_id, entity_id)
);

ALTER TABLE periods ADD COLUMN consolidated_at TEXT;
