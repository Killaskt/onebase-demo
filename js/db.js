// One SQLite database (sql.js), persisted to IndexedDB after every write.
// Everything else in the app goes through query() / run().

const IDB_NAME = 'onebase';
const IDB_STORE = 'files';
const IDB_KEY = 'onebase.sqlite';

let SQL = null;
let db = null;

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet() {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const r = d.transaction(IDB_STORE).objectStore(IDB_STORE).get(IDB_KEY);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

async function idbSet(bytes) {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(bytes, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let persistChain = Promise.resolve();
export function persist() {
  const bytes = db.export();
  persistChain = persistChain.then(() => idbSet(bytes)).catch((e) => console.error('persist failed', e));
  return persistChain;
}

// Returns true when a brand new database was created (caller should seed it).
export async function initDb() {
  SQL = await window.initSqlJs({ locateFile: (f) => `vendor/${f}` });
  let saved = null;
  try { saved = await idbGet(); } catch (e) { console.error('could not read saved database', e); }
  db = saved ? new SQL.Database(saved) : new SQL.Database();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  return !saved;
}

export function query(sql, params = []) {
  const st = db.prepare(sql);
  try {
    st.bind(params);
    const rows = [];
    while (st.step()) rows.push(st.getAsObject());
    return rows;
  } finally {
    st.free();
  }
}

export function run(sql, params = []) {
  db.run(sql, params);
  persist();
}

// Several statements, one save.
export function batch(fn) {
  db.run('BEGIN');
  try {
    fn((sql, params = []) => db.run(sql, params));
    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
  persist();
}

export function exportBytes() {
  return db.export();
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function validIdent(name) {
  return IDENT.test(name || '');
}
// Quote an identifier. Only names that pass validIdent ever reach SQL.
export function qi(name) {
  if (!validIdent(name)) throw new Error(`Invalid identifier: ${name}`);
  return `"${name}"`;
}

export function kindOf(declaredType) {
  const t = String(declaredType || '').toUpperCase();
  if (t.includes('DATE') || t.includes('TIME')) return 'date';
  if (/INT|REAL|NUM|FLOA|DOUB|DEC/.test(t)) return 'number';
  return 'text';
}

// The user's tables. App bookkeeping lives in _ob_* tables and is not listed.
export function userTables() {
  return query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_ob\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
  ).map((r) => r.name);
}

// Data columns of a table (the id primary key is left out).
export function columns(table) {
  return query(`PRAGMA table_info(${qi(table)})`)
    .filter((c) => !c.pk)
    .map((c) => ({ name: c.name, type: c.type, kind: kindOf(c.type) }));
}

export function rowCount(table) {
  return query(`SELECT COUNT(*) AS n FROM ${qi(table)}`)[0].n;
}

// What the agent is allowed to see: table and column names with their kinds. No rows.
export function schemaSummary() {
  return userTables().map((t) => ({ table: t, columns: columns(t).map((c) => ({ name: c.name, kind: c.kind })) }));
}

export function createTable(name, cols) {
  const sqlType = { date: 'DATE', number: 'REAL', text: 'TEXT' };
  const defs = cols.map((c) => `${qi(c.key)} ${sqlType[c.kind] || 'TEXT'}`).join(', ');
  run(`CREATE TABLE ${qi(name)} (id INTEGER PRIMARY KEY AUTOINCREMENT, ${defs})`);
}
