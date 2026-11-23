// One SQLite database (sql.js), persisted to IndexedDB after every write.
// Everything else in the app goes through query() / run().
//
// Data-safety rules this module enforces:
// - "No database yet" (the key is missing) is told apart from "the read failed".
//   A failed or unreadable read throws DbReadError and nothing is ever written.
// - The very first save of a brand new database is create-only: if a record
//   turns up in IndexedDB by then, the save is refused instead of overwriting it.
// - Only the tab that holds the writer claim may save. The claim is a key in the
//   same object store, checked inside the same transaction as every write, so a
//   tab that lost the claim can never save over the active tab's data.

const IDB_NAME = 'onebase';
const IDB_STORE = 'files';
const IDB_KEY = 'onebase.sqlite';
const OWNER_KEY = 'writer';
const IDB_TIMEOUT_MS = 8000;

export const TAB_ID = (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : `t${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

let SQL = null;
let db = null;
let writable = false;
let needsCreate = false;

export class DbReadError extends Error {
  constructor(message, cause) { super(message); this.name = 'DbReadError'; this.cause = cause; }
}
export class ReadOnlyError extends Error {
  constructor() { super('OneBase is open in another tab. Changes here are not saved.'); this.name = 'ReadOnlyError'; }
}
export class NotOwnerError extends Error {
  constructor() { super('Another tab took over OneBase. This change was not saved.'); this.name = 'NotOwnerError'; }
}
export class ExistsError extends Error {
  constructor() { super('Saved data appeared while starting fresh. Nothing was overwritten. Reload to open it.'); this.name = 'ExistsError'; }
}

function idb() {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('IndexedDB did not open in time')); } }, IDB_TIMEOUT_MS);
    let req;
    try { req = indexedDB.open(IDB_NAME, 1); } catch (e) { clearTimeout(timer); reject(e); return; }
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => { clearTimeout(timer); if (done) { req.result.close(); return; } done = true; resolve(req.result); };
    req.onerror = () => { clearTimeout(timer); if (!done) { done = true; reject(req.error); } };
    req.onblocked = () => console.warn('IndexedDB open is blocked by another connection');
  });
}

// Resolves to the saved bytes, or null only when the key is definitely absent.
async function idbGet() {
  const d = await idb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = d.transaction(IDB_STORE);
      const r = tx.objectStore(IDB_STORE).get(IDB_KEY);
      r.onsuccess = () => resolve(r.result === undefined ? null : r.result);
      r.onerror = () => reject(r.error);
      tx.onabort = () => reject(tx.error || new Error('read aborted'));
    });
  } finally {
    d.close();
  }
}

// Writes the database, but only while this tab owns the writer claim
// (and, for a brand new database, only if nothing is stored yet).
async function idbSet(bytes, { createOnly = false } = {}) {
  const d = await idb();
  try {
    await new Promise((resolve, reject) => {
      const tx = d.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      let refused = null;
      const owner = store.get(OWNER_KEY);
      owner.onsuccess = () => {
        if (owner.result !== TAB_ID) { refused = new NotOwnerError(); tx.abort(); return; }
        const write = () => {
          try { store.put(bytes, IDB_KEY); } catch (e) { refused = e; tx.abort(); }
        };
        if (!createOnly) { write(); return; }
        const existing = store.getKey(IDB_KEY);
        existing.onsuccess = () => {
          if (existing.result !== undefined) { refused = new ExistsError(); tx.abort(); return; }
          write();
        };
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(refused || tx.error || new Error('save aborted'));
      tx.onerror = (e) => { if (refused) e.preventDefault(); };
    });
  } finally {
    d.close();
  }
}

// Take the writer claim for this tab. Runs after any in-flight write of the
// previous owner (IndexedDB serialises readwrite transactions on a store).
export async function claimWriter() {
  const d = await idb();
  try {
    await new Promise((resolve, reject) => {
      const tx = d.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(TAB_ID, OWNER_KEY);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('claim aborted'));
    });
  } finally {
    d.close();
  }
}

// ---------- save state ----------

const saveListeners = new Set();
let saveState = { status: 'idle', error: null };
export function onSaveState(fn) { saveListeners.add(fn); return () => saveListeners.delete(fn); }
export function getSaveState() { return saveState; }
function setSaveState(next) {
  saveState = next;
  for (const fn of saveListeners) { try { fn(next); } catch (e) { console.error(e); } }
}

let persistChain = Promise.resolve(true);
let pending = 0;
// Queue a save of the current database. Resolves to true when it reached
// IndexedDB, false when it failed (the failure is reported via onSaveState).
export function persist() {
  if (!writable) {
    const err = new ReadOnlyError();
    setSaveState({ status: 'error', error: err });
    return Promise.resolve(false);
  }
  const bytes = db.export();
  const createOnly = needsCreate;
  needsCreate = false;
  pending++;
  if (saveState.status !== 'error') setSaveState({ status: 'saving', error: null });
  persistChain = persistChain
    .then(() => idbSet(bytes, { createOnly }))
    .then(() => {
      pending--;
      if (pending === 0) setSaveState({ status: 'saved', error: null, at: Date.now() });
      return true;
    }, (e) => {
      pending--;
      console.error('save failed', e);
      if (e instanceof NotOwnerError || e instanceof ExistsError) writable = false;
      setSaveState({ status: 'error', error: e });
      return false;
    });
  return persistChain;
}
export const whenSaved = () => persistChain;
export const retrySave = () => persist();

// ---------- open ----------

export async function loadSql() {
  if (!SQL) SQL = await window.initSqlJs({ locateFile: (f) => `vendor/${f}` });
  return SQL;
}

const toBytes = (v) => (v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null);

// Open the saved database. Returns { fresh: true } only when IndexedDB was read
// successfully and holds no database yet (the caller may seed it). Throws
// DbReadError when the read failed or the stored file can't be opened; in that
// case nothing is written and the stored record is left exactly as it was.
export async function openFromStore() {
  await loadSql();
  let saved;
  try { saved = await idbGet(); } catch (e) { throw new DbReadError(`Couldn't read your saved data (${e && e.message ? e.message : e}).`, e); }
  if (saved === null) {
    if (db) db.close();
    db = new SQL.Database();
    needsCreate = true;
    return { fresh: true };
  }
  const bytes = toBytes(saved);
  if (!bytes) throw new DbReadError('Your saved data is in an unexpected format.');
  let next;
  try {
    next = new SQL.Database(bytes);
    next.exec('SELECT count(*) FROM sqlite_master');
  } catch (e) {
    if (next) next.close();
    throw new DbReadError(`Your saved database couldn't be opened (${e.message || e}).`, e);
  }
  if (db) db.close();
  db = next;
  needsCreate = false;
  return { fresh: false };
}

export function setWritable(v) { writable = !!v; }
export function isWritable() { return writable; }
export const isOpen = () => !!db;

function guard() { if (!writable) throw new ReadOnlyError(); }

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
  guard();
  db.run(sql, params);
  return persist();
}

// Several statements, one save.
export function batch(fn) {
  guard();
  db.run('BEGIN');
  try {
    fn((sql, params = []) => db.run(sql, params));
    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
  return persist();
}

export function exportBytes() {
  return db.export();
}

// ---------- schema helpers ----------

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
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_ob\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid"
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
  return run(`CREATE TABLE ${qi(name)} (id INTEGER PRIMARY KEY AUTOINCREMENT, ${defs})`);
}
