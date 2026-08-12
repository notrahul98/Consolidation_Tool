"""Stock/COGS movement calculation and adjustment generation."""

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone

from src.db.repositories import period_repo, entity_repo, tb_repo, group_coa_repo, adjustment_repo
from src.engines import adjustment_engine


@dataclass
class StockRow:
    """One row per entity's stock movement for a period."""
    entity_id: int
    entity_code: str
    opening_auto: float | None       # None = no prior period
    opening_override: float | None
    closing_auto: float
    closing_override: float | None
    purchases_auto: float
    purchases_override: float | None
    purchase_ledger_count: int       # 0 => show "nothing mapped" warning
    tb_opening_inventory: float      # current TB's own opening — for the break check
    balancing_account: str

    @property
    def opening(self) -> float | None:
        """Effective opening stock: override if set, else auto."""
        return self.opening_override if self.opening_override is not None else self.opening_auto

    @property
    def closing(self) -> float | None:
        """Effective closing stock: override if set, else auto."""
        return self.closing_override if self.closing_override is not None else self.closing_auto

    @property
    def purchases(self) -> float:
        """Effective purchases: override if set, else auto."""
        return self.purchases_override if self.purchases_override is not None else self.purchases_auto

    @property
    def computed_cogs(self) -> float | None:
        """COGS = opening + purchases - closing"""
        if self.opening is None or self.closing is None:
            return None
        return self.opening + self.purchases - self.closing

    @property
    def tb_cogs(self) -> float:
        """What the P&L shows today: purchases only."""
        return self.purchases_auto

    @property
    def delta(self) -> float | None:
        """Difference between computed COGS and TB COGS: opening - closing"""
        if self.opening is None or self.closing is None:
            return None
        return self.opening - self.closing

    @property
    def opening_break(self) -> float:
        """TB opening inventory minus effective opening stock.

        Non-zero indicates Tally restated stock without a journal entry."""
        if self.opening is None:
            return 0.0
        return self.tb_opening_inventory - self.opening


