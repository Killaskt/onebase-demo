// db.js against fake-indexeddb and the vendored sql.js: save/load round trip,
// read-failure safety, the single-writer fence, and restore checks.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import * as db from '../../js/db.js';
import { matchTable, candidates, reconcile } from '../../js/spec.js';

const KEY = 'onebase.sqlite';
function raw(mode, fn) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('onebase', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => {
      const tx = r.result.transaction('files', mode);
      let out;
      const req = fn(tx.objectStore('files'));
      if (req) req.onsuccess = () => { out = req.result; };
      tx.oncomplete = () => { r.result.close(); resolve(out); };
      tx.onabort = () => { r.result.close(); reject(tx.error); };
    };
    r.onerror = () => reject(r.error);
  });
}
const rawGet = (k) => raw('readonly', (s) => s.get(k));
const rawPut = (k, v) => raw('readwrite', (s) => s.put(v, k));

// Open as the writer, the way the app boots.
async function boot() {
  db.setWritable(false);
  await db.claimWriter();
  const res = await db.openFromStore();
  db.setWritable(true);
  return res;
}

beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });

describe('save and load round trip', () => {
  test('an empty store opens as fresh, and saved rows come back after reopening', async () => {
    assert.deepEqual(await boot(), { fresh: true });
    db.run('CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, date DATE, score INTEGER, location TEXT)');
    await db.batch((exec) => {
      exec('INSERT INTO games (date, score, location) VALUES (?, ?, ?)', ['2026-11-20', 201, 'Sunset']);
      exec('INSERT INTO games (date, score, location) VALUES (?, ?, ?)', ['2026-11-21', 187, "O'Brien's"]);
    });
    assert.equal(await db.whenSaved(), true);
    assert.equal(db.getSaveState().status, 'saved');
    const stored = await rawGet(KEY);
    assert.ok(stored instanceof Uint8Array && stored.length > 0);

    assert.deepEqual(await boot(), { fresh: false });
    assert.deepEqual(db.query('SELECT date, score, location FROM games ORDER BY id'), [
      { date: '2026-11-20', score: 201, location: 'Sunset' },
      { date: '2026-11-21', score: 187, location: "O'Brien's" },
    ]);
    assert.deepEqual(db.userTables(), ['games']);
    assert.deepEqual(db.columns('games').map((c) => [c.name, c.kind]), [['date', 'date'], ['score', 'number'], ['location', 'text']]);
    assert.equal(db.rowCount('games'), 2);
    assert.deepEqual(db.schemaSummary(), [{ table: 'games', columns: [{ name: 'date', kind: 'date' }, { name: 'score', kind: 'number' }, { name: 'location', kind: 'text' }] }]);
  });

  test('batch rolls back on error and saves nothing new', async () => {
    await boot();
    await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const before = await rawGet(KEY);
    assert.throws(() => db.batch((exec) => { exec("INSERT INTO t (v) VALUES ('a')"); exec('INSERT INTO nope VALUES (1)'); }));
    assert.equal(db.rowCount('t'), 0);
    assert.deepEqual(await rawGet(KEY), before);
  });

  test('exportBytes is a SQLite file', async () => {
    await boot();
    await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    const bytes = db.exportBytes();
    assert.equal(new TextDecoder().decode(bytes.subarray(0, 15)), 'SQLite format 3');
  });
});

