// renderScreen / submitForm against a real in-memory database (fake-indexeddb + vendored sql.js).
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import * as db from '../../js/db.js';
import { renderScreen, renderBlocks, submitForm } from '../../js/render.js';

const spec = {
  name: 'Trips',
  needs: [{ slot: 'trips', access: 'write', columns: [{ key: 'date', kind: 'date' }, { key: 'miles', kind: 'number' }, { key: 'purpose', kind: 'text' }] }],
  screens: [
    { id: 'home', title: 'Trips', blocks: [
      { type: 'stats', slot: 'trips', items: [{ agg: 'count', label: 'Trips' }] },
      { type: 'button', label: 'Log <a> trip', to: 'log', style: 'primary' },
      { type: 'button', label: 'Other', to: 'log', style: 'secondary' },
      { type: 'button', label: 'History', to: 'history', style: 'link' },
      { type: 'button', label: 'More', to: 'history', style: 'link' }] },
    { id: 'log', title: 'Log', blocks: [{ type: 'form', slot: 'trips', then: 'back', fields: [{ col: 'date' }, { col: 'miles' }, { col: 'purpose', suggest: true }] }] },
    { id: 'history', title: 'History', blocks: [{ type: 'list', slot: 'trips', rule: true, sort: { col: 'miles', dir: 'desc' }, cols: { title: 'purpose', value: 'miles' } }] },
  ],
};
const iface = { spec, bindings: { trips: { table: 'trips', access: 'write', columns: { date: 'date', miles: 'miles', purpose: 'purpose' } } } };

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  db.setWritable(false);
  await db.claimWriter();
  await db.openFromStore();
  db.setWritable(true);
  db.run('DROP TABLE IF EXISTS trips');
  db.run('CREATE TABLE trips (id INTEGER PRIMARY KEY AUTOINCREMENT, date DATE, miles REAL, purpose TEXT)');
});

describe('renderScreen', () => {
  test('home renders buttons as go actions, escaped, with link buttons grouped in one card', () => {
    const html = renderScreen(iface, 'home');
    assert.match(html, /<button class="btn primary wide" data-act="go" data-to="log">Log &lt;a&gt; trip<\/button>/);
    assert.match(html, /<button class="btn wide" data-act="go" data-to="log">Other<\/button>/);
    assert.match(html, /data-act="go" data-to="history"/);
    assert.equal((html.match(/nav-link"/g) || []).length, 2);
    assert.equal((html.match(/<path d="M9 5l7 7-7 7"\/>/g) || []).length, 2);
    assert.match(html, /<div class="card"><button class="row action nav-link"[^]*More[^]*<\/div>/);
    assert.ok(!html.includes('data-form'));
  });
  test('form carries its ref and a unique datalist id', () => {
    const html = renderScreen(iface, 'log');
    assert.match(html, /data-form="log\.0"/);
    assert.match(html, /<datalist id="dl-log-0-purpose">/);
  });
  test('list rule bar and panel use refs; ruleOpen is a ref', () => {
    assert.match(renderScreen(iface, 'history'), /data-act="edit-rule" data-block="history\.0"/);
    assert.match(renderScreen(iface, 'history', { ruleOpen: 'history.0' }), /data-change="rule-sort" data-block="history\.0"/);
    assert.ok(!renderScreen(iface, 'history', { ruleOpen: 'home.0' }).includes('rule-panel'));
  });
  test('renderBlocks renders the home screen; a v1 spec is one "home" screen', () => {
    assert.equal(renderBlocks(iface), renderScreen(iface, 'home'));
    const v1 = { spec: { ...spec, screens: undefined, blocks: spec.screens[1].blocks }, bindings: iface.bindings };
    assert.match(renderBlocks(v1), /data-form="home\.0"/);
  });
});

describe('submitForm', () => {
  const fd = (o) => ({ get: (k) => o[k] });
  test('inserts the row and returns table and then', () => {
    const out = submitForm(iface, 'log.0', fd({ date: '2026-11-20', miles: '12', purpose: 'Client' }));
    assert.deepEqual(out, { table: 'trips', then: 'back' });
    assert.deepEqual(db.query('SELECT date, miles, purpose FROM trips'), [{ date: '2026-11-20', miles: 12, purpose: 'Client' }]);
  });
  test('a bad ref is not a form', () => {
    assert.throws(() => submitForm(iface, 'home.0', fd({})), /Not a form/);
    assert.throws(() => submitForm(iface, 'nope.9', fd({})), /Not a form/);
  });
});
