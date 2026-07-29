// sql.js bootstrap + IndexedDB persistence + backup import/export.
// Mirrors src/db/database.py (connect/apply_migrations) and src/db/seed.py (seed_all),
// but for a WASM SQLite instance living entirely in the browser.

const IDB_NAME = "tally-consolidation";
const IDB_STORE = "kv";
const IDB_KEY = "db_blob";
const SAVE_DEBOUNCE_MS = 800;

const MIGRATION_FILES = [
  "001_init.sql",
  "002_adjustments.sql",
  "003_inventory_movement_type.sql",
];

let db = null;
let SQL = null;
let saveTimer = null;

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetBlob() {
  const idb = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPutBlob(uint8arr) {
  const idb = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(uint8arr, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- migrations -------------------------------------------------------

async function applyMigrationsAsync(baseUrl) {
  db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const applied = new Set(all("SELECT filename FROM schema_migrations").map((r) => r.filename));
  for (const filename of MIGRATION_FILES) {
    if (applied.has(filename)) continue;
    const res = await fetch(`${baseUrl}src/db/migrations/${filename}`);
    const script = await res.text();
    db.run(script);
    db.run("INSERT INTO schema_migrations (filename) VALUES (?)", [filename]);
  }
}

// --- seeding (mirrors src/db/seed.py) ----------------------------------

function upsertEntity(code, name, sortOrder) {
  const existing = get("SELECT entity_id FROM entities WHERE entity_code = ?", [code]);
  if (existing) {
    run("UPDATE entities SET entity_name = ?, sort_order = ? WHERE entity_id = ?", [
      name,
      sortOrder,
      existing.entity_id,
    ]);
    return existing.entity_id;
  }
  return insert("INSERT INTO entities (entity_code, entity_name, sort_order) VALUES (?, ?, ?)", [
    code,
    name,
    sortOrder,
  ]);
}

function seedGroupCoa(rows) {
  const codeToId = {};
  for (const row of rows) {
    const existing = get("SELECT group_account_id FROM group_coa WHERE account_code = ?", [row.account_code]);
    if (existing) {
      codeToId[row.account_code] = existing.group_account_id;
      continue;
    }
    const id = insert(
      `INSERT INTO group_coa
         (account_code, account_name, statement_type, section, line_item_order, is_header, normal_balance)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        row.account_code,
        row.account_name,
        row.statement_type,
        row.section,
        row.line_item_order,
        row.is_header ? 1 : 0,
        row.normal_balance,
      ]
    );
    codeToId[row.account_code] = id;
  }
  for (const row of rows) {
    if (row.parent_account_id) {
      run("UPDATE group_coa SET parent_account_id = ? WHERE group_account_id = ?", [
        codeToId[row.parent_account_id],
        codeToId[row.account_code],
      ]);
    }
  }
}

async function seedAll(baseUrl) {
  const entities = await (await fetch(`${baseUrl}src/db/entities.json`)).json();
  entities.forEach((e, i) => upsertEntity(e.code, e.name, i));
  const coa = await (await fetch(`${baseUrl}src/db/group_coa.json`)).json();
  seedGroupCoa(coa);
}

// --- query helpers -------------------------------------------------------

function run(sql, params = []) {
  db.run(sql, params);
  scheduleSave();
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function get(sql, params = []) {
  const rows = all(sql, params);
  return rows.length ? rows[0] : null;
}

function insert(sql, params = []) {
  db.run(sql, params);
  const id = get("SELECT last_insert_rowid() AS id").id;
  scheduleSave();
  return id;
}

// --- persistence -----------------------------------------------------

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    await idbPutBlob(db.export());
  }, SAVE_DEBOUNCE_MS);
}

async function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await idbPutBlob(db.export());
}

function downloadBackup(filename = "consolidation.db") {
  const blob = new Blob([db.export()], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function loadBackupFile(file, baseUrl) {
  const buf = new Uint8Array(await file.arrayBuffer());
  db = new SQL.Database(buf);
  await applyMigrationsAsync(baseUrl);
  await seedAll(baseUrl);
  await flushSave();
}

async function resetDatabase(baseUrl) {
  db = new SQL.Database();
  await applyMigrationsAsync(baseUrl);
  await seedAll(baseUrl);
  await flushSave();
}

// --- init --------------------------------------------------------------

async function init(baseUrl = "") {
  SQL = await window.initSqlJs({ locateFile: (file) => `${baseUrl}vendor/${file}` });
  const existingBlob = await idbGetBlob();
  db = existingBlob ? new SQL.Database(existingBlob) : new SQL.Database();
  await applyMigrationsAsync(baseUrl);
  await seedAll(baseUrl);
  if (!existingBlob) await flushSave();
  return db;
}

export const persistence = {
  init,
  run,
  all,
  get,
  insert,
  downloadBackup,
  loadBackupFile,
  resetDatabase,
  flushSave,
  get db() {
    return db;
  },
};
