// The declarative interface spec: what is allowed in it, and how its data
// needs are matched against the user's tables.
import { columns, userTables, validIdent } from './db.js';

export const KINDS = ['date', 'number', 'text'];
export const AGGS = ['avg', 'max', 'min', 'sum', 'count'];
export const BLOCK_TYPES = ['form', 'stats', 'chart', 'list', 'note'];

// Returns a list of problems. Empty list means the spec is safe to render.
export function validateSpec(spec) {
  const errs = [];
  const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return ['Spec must be a JSON object.'];
  if (!isStr(spec.name)) errs.push('name is required.');
  if (!Array.isArray(spec.needs) || spec.needs.length === 0) errs.push('needs must list at least one table slot.');
  if (!Array.isArray(spec.blocks) || spec.blocks.length === 0) errs.push('blocks must list at least one block.');
  if (errs.length) return errs;

  const slots = {};
  for (const n of spec.needs) {
    if (!n || !validIdent(n.slot)) { errs.push('Each need requires a slot name (letters, digits, underscore).'); continue; }
    if (slots[n.slot]) errs.push(`Duplicate slot "${n.slot}".`);
    if (!['read', 'write'].includes(n.access)) errs.push(`Slot "${n.slot}": access must be "read" or "write".`);
    if (!Array.isArray(n.columns) || n.columns.length === 0) { errs.push(`Slot "${n.slot}": columns are required.`); continue; }
    const cols = {};
    for (const c of n.columns) {
      if (!c || !validIdent(c.key)) { errs.push(`Slot "${n.slot}": each column needs a key.`); continue; }
      if (c.key.toLowerCase() === 'id') errs.push(`Slot "${n.slot}": "id" is reserved.`);
      if (!KINDS.includes(c.kind)) errs.push(`Slot "${n.slot}", column "${c.key}": kind must be date, number or text.`);
      cols[c.key] = c;
    }
    slots[n.slot] = { need: n, cols };
  }

  spec.blocks.forEach((b, i) => {
    const at = `Block ${i + 1}`;
    if (!b || !BLOCK_TYPES.includes(b.type)) { errs.push(`${at}: type must be one of ${BLOCK_TYPES.join(', ')}.`); return; }
    if (b.type === 'note') { if (!isStr(b.text)) errs.push(`${at}: note needs text.`); return; }
    const s = slots[b.slot];
    if (!s) { errs.push(`${at}: unknown slot "${b.slot}".`); return; }
    const col = (key, kinds, what) => {
      const c = s.cols[key];
      if (!c) { errs.push(`${at}: ${what} "${key}" is not a column of slot "${b.slot}".`); return null; }
      if (kinds && !kinds.includes(c.kind)) errs.push(`${at}: ${what} "${key}" must be ${kinds.join(' or ')}.`);
      return c;
    };
    if (b.type === 'form') {
      if (s.need.access !== 'write') errs.push(`${at}: a form needs write access on slot "${b.slot}".`);
      if (!Array.isArray(b.fields) || !b.fields.length) { errs.push(`${at}: form needs fields.`); return; }
      for (const f of b.fields) {
        if (!f) { errs.push(`${at}: empty field.`); continue; }
        col(f.col, null, 'field');
        if (f.options && !Array.isArray(f.options)) errs.push(`${at}: options must be a list.`);
      }
    }
    if (b.type === 'stats') {
      if (!Array.isArray(b.items) || !b.items.length) { errs.push(`${at}: stats needs items.`); return; }
      for (const it of b.items) {
        if (!it || !AGGS.includes(it.agg)) { errs.push(`${at}: agg must be one of ${AGGS.join(', ')}.`); continue; }
        if (it.agg !== 'count') col(it.col, ['number'], 'stat column');
      }
    }
    if (b.type === 'chart') {
      if (!['line', 'bar'].includes(b.kind)) errs.push(`${at}: chart kind must be line or bar.`);
      if (b.agg && !AGGS.includes(b.agg)) errs.push(`${at}: agg must be one of ${AGGS.join(', ')}.`);
      if (b.agg !== 'count' || b.y) col(b.y, ['number'], 'y');
      const xc = col(b.x, ['date', 'text'], 'x');
      if (b.groupBy && !['value', 'month'].includes(b.groupBy)) errs.push(`${at}: groupBy must be "value" or "month".`);
      if (b.groupBy === 'month' && xc && xc.kind !== 'date') errs.push(`${at}: groupBy month needs a date x column.`);
      if (b.groupBy && !b.agg) errs.push(`${at}: a grouped chart needs agg.`);
      if (xc && xc.kind === 'text' && !b.groupBy) errs.push(`${at}: a text x column needs groupBy "value".`);
    }
    if (b.type === 'list') {
      if (!b.cols || typeof b.cols !== 'object') { errs.push(`${at}: list needs cols.`); return; }
      if (!b.cols.title && !b.cols.value) errs.push(`${at}: list needs a title or value column.`);
      for (const k of ['title', 'subtitle', 'value']) if (b.cols[k]) col(b.cols[k], null, `cols.${k}`);
      if (b.sort) {
        col(b.sort.col, null, 'sort column');
        if (!['asc', 'desc'].includes(b.sort.dir)) errs.push(`${at}: sort.dir must be asc or desc.`);
      }
      if (b.filter) col(b.filter.col, null, 'filter column');
      if (b.limit != null && !(Number.isInteger(b.limit) && b.limit > 0 && b.limit <= 200)) errs.push(`${at}: limit must be 1-200.`);
    }
  });
  return errs;
}

