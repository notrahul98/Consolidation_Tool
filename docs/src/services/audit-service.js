// Port of src/services/audit_service.py
import { persistence } from "../db/persistence.js";

export function log(action, tableName, recordId, { oldValue = null, newValue = null, user = null } = {}) {
  persistence.run(
    `INSERT INTO audit_log (timestamp, user, action, table_name, record_id, old_value, new_value)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [new Date().toISOString(), user || "browser-user", action, tableName, recordId, oldValue, newValue]
  );
}