describe('a failed read never becomes a fresh start', () => {
  test('a throwing IndexedDB read raises DbReadError and writes nothing', async () => {
    await boot();
    await db.run('CREATE TABLE keep (id INTEGER PRIMARY KEY, v TEXT)');
    const before = await rawGet(KEY);
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (k) { if (k === KEY) throw new DOMException('simulated', 'UnknownError'); return get.call(this, k); };
    try {
      db.setWritable(false);
      await assert.rejects(db.openFromStore(), (e) => e instanceof db.DbReadError && /Couldn't read your saved data/.test(e.message));
    } finally {
      IDBObjectStore.prototype.get = get;
    }
    assert.deepEqual(await rawGet(KEY), before);
  });

  test('unreadable stored bytes raise DbReadError and are left in place', async () => {
    const junk = new Uint8Array(4096).fill(7);
    await rawPut(KEY, junk);
    await db.claimWriter();
    await assert.rejects(db.openFromStore(), db.DbReadError);
    assert.deepEqual(await rawGet(KEY), junk);
  });

  test('the first save of a fresh database is create-only', async () => {
    await boot(); // fresh
    const other = new Uint8Array([1, 2, 3]);
    await rawPut(KEY, other); // a record appears after the fresh open
    assert.equal(await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)'), false);
    assert.ok(db.getSaveState().error instanceof db.ExistsError);
    assert.deepEqual(await rawGet(KEY), other);
    assert.equal(db.isWritable(), false);
  });
});

describe('single-writer guard', () => {
  test('writes are refused while read-only', async () => {
    await boot();
    db.setWritable(false);
    assert.throws(() => db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)'), db.ReadOnlyError);
    assert.throws(() => db.batch(() => {}), db.ReadOnlyError);
  });

  test('a tab that lost the writer claim cannot save over the new writer', async () => {
    await boot();
    await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await rawPut('writer', 'another-tab');
    const before = await rawGet(KEY);
    assert.equal(await db.run("INSERT INTO t (v) VALUES ('stale')"), false);
    assert.ok(db.getSaveState().error instanceof db.NotOwnerError);
    assert.deepEqual(await rawGet(KEY), before);
  });

  test('a failed save can be retried once the cause is gone', async () => {
    await boot();
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (v, k) { if (k === KEY) throw new DOMException('full', 'QuotaExceededError'); return put.call(this, v, k); };
    let ok;
    try { ok = await db.run('CREATE TABLE q (id INTEGER PRIMARY KEY)'); } finally { IDBObjectStore.prototype.put = put; }
    assert.equal(ok, false);
    assert.equal(db.getSaveState().error.name, 'QuotaExceededError');
    assert.equal(await db.retrySave(), true);
    assert.equal(db.getSaveState().status, 'saved');
    await boot();
    assert.deepEqual(db.userTables(), ['q']);
  });
});

describe('restore checks and replace', () => {
  test('inspectSqlite rejects non-SQLite and tiny files', async () => {
    assert.match((await db.inspectSqlite(new Uint8Array(10))).error, /too small/);
    assert.match((await db.inspectSqlite(new TextEncoder().encode('x'.repeat(200)))).error, /not a SQLite database/);
  });

  test('inspectSqlite summarises a valid file and rejects unsupported names', async () => {
    const SQL = await db.loadSql();
    const d = new SQL.Database();
    d.run('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
    d.run("INSERT INTO notes (body) VALUES ('a'), ('b')");
    assert.deepEqual(await db.inspectSqlite(d.export()), { ok: true, summary: { tables: 1, rows: 2, interfaces: 0, hasMeta: false } });
    d.run('CREATE TABLE "bad name" (id INTEGER PRIMARY KEY)');
    assert.match((await db.inspectSqlite(d.export())).error, /isn't supported/);
    d.close();
  });

  test('replaceWith swaps the database and persists it', async () => {
    await boot();
    await db.run('CREATE TABLE old (id INTEGER PRIMARY KEY)');
    const SQL = await db.loadSql();
    const d = new SQL.Database();
    d.run('CREATE TABLE fresh (id INTEGER PRIMARY KEY, v TEXT)');
    d.run("INSERT INTO fresh (v) VALUES ('x')");
    assert.equal(await db.replaceWith(d.export(), (exec) => exec('CREATE TABLE IF NOT EXISTS _ob_interfaces (id TEXT PRIMARY KEY)')), true);
    d.close();
    await boot();
    assert.deepEqual(db.userTables(), ['fresh']);
    assert.equal(db.query("SELECT count(*) n FROM sqlite_master WHERE name = '_ob_interfaces'")[0].n, 1);
  });
});

describe('identifiers and table matching', () => {
  test('qi only quotes safe identifiers', () => {
    assert.equal(db.qi('games'), '"games"');
    for (const bad of ['', '1x', 'a b', 'x"; DROP TABLE t; --', null]) assert.throws(() => db.qi(bad), /Invalid identifier/);
  });
  test('kindOf maps declared types', () => {
    assert.equal(db.kindOf('DATE'), 'date');
    assert.equal(db.kindOf('DATETIME'), 'date');
    assert.equal(db.kindOf('INTEGER'), 'number');
    assert.equal(db.kindOf('REAL'), 'number');
    assert.equal(db.kindOf('TEXT'), 'text');
    assert.equal(db.kindOf(''), 'text');
  });
  test('matchTable, candidates and reconcile', async () => {
    await boot();
    await db.run('CREATE TABLE trips (id INTEGER PRIMARY KEY AUTOINCREMENT, date DATE, miles REAL, purpose TEXT)');
    await db.run('CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, day DATE, amount REAL, category TEXT)');
    const need = { slot: 'trips', access: 'write', columns: [{ key: 'date', kind: 'date' }, { key: 'miles', kind: 'number' }, { key: 'purpose', kind: 'text' }] };
    assert.deepEqual(matchTable(need, 'trips'), { ok: true, table: 'trips', columns: { date: 'date', miles: 'miles', purpose: 'purpose' }, nameMatches: 3 });
    assert.equal(matchTable(need, 'expenses').ok, true); // same kinds, different names
    assert.equal(matchTable(need, 'expenses').nameMatches, 0);
    assert.equal(candidates(need).suggested, 'trips');
    assert.equal(candidates({ ...need, slot: 'drives' }).suggested, 'trips'); // every column matches by name
    assert.equal(candidates({ slot: 'x', access: 'read', columns: [{ key: 'when', kind: 'date' }] }).suggested, null);
    const spec = { needs: [need] };
    assert.deepEqual(reconcile(spec, { trips: { table: 'trips', access: 'write', columns: { date: 'date', miles: 'miles', purpose: 'purpose' } } }).missing, []);
    assert.deepEqual(reconcile(spec, { trips: { table: 'trips', access: 'read', columns: {} } }).missing, ['trips']);
    assert.deepEqual(reconcile(spec, {}).missing, ['trips']);
  });
});

describe('addColumns', () => {
  test('adds columns with the right kinds and keeps every row', async () => {
    await boot();
    await db.run('CREATE TABLE trips (id INTEGER PRIMARY KEY AUTOINCREMENT, date DATE, miles REAL)');
    await db.run("INSERT INTO trips (date, miles) VALUES ('2026-11-01', 12.5), ('2026-11-02', 7)");
    await db.addColumns('trips', [{ key: 'notes', kind: 'text' }, { key: 'sets', kind: 'number' }, { key: 'day', kind: 'date' }]);
    assert.deepEqual(db.columns('trips').map((c) => [c.name, c.kind]), [['date', 'date'], ['miles', 'number'], ['notes', 'text'], ['sets', 'number'], ['day', 'date']]);
    assert.deepEqual(db.query('SELECT date, miles, notes, sets FROM trips ORDER BY id'), [
      { date: '2026-11-01', miles: 12.5, notes: null, sets: null },
      { date: '2026-11-02', miles: 7, notes: null, sets: null },
    ]);
    assert.equal(await db.whenSaved(), true);
    // and it survives a reopen
    await db.openFromStore();
    assert.equal(db.rowCount('trips'), 2);
    assert.ok(db.columns('trips').some((c) => c.name === 'notes'));
  });
  test('refuses unsafe names and read-only mode, changing nothing', async () => {
    await boot();
    await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT)');
    assert.throws(() => db.addColumns('t', [{ key: 'x"; DROP TABLE t; --', kind: 'text' }]), /Invalid identifier/);
    db.setWritable(false);
    assert.throws(() => db.addColumns('t', [{ key: 'b', kind: 'text' }]), /another tab/);
    db.setWritable(true);
    assert.deepEqual(db.columns('t').map((c) => c.name), ['a']);
  });
});
