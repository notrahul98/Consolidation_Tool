// Port of src/db/repositories/group_coa_repo.py (read helpers — seeding lives in persistence.js)
import { persistence } from "./persistence.js";

export function listLeafCategories() {
  return persistence.all("SELECT * FROM group_coa WHERE is_header = 0 ORDER BY statement_type, line_item_order");
}

export function getById(groupAccountId) {
  return persistence.get("SELECT * FROM group_coa WHERE group_account_id = ?", [groupAccountId]);
}

export function getByName(accountName) {
  return persistence.get("SELECT * FROM group_coa WHERE account_name = ? AND is_header = 0", [accountName]);
}

export function listAll() {
  return persistence.all("SELECT * FROM group_coa ORDER BY statement_type, line_item_order");
}
