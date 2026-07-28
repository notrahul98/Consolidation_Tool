import sqlite3

# Maps account_code -> group_account_id, populated in two passes so parent_account_id
# (which references another account_code) can be resolved after all rows exist.


def seed_from_json(conn: sqlite3.Connection, rows: list[dict]) -> None:
    code_to_id: dict[str, int] = {}
    for row in rows:
        existing = conn.execute(
            "SELECT group_account_id FROM group_coa WHERE account_code = ?", (row["account_code"],)
        ).fetchone()
        if existing:
            code_to_id[row["account_code"]] = existing["group_account_id"]
            continue
        cur = conn.execute(
            """INSERT INTO group_coa
               (account_code, account_name, statement_type, section, line_item_order, is_header, normal_balance)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                row["account_code"],
                row["account_name"],
                row["statement_type"],
                row["section"],
                row["line_item_order"],
                1 if row["is_header"] else 0,
                row["normal_balance"],
            ),
        )
        code_to_id[row["account_code"]] = cur.lastrowid

    for row in rows:
        parent_code = row.get("parent_account_id")
        if parent_code:
            conn.execute(
                "UPDATE group_coa SET parent_account_id = ? WHERE group_account_id = ?",
                (code_to_id[parent_code], code_to_id[row["account_code"]]),
            )


def list_leaf_categories(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM group_coa WHERE is_header = 0 ORDER BY statement_type, line_item_order"
    ).fetchall()


def get_by_id(conn: sqlite3.Connection, group_account_id: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM group_coa WHERE group_account_id = ?", (group_account_id,)
    ).fetchone()


def get_by_name(conn: sqlite3.Connection, account_name: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM group_coa WHERE account_name = ? AND is_header = 0", (account_name,)
    ).fetchone()


def list_all(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM group_coa ORDER BY statement_type, line_item_order").fetchall()
