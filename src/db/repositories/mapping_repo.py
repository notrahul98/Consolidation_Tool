import sqlite3
from datetime import datetime, timezone

from src.services import audit_service


def ensure_rows_exist(conn: sqlite3.Connection, period_id: int) -> None:
    """Make sure every (entity, ledger) seen in this period's TB has an
    entity_coa_mapping row (starting unmapped) so it shows up for categorization."""
    ledgers = conn.execute(
        """SELECT DISTINCT tbi.entity_id, tbl.entity_ledger_name
           FROM trial_balance_lines tbl
           JOIN trial_balance_imports tbi ON tbl.import_id = tbi.import_id
           WHERE tbi.period_id = ?""",
        (period_id,),
    ).fetchall()
    for row in ledgers:
        conn.execute(
            """INSERT OR IGNORE INTO entity_coa_mapping (entity_id, entity_ledger_name, mapping_status)
               VALUES (?, ?, 'unmapped')""",
            (row["entity_id"], row["entity_ledger_name"]),
        )
    conn.commit()


def distinct_ledgers_for_period(conn: sqlite3.Connection, period_id: int) -> list[dict]:
    """One row per distinct ledger name across all entities, for the Mapping.xlsx export."""
    rows = conn.execute(
        """SELECT tbl.entity_ledger_name, tbl.tally_primary_group, tbi.entity_id,
                  e.entity_code, ecm.group_account_id, ecm.mapping_status,
                  (tbl.closing_dr - tbl.closing_cr) AS closing_balance
           FROM trial_balance_lines tbl
           JOIN trial_balance_imports tbi ON tbl.import_id = tbi.import_id
           JOIN entities e ON tbi.entity_id = e.entity_id
           LEFT JOIN entity_coa_mapping ecm
                  ON ecm.entity_id = tbi.entity_id AND ecm.entity_ledger_name = tbl.entity_ledger_name
           WHERE tbi.period_id = ?
           ORDER BY tbl.entity_ledger_name, e.entity_code""",
        (period_id,),
    ).fetchall()

    by_name: dict[str, dict] = {}
    for r in rows:
        entry = by_name.setdefault(r["entity_ledger_name"], {
            "ledger_name": r["entity_ledger_name"],
            "entities": [],
            "primary_groups": set(),
            "total_balance": 0.0,
            "group_account_ids": set(),
        })
        entry["entities"].append(r["entity_code"])
        if r["tally_primary_group"]:
            entry["primary_groups"].add(r["tally_primary_group"])
        entry["total_balance"] += r["closing_balance"] or 0.0
        if r["group_account_id"]:
            entry["group_account_ids"].add(r["group_account_id"])

    return list(by_name.values())


def apply_mapping(conn: sqlite3.Connection, ledger_name: str, group_account_id: int | None,
                    user: str | None = None) -> int:
    """Apply a category to every entity where this ledger name appears. Returns rows affected."""
    rows = conn.execute(
        "SELECT mapping_id, entity_id, group_account_id FROM entity_coa_mapping WHERE entity_ledger_name = ?",
        (ledger_name,),
    ).fetchall()
    status = "mapped" if group_account_id else "unmapped"
    for row in rows:
        if row["group_account_id"] != group_account_id:
            audit_service.log(
                conn, "map", "entity_coa_mapping", str(row["mapping_id"]),
                old_value=str(row["group_account_id"]), new_value=str(group_account_id), user=user,
            )
        conn.execute(
            """UPDATE entity_coa_mapping
               SET group_account_id = ?, mapping_status = ?, last_updated_by = ?, last_updated_at = ?
               WHERE mapping_id = ?""",
            (group_account_id, status, user, datetime.now(timezone.utc).isoformat(), row["mapping_id"]),
        )
    return len(rows)


def apply_mapping_for_entity(conn: sqlite3.Connection, entity_id: int, ledger_name: str,
                               group_account_id: int | None, user: str | None = None) -> None:
    """Like apply_mapping, but scoped to a single entity — for ledgers that are booked
    to different categories in different entities (e.g. the same ledger name treated
    as a liability in one entity and an expense in another)."""
    row = conn.execute(
        "SELECT mapping_id, group_account_id FROM entity_coa_mapping WHERE entity_id = ? AND entity_ledger_name = ?",
        (entity_id, ledger_name),
    ).fetchone()
    if row is None:
        return
    status = "mapped" if group_account_id else "unmapped"
    if row["group_account_id"] != group_account_id:
        audit_service.log(
            conn, "map", "entity_coa_mapping", str(row["mapping_id"]),
            old_value=str(row["group_account_id"]), new_value=str(group_account_id), user=user,
        )
    conn.execute(
        """UPDATE entity_coa_mapping
           SET group_account_id = ?, mapping_status = ?, last_updated_by = ?, last_updated_at = ?
           WHERE mapping_id = ?""",
        (group_account_id, status, user, datetime.now(timezone.utc).isoformat(), row["mapping_id"]),
    )


def get_mapping(conn: sqlite3.Connection, entity_id: int, ledger_name: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM entity_coa_mapping WHERE entity_id = ? AND entity_ledger_name = ?",
        (entity_id, ledger_name),
    ).fetchone()
