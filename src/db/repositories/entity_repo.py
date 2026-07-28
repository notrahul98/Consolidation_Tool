import sqlite3


def upsert(conn: sqlite3.Connection, code: str, name: str, sort_order: int) -> int:
    row = conn.execute("SELECT entity_id FROM entities WHERE entity_code = ?", (code,)).fetchone()
    if row:
        conn.execute(
            "UPDATE entities SET entity_name = ?, sort_order = ? WHERE entity_id = ?",
            (name, sort_order, row["entity_id"]),
        )
        return row["entity_id"]
    cur = conn.execute(
        "INSERT INTO entities (entity_code, entity_name, sort_order) VALUES (?, ?, ?)",
        (code, name, sort_order),
    )
    return cur.lastrowid


def get_by_code(conn: sqlite3.Connection, code: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM entities WHERE entity_code = ?", (code,)).fetchone()


def list_all(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM entities ORDER BY sort_order").fetchall()
