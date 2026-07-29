// Port of src/db/repositories/entity_repo.py (read helpers only — upsert lives in persistence.js's seed step)
import { persistence } from "./persistence.js";

export function getByCode(code) {
  return persistence.get("SELECT * FROM entities WHERE entity_code = ?", [code]);
}

export function listAll() {
  return persistence.all("SELECT * FROM entities ORDER BY sort_order");
}
