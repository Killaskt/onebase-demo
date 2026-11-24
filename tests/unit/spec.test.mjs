// validateSpec: the safety gate between a spec (catalog, agent or file) and the renderer.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateSpec, KINDS, AGGS, BLOCK_TYPES, accessLabel } from '../../js/spec.js';
import { CATALOG } from '../../js/seed.js';
import { SCRIPTED_NEW } from '../../js/agent.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const base = () => ({
  name: 'Trips',
  needs: [{ slot: 'trips', access: 'write', columns: [
    { key: 'date', kind: 'date' }, { key: 'miles', kind: 'number' }, { key: 'purpose', kind: 'text' }] }],
  blocks: [{ type: 'note', text: 'hi' }],
});
const withBlock = (b, mut) => { const s = base(); s.blocks = [b]; if (mut) mut(s); return s; };
const errsFor = (b, mut) => validateSpec(withBlock(b, mut));

describe('valid specs', () => {
  for (const item of CATALOG.filter((c) => c.spec)) {
    test(`catalog spec "${item.spec.name}" is valid`, () => assert.deepEqual(validateSpec(item.spec), []));
  }
  for (const s of SCRIPTED_NEW) {
    test(`scripted spec "${s.spec.name}" is valid`, () => assert.deepEqual(validateSpec(s.spec), []));
  }
  test('every block type in a minimal valid form', () => {
    const blocks = [
      { type: 'form', slot: 'trips', fields: [{ col: 'miles' }, { col: 'purpose', options: ['Work', 'Home'] }] },
      { type: 'stats', slot: 'trips', items: [{ agg: 'sum', col: 'miles' }, { agg: 'count' }] },
      { type: 'chart', slot: 'trips', kind: 'line', x: 'date', y: 'miles' },
      { type: 'chart', slot: 'trips', kind: 'bar', x: 'purpose', y: 'miles', groupBy: 'value', agg: 'avg' },
      { type: 'chart', slot: 'trips', kind: 'bar', x: 'date', y: 'miles', groupBy: 'month', agg: 'sum' },
      { type: 'list', slot: 'trips', cols: { title: 'purpose', value: 'miles' }, sort: { col: 'date', dir: 'desc' }, filter: { col: 'purpose', value: 'Work' }, limit: 5 },
      { type: 'note', text: 'Plain note' },
    ];
    const s = base(); s.blocks = blocks;
    assert.deepEqual(validateSpec(s), []);
  });
  test('vocabulary constants', () => {
    assert.deepEqual(KINDS, ['date', 'number', 'text']);
    assert.deepEqual(AGGS, ['avg', 'max', 'min', 'sum', 'count']);
    assert.deepEqual(BLOCK_TYPES, ['form', 'stats', 'chart', 'list', 'note']);
    assert.equal(accessLabel('write'), 'Read & write');
    assert.equal(accessLabel('read'), 'Read only');
  });
});

describe('invalid top level', () => {
  for (const [label, spec] of [['null', null], ['array', []], ['string', 'spec'], ['number', 3]]) {
    test(`rejects ${label}`, () => assert.deepEqual(validateSpec(spec), ['Spec must be a JSON object.']));
  }
  test('missing name, needs and blocks', () => {
    const e = validateSpec({});
    assert.ok(e.some((x) => /name is required/.test(x)));
    assert.ok(e.some((x) => /needs must list/.test(x)));
    assert.ok(e.some((x) => /blocks must list/.test(x)));
  });
  test('empty needs and blocks', () => {
    const s = base(); s.needs = []; s.blocks = [];
    assert.equal(validateSpec(s).length, 2);
  });
});

describe('invalid needs', () => {
  const needErr = (mut, re) => { const s = base(); mut(s); const e = validateSpec(s); assert.ok(e.some((x) => re.test(x)), `expected ${re} in ${JSON.stringify(e)}`); };
  test('slot must be an identifier', () => needErr((s) => { s.needs[0].slot = 'bad slot'; }, /slot name/));
  test('SQL-ish slot is rejected', () => needErr((s) => { s.needs[0].slot = 'x"; DROP TABLE games; --'; }, /slot name/));
  test('duplicate slot', () => needErr((s) => { s.needs.push(clone(s.needs[0])); }, /Duplicate slot/));
  test('access must be read or write', () => needErr((s) => { s.needs[0].access = 'admin'; }, /access must be/));
  test('columns required', () => needErr((s) => { s.needs[0].columns = []; }, /columns are required/));
  test('column key must be an identifier', () => needErr((s) => { s.needs[0].columns[0].key = '1date'; }, /each column needs a key/));
  test('"id" is reserved', () => needErr((s) => { s.needs[0].columns[0].key = 'ID'; }, /reserved/));
  test('unknown kind', () => needErr((s) => { s.needs[0].columns[0].kind = 'blob'; }, /kind must be/));
});

