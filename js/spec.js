// The declarative interface spec: what is allowed in it, and how its data
// needs are matched against the user's tables.
import { columns, userTables, validIdent } from './db.js';

export const KINDS = ['date', 'number', 'text'];
export const AGGS = ['avg', 'max', 'min', 'sum', 'count'];
export const BLOCK_TYPES = ['form', 'stats', 'chart', 'list', 'note', 'button'];
export const BUTTON_STYLES = ['primary', 'secondary', 'link'];
export const MAX_SCREENS = 8;
export const MAX_BLOCKS_PER_SCREEN = 8;

// ---- screens (shared contract: validator, renderer, app shell and agent all use these) ----
// A spec has either top-level `blocks` (v1: one screen) or `screens` (v2), never both.
// screens: [{ id, title, blocks }]; the first screen is home. 'back' is not a valid screen id.
// A block is addressed by a ref string "<screenId>.<index>", e.g. "home.0".
export function screensOf(spec) {
  if (spec && Array.isArray(spec.screens)) return spec.screens;
  return [{ id: 'home', title: (spec && spec.name) || '', blocks: (spec && spec.blocks) || [] }];
}
export const homeScreenId = (spec) => screensOf(spec)[0].id;
export const screenById = (spec, id) => screensOf(spec).find((s) => s.id === id) || null;
// Every block with its screen and ref, in order.
export function allBlocks(spec) {
  return screensOf(spec).flatMap((s) => (s.blocks || []).map((block, index) => ({ screen: s.id, index, ref: `${s.id}.${index}`, block })));
}
export function blockAt(spec, ref) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\.(\d+)$/.exec(String(ref));
  if (!m) return null;
  const s = screenById(spec, m[1]);
  return (s && s.blocks && s.blocks[Number(m[2])]) || null;
}

// Returns a list of problems. Empty list means the spec is safe to render.
export function validateSpec(spec) {
  const errs = [];
  const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return ['Spec must be a JSON object.'];
  if (!isStr(spec.name)) errs.push('name is required.');
  if (!Array.isArray(spec.needs) || spec.needs.length === 0) errs.push('needs must list at least one table slot.');
  const hasBlocks = spec.blocks !== undefined && spec.blocks !== null;
  const hasScreens = spec.screens !== undefined && spec.screens !== null;
  if (hasBlocks && hasScreens) errs.push('Use either blocks or screens, not both.');
  else if (hasScreens) {
    if (!Array.isArray(spec.screens) || spec.screens.length === 0) errs.push('screens must list at least one screen.');
    else if (spec.screens.length > MAX_SCREENS) errs.push(`At most ${MAX_SCREENS} screens are allowed.`);
  } else if (!Array.isArray(spec.blocks) || spec.blocks.length === 0) errs.push('blocks must list at least one block.');
  if (errs.length) return errs;

  const slots = {};
  for (const n of spec.needs) {
    if (!n || !validIdent(n.slot)) { errs.push('Each need requires a slot name (letters, digits, underscore).'); continue; }
    if (slots[n.slot]) errs.push(`Duplicate slot "${n.slot}".`);
    if (!['read', 'write'].includes(n.access)) errs.push(`Slot "${n.slot}": access must be "read" or "write".`);
    if (!Array.isArray(n.columns) || n.columns.length === 0) { errs.push(`Slot "${n.slot}": columns are required.`); continue; }
    const cols = {};
    const seenKeys = new Set();
    for (const c of n.columns) {
      if (!c || !validIdent(c.key)) { errs.push(`Slot "${n.slot}": each column needs a key.`); continue; }
      if (c.key.toLowerCase() === 'id') errs.push(`Slot "${n.slot}": "id" is reserved.`);
      if (!KINDS.includes(c.kind)) errs.push(`Slot "${n.slot}", column "${c.key}": kind must be date, number or text.`);
      // SQLite column names are case-insensitive, so "miles" and "Miles" collide.
      const lower = c.key.toLowerCase();
      if (seenKeys.has(lower)) errs.push(`Slot "${n.slot}": duplicate column "${c.key}".`);
      seenKeys.add(lower);
      cols[c.key] = c;
    }
    slots[n.slot] = { need: n, cols };
  }

  const v2 = hasScreens;
  // Screen ids, checked before blocks so button/form targets can be resolved.
  const screenIds = new Set();
  if (v2) {
    for (const sc of spec.screens) {
      if (!sc || typeof sc !== 'object') { errs.push('Each screen must be an object.'); continue; }
      if (!validIdent(sc.id)) errs.push('Each screen needs an id (letters, digits, underscore).');
      else if (sc.id === 'back') errs.push('Screen id "back" is reserved.');
      else if (screenIds.has(sc.id)) errs.push(`Duplicate screen id "${sc.id}".`);
      else screenIds.add(sc.id);
    }
  }
  const targets = new Set();
  const target = (at, what, to) => {
    if (to === 'back') return;
    if (!v2) { errs.push(`${at}: ${what} must be "back" in a single-screen interface.`); return; }
    if (typeof to === 'string' && screenIds.has(to)) { targets.add(to); return; }
    errs.push(`${at}: ${what} goes to unknown screen "${to}".`);
  };

  const checkBlock = (b, at) => {
    if (!b || !BLOCK_TYPES.includes(b.type)) { errs.push(`${at}: type must be one of ${BLOCK_TYPES.join(', ')}.`); return; }
    if (b.type === 'note') { if (!isStr(b.text)) errs.push(`${at}: note needs text.`); return; }
    if (b.type === 'button') {
      if (!isStr(b.label)) errs.push(`${at}: button needs a label.`);
      target(at, 'button "to"', b.to);
      if (b.style != null && !BUTTON_STYLES.includes(b.style)) errs.push(`${at}: button style must be one of ${BUTTON_STYLES.join(', ')}.`);
      return;
    }
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
      if (b.then != null) target(at, 'form "then"', b.then);
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
      // The renderer plots y-less charts only as grouped counts; otherwise y is required.
      const yOptional = !!b.groupBy && b.agg === 'count';
      if (b.y) col(b.y, ['number'], 'y');
      else if (!yOptional) errs.push(`${at}: chart needs a y number column.`);
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
  };

  if (v2) {
    spec.screens.forEach((sc) => {
      if (!sc || typeof sc !== 'object') return;
      const label = sc.id ? `Screen "${sc.id}"` : 'Screen';
      if (!isStr(sc.title)) errs.push(`${label}: title is required.`);
      if (!Array.isArray(sc.blocks) || sc.blocks.length === 0) { errs.push(`${label}: blocks must list at least one block.`); return; }
      if (sc.blocks.length > MAX_BLOCKS_PER_SCREEN) errs.push(`${label}: at most ${MAX_BLOCKS_PER_SCREEN} blocks per screen.`);
      sc.blocks.forEach((b, i) => checkBlock(b, `${label}, block ${i + 1}`));
    });
    for (const id of screenIds) {
      if (id !== spec.screens[0].id && !targets.has(id)) errs.push(`Screen "${id}" can't be reached: add a button or form "then" that goes to it.`);
    }
  } else {
    spec.blocks.forEach((b, i) => checkBlock(b, `Block ${i + 1}`));
  }
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
  // Only suggest a table when it clearly is the one meant: same name as the slot,
  // or every needed column present by name. Otherwise suggest creating a new table.
  const best = slotHit || ok.find((m) => m.nameMatches === need.columns.length) || null;
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