def refresh(conn: sqlite3.Connection, period_id: int) -> list[StockRow]:
    """Recompute every *_auto from the TBs and prior period, upsert into stock_movement.

    Idempotent — safe to call on every page load. Preserves all *_override values."""

    # Get all entities for this period
    entities = conn.execute(
        """SELECT DISTINCT e.entity_id, e.entity_code
           FROM trial_balance_imports tbi
           JOIN entities e ON tbi.entity_id = e.entity_id
           WHERE tbi.period_id = ?
           ORDER BY e.entity_code""",
        (period_id,),
    ).fetchall()

    period = conn.execute("SELECT * FROM periods WHERE period_id = ?", (period_id,)).fetchone()
    prior_period = None
    if period:
        # Get prior month
        prior_period = period_repo.get_prior(conn, period_id)

    rows = []
    for entity in entities:
        entity_id = entity["entity_id"]
        entity_code = entity["entity_code"]

        # Opening stock = prior period's post-adjustment Inventory closing, per entity
        opening_auto = None
        if prior_period:
            prior_data = conn.execute(
                """SELECT SUM(ctb.closing_dr) - SUM(ctb.closing_cr) AS inventory_balance
                   FROM consolidated_tb ctb
                   JOIN group_coa gc ON gc.group_account_id = ctb.group_account_id
                   WHERE ctb.period_id = ? AND ctb.entity_id = ? AND gc.account_name = 'Inventory'
                         AND ctb.source_type IN ('entity_tb', 'adjustment')
                   GROUP BY ctb.entity_id""",
                (prior_period["period_id"], entity_id),
            ).fetchone()
            if prior_data and prior_data["inventory_balance"] is not None:
                opening_auto = prior_data["inventory_balance"]

        # Closing stock = current TB Inventory closing, per entity
        # Query for ledgers mapped to "Inventory" category
        inventory_category = group_coa_repo.get_by_name(conn, "Inventory")
        closing_auto = 0.0
        tb_opening_inventory = 0.0

        if inventory_category:
            tb_data = conn.execute(
                """SELECT SUM(tbl.closing_dr) - SUM(tbl.closing_cr) AS closing,
                          SUM(tbl.opening_dr) - SUM(tbl.opening_cr) AS opening
                   FROM trial_balance_lines tbl
                   JOIN trial_balance_imports tbi ON tbl.import_id = tbi.import_id
                   JOIN entity_coa_mapping ecm ON ecm.entity_id = tbi.entity_id AND ecm.entity_ledger_name = tbl.entity_ledger_name
                   WHERE tbi.period_id = ? AND tbi.entity_id = ? AND ecm.group_account_id = ?
                   GROUP BY tbi.entity_id""",
                (period_id, entity_id, inventory_category["group_account_id"]),
            ).fetchone()
            if tb_data:
                closing_auto = tb_data["closing"] or 0.0
                tb_opening_inventory = tb_data["opening"] or 0.0

        # Purchases = closing balance on ledgers mapped to "COGS before Direct Cost & Forex Gain/Loss"
        cogs_category = group_coa_repo.get_by_name(conn, "COGS before Direct Cost & Forex Gain/Loss")
        purchases_auto = 0.0
        purchase_ledger_count = 0

        if cogs_category:
            purchases_data = conn.execute(
                """SELECT SUM(tbl.closing_dr) - SUM(tbl.closing_cr) AS purchases,
                          COUNT(DISTINCT tbl.entity_ledger_name) AS ledger_count
                   FROM trial_balance_lines tbl
                   JOIN trial_balance_imports tbi ON tbl.import_id = tbi.import_id
                   JOIN entity_coa_mapping ecm ON ecm.entity_id = tbi.entity_id AND ecm.entity_ledger_name = tbl.entity_ledger_name
                   WHERE tbi.period_id = ? AND tbi.entity_id = ? AND ecm.group_account_id = ?
                   GROUP BY tbi.entity_id""",
                (period_id, entity_id, cogs_category["group_account_id"]),
            ).fetchone()
            if purchases_data:
                purchases_auto = purchases_data["purchases"] or 0.0
                purchase_ledger_count = purchases_data["ledger_count"] or 0

        # Get existing overrides from stock_movement, if any
        existing = conn.execute(
            "SELECT * FROM stock_movement WHERE period_id = ? AND entity_id = ?",
            (period_id, entity_id),
        ).fetchone()

        if existing:
            # Update auto values, preserve overrides
            conn.execute(
                """UPDATE stock_movement
                   SET opening_stock_auto = ?, closing_stock_auto = ?, purchases_auto = ?,
                       tb_opening_inventory = ?, purchase_ledger_count = ?, updated_at = ?
                   WHERE period_id = ? AND entity_id = ?""",
                (opening_auto, closing_auto, purchases_auto, tb_opening_inventory,
                 purchase_ledger_count, datetime.now(timezone.utc).isoformat(),
                 period_id, entity_id),
            )
        else:
            # Insert new row
            conn.execute(
                """INSERT INTO stock_movement
                   (period_id, entity_id, opening_stock_auto, closing_stock_auto, purchases_auto,
                    tb_opening_inventory, purchase_ledger_count, balancing_account, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 'inventory', ?)""",
                (period_id, entity_id, opening_auto, closing_auto, purchases_auto,
                 tb_opening_inventory, purchase_ledger_count,
                 datetime.now(timezone.utc).isoformat()),
            )

        rows.append(StockRow(
            entity_id=entity_id,
            entity_code=entity_code,
            opening_auto=opening_auto,
            opening_override=existing["opening_stock_override"] if existing else None,
            closing_auto=closing_auto,
            closing_override=existing["closing_stock_override"] if existing else None,
            purchases_auto=purchases_auto,
            purchases_override=existing["purchases_override"] if existing else None,
            purchase_ledger_count=purchase_ledger_count,
            tb_opening_inventory=tb_opening_inventory,
            balancing_account=existing["balancing_account"] if existing else "inventory",
        ))

    conn.commit()
    return rows


