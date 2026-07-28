import sqlite3
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def connect(db_path: str) -> sqlite3.Connection:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def apply_migrations(conn: sqlite3.Connection) -> None:
    conn.execute(
        """CREATE TABLE IF NOT EXISTS schema_migrations (
            filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )"""
    )
    applied = {row[0] for row in conn.execute("SELECT filename FROM schema_migrations")}
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        if path.name in applied:
            continue
        conn.executescript(path.read_text(encoding="utf-8"))
        conn.execute("INSERT INTO schema_migrations (filename) VALUES (?)", (path.name,))
        conn.commit()


def get_connection(db_path: str) -> sqlite3.Connection:
    conn = connect(db_path)
    apply_migrations(conn)
    return conn