// Can this table satisfy a need? Maps each needed column to a real column:
// same name first, then any unused column of the right kind.
export function matchTable(need, table) {
  const cols = columns(table);
  const used = new Set();
  const map = {};
  let nameMatches = 0;
  for (const c of need.columns) {
    const hit = cols.find((t) => t.name.toLowerCase() === c.key.toLowerCase() && t.kind === c.kind);
    if (hit) { map[c.key] = hit.name; used.add(hit.name); nameMatches++; }
  }
  for (const c of need.columns) {
    if (map[c.key]) continue;
    const hit = cols.find((t) => !used.has(t.name) && t.kind === c.kind);
    if (!hit) return { ok: false, table, columns: map, nameMatches };
    map[c.key] = hit.name; used.add(hit.name);
  }
  return { ok: true, table, columns: map, nameMatches };
}

// All tables ranked for a need, plus the one to suggest (null means "create new").
export function candidates(need) {
  const all = userTables().map((t) => matchTable(need, t));
  const ok = all.filter((m) => m.ok).sort((a, b) => b.nameMatches - a.nameMatches);
  const slotHit = ok.find((m) => m.table.toLowerCase() === need.slot.toLowerCase());
  const best = slotHit || (ok[0] && ok[0].nameMatches > 0 ? ok[0] : null);
  return { all, suggested: best ? best.table : null };
}

// After a spec changes, which needs are no longer covered by the current bindings?
export function reconcile(spec, bindings) {
  const next = {};
  const missing = [];
  const tables = userTables();
  for (const need of spec.needs) {
    const b = bindings[need.slot];
    if (!b || !tables.includes(b.table)) { missing.push(need.slot); continue; }
    if (need.access === 'write' && b.access !== 'write') { missing.push(need.slot); continue; }
    const m = matchTable(need, b.table);
    // Keep the user's existing column choices where they still apply.
    const cols = {};
    let ok = true;
    for (const c of need.columns) {
      cols[c.key] = (b.columns && b.columns[c.key]) || m.columns[c.key];
      if (!cols[c.key]) ok = false;
    }
    if (!ok) { missing.push(need.slot); continue; }
    next[need.slot] = { table: b.table, columns: cols, access: b.access };
  }
  return { bindings: next, missing };
}

export function accessLabel(access) {
  return access === 'write' ? 'Read & write' : 'Read only';
}