describe('unknown and invalid blocks', () => {
  test('unknown block type is rejected', () => assert.match(errsFor({ type: 'map', slot: 'trips' })[0], /type must be one of form, stats, chart, list, note/));
  test('missing block type is rejected', () => assert.match(errsFor({ slot: 'trips' })[0], /type must be one of/));
  test('null block is rejected', () => assert.match(errsFor(null)[0], /type must be one of/));
  test('unknown slot', () => assert.match(errsFor({ type: 'stats', slot: 'nope', items: [{ agg: 'count' }] })[0], /unknown slot "nope"/));
  test('note needs text', () => assert.match(errsFor({ type: 'note', text: '  ' })[0], /note needs text/));
  test('form needs write access', () => assert.ok(errsFor({ type: 'form', slot: 'trips', fields: [{ col: 'miles' }] }, (s) => { s.needs[0].access = 'read'; }).some((e) => /needs write access/.test(e))));
  test('form needs fields', () => assert.match(errsFor({ type: 'form', slot: 'trips', fields: [] })[0], /form needs fields/));
  test('form field must be a declared column', () => assert.match(errsFor({ type: 'form', slot: 'trips', fields: [{ col: 'speed' }] })[0], /not a column/));
  test('form options must be a list', () => assert.match(errsFor({ type: 'form', slot: 'trips', fields: [{ col: 'purpose', options: 'Work' }] })[0], /options must be a list/));
  test('stats needs items', () => assert.match(errsFor({ type: 'stats', slot: 'trips', items: [] })[0], /stats needs items/));
  test('stats agg allow-list', () => assert.match(errsFor({ type: 'stats', slot: 'trips', items: [{ agg: 'median', col: 'miles' }] })[0], /agg must be one of/));
  test('stats column must be a number', () => assert.match(errsFor({ type: 'stats', slot: 'trips', items: [{ agg: 'sum', col: 'purpose' }] })[0], /must be number/));
  test('chart kind', () => assert.ok(errsFor({ type: 'chart', slot: 'trips', kind: 'pie', x: 'date', y: 'miles' }).some((e) => /line or bar/.test(e))));
  test('grouped chart needs agg', () => assert.ok(errsFor({ type: 'chart', slot: 'trips', kind: 'bar', x: 'purpose', y: 'miles', groupBy: 'value' }).some((e) => /needs agg/.test(e))));
  test('month grouping needs a date x', () => assert.ok(errsFor({ type: 'chart', slot: 'trips', kind: 'bar', x: 'purpose', y: 'miles', groupBy: 'month', agg: 'sum' }).some((e) => /needs a date x/.test(e))));
  test('text x needs groupBy value', () => assert.ok(errsFor({ type: 'chart', slot: 'trips', kind: 'bar', x: 'purpose', y: 'miles' }).some((e) => /needs groupBy "value"/.test(e))));
  test('bad groupBy', () => assert.ok(errsFor({ type: 'chart', slot: 'trips', kind: 'bar', x: 'date', y: 'miles', groupBy: 'week', agg: 'sum' }).some((e) => /groupBy must be/.test(e))));
  test('list needs cols', () => assert.match(errsFor({ type: 'list', slot: 'trips' })[0], /list needs cols/));
  test('list needs title or value', () => assert.match(errsFor({ type: 'list', slot: 'trips', cols: { subtitle: 'date' } })[0], /title or value/));
  test('list sort dir', () => assert.ok(errsFor({ type: 'list', slot: 'trips', cols: { title: 'purpose' }, sort: { col: 'date', dir: 'up' } }).some((e) => /asc or desc/.test(e))));
  test('list limit range', () => {
    for (const limit of [0, 201, 2.5, '5']) assert.ok(errsFor({ type: 'list', slot: 'trips', cols: { title: 'purpose' }, limit }).some((e) => /limit must be 1-200/.test(e)), `limit ${limit}`);
  });
  test('list filter column must exist', () => assert.ok(errsFor({ type: 'list', slot: 'trips', cols: { title: 'purpose' }, filter: { col: 'nope', value: 1 } }).some((e) => /filter column/.test(e))));
});

describe('known gaps from the codebase audit (not fixed; tracked as todo)', () => {
  test('ungrouped count chart with no y should be rejected (the renderer needs y)', { todo: 'audit P1 #5: validator accepts it' }, () => {
    assert.notDeepEqual(errsFor({ type: 'chart', slot: 'trips', kind: 'line', x: 'date', agg: 'count' }), []);
  });
  test('duplicate column keys should be rejected', { todo: 'audit P1 #6: validator accepts them' }, () => {
    const s = base(); s.needs[0].columns.push({ key: 'Date', kind: 'date' });
    assert.notDeepEqual(validateSpec(s), []);
  });
});
