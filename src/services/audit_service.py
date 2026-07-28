import sqlite3
from datetime import datetime, timezone
import getpass


def log(conn: sqlite3.Connection, action: str, table_name: str, record_id: str,
         old_value: str | None = None, new_value: str | None = None, user: str | None = None) -> None:
    conn.execute(
        """INSERT INTO audit_log (timestamp, user, action, table_name, record_id, old_value, new_value)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            datetime.now(timezone.utc).isoformat(),
            user or getpass.getuser(),
            action,
            table_name,
            record_id,
            old_value,
            new_value,
        ),
    )