def save_overrides(conn: sqlite3.Connection, period_id: int, entity_id: int, *,
                   opening: float | None = None, closing: float | None = None,
                   purchases: float | None = None, balancing_account: str | None = None,
                   notes: str | None = None, user: str | None = None) -> None:
    """Write overrides only. Passing None leaves that field untouched.

    To clear an override, the caller must pass the auto value explicitly."""

    updates = {}
    if opening is not None:
        updates["opening_stock_override"] = opening
    if closing is not None:
        updates["closing_stock_override"] = closing
    if purchases is not None:
        updates["purchases_override"] = purchases
    if balancing_account is not None:
        updates["balancing_account"] = balancing_account
    if notes is not None:
        updates["notes"] = notes
    if user is not None:
        updates["updated_by"] = user
    if updates:
        updates["updated_at"] = datetime.now(timezone.utc).isoformat()

        set_clause = ", ".join(f"{k} = ?" for k in updates.keys())
        values = list(updates.values()) + [period_id, entity_id]

        conn.execute(
            f"UPDATE stock_movement SET {set_clause} WHERE period_id = ? AND entity_id = ?",
            values,
        )
        conn.commit()


def generate_adjustment(conn: sqlite3.Connection, period_id: int, external_ref: str,
                        user: str | None = None) -> int:
    """Build/replace a draft `inventory_movement` adjustment from the current stock_movement state.

    Two lines per entity with a non-zero delta. Raises if the period is locked."""

    period_repo.require_open(conn, period_id, "generate stock adjustment")

    # Get all stock rows for this period
    stock_rows = conn.execute(
        """SELECT * FROM stock_movement WHERE period_id = ?""",
        (period_id,),
    ).fetchall()

    # Build adjustment lines
    lines = []
    cogs_category = group_coa_repo.get_by_name(conn, "COGS before Direct Cost & Forex Gain/Loss")
    inventory_category = group_coa_repo.get_by_name(conn, "Inventory")
    re_category = group_coa_repo.get_by_name(conn, "Retained Earnings")

    if not cogs_category or not inventory_category or not re_category:
        raise ValueError("Missing required categories: COGS, Inventory, or Retained Earnings")

    for row in stock_rows:
        # Reconstruct StockRow to use property calculations
        stock = StockRow(
            entity_id=row["entity_id"],
            entity_code=conn.execute(
                "SELECT entity_code FROM entities WHERE entity_id = ?",
                (row["entity_id"],),
            ).fetchone()["entity_code"],
            opening_auto=row["opening_stock_auto"],
            opening_override=row["opening_stock_override"],
            closing_auto=row["closing_stock_auto"],
            closing_override=row["closing_stock_override"],
            purchases_auto=row["purchases_auto"],
            purchases_override=row["purchases_override"],
            purchase_ledger_count=row["purchase_ledger_count"] or 0,
            tb_opening_inventory=row["tb_opening_inventory"] or 0.0,
            balancing_account=row["balancing_account"],
        )

        delta = stock.delta
        if delta is None or delta == 0:
            continue

        # Determine which category is the balancing account
        balancing_cat = inventory_category if stock.balancing_account == "inventory" else re_category

        if delta > 0:  # Drew down
            lines.append({
                "entity_id": stock.entity_id,
                "group_account_id": cogs_category["group_account_id"],
                "debit_amount": delta,
                "credit_amount": 0.0,
                "line_narration": f"{stock.entity_code}: Stock drawdown",
            })
            lines.append({
                "entity_id": stock.entity_id,
                "group_account_id": balancing_cat["group_account_id"],
                "debit_amount": 0.0,
                "credit_amount": delta,
                "line_narration": f"{stock.entity_code}: Stock drawdown (balancing)",
            })
        else:  # Built up (delta < 0)
            lines.append({
                "entity_id": stock.entity_id,
                "group_account_id": balancing_cat["group_account_id"],
                "debit_amount": -delta,
                "credit_amount": 0.0,
                "line_narration": f"{stock.entity_code}: Stock buildup (balancing)",
            })
            lines.append({
                "entity_id": stock.entity_id,
                "group_account_id": cogs_category["group_account_id"],
                "debit_amount": 0.0,
                "credit_amount": -delta,
                "line_narration": f"{stock.entity_code}: Stock buildup",
            })

    # Create or replace the adjustment
    adjustment_id = adjustment_engine.create_adjustment(
        conn, period_id, external_ref, "inventory_movement",
        "Stock/COGS adjustment", lines, user=user,
    )
    return adjustment_id
