// Turns a spec + bindings into HTML and parameterised SQL. Nothing in a spec is ever executed as code.
import { query, run, qi } from './db.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(v) {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(String(v));
  if (!m) return String(v);
  const mon = MONTHS[Number(m[2]) - 1] || m[2];
  if (!m[3]) return `${mon} ${m[1]}`;
  const sameYear = Number(m[1]) === new Date().getFullYear();
  return `${mon} ${Number(m[3])}${sameYear ? '' : `, ${m[1]}`}`;
}
function fmtNum(v, format, decimals) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (format === 'currency') return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (Number.isInteger(n) && !decimals) return n.toLocaleString('en-US');
  return n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
function fmt(v, meta, opts = {}) {
  if (v === null || v === undefined || v === '') return '—';
  if (meta && meta.kind === 'date') return fmtDate(v);
  if (meta && meta.kind === 'number') return fmtNum(v, meta.format, opts.decimals);
  return String(v);
}

function helpers(iface) {
  const need = (slot) => iface.spec.needs.find((n) => n.slot === slot);
  const bind = (slot) => {
    const b = iface.bindings[slot];
    if (!b) throw new Error(`No table bound to "${slot}"`);
    return b;
  };
  return {
    need,
    T: (slot) => qi(bind(slot).table),
    C: (slot, key) => qi(bind(slot).columns[key]),
    meta: (slot, key) => need(slot).columns.find((c) => c.key === key),
    table: (slot) => bind(slot).table,
  };
}

function colLabel(meta) {
  return meta.label || meta.key.charAt(0).toUpperCase() + meta.key.slice(1);
}

// ---- blocks ----

function formBlock(b, i, h) {
  const fields = b.fields.map((f) => {
    const meta = h.meta(b.slot, f.col);
    const label = esc(f.label || colLabel(meta));
    const name = esc(f.col);
    let input;
    if (Array.isArray(f.options) && f.options.length) {
      input = `<select name="${name}">${f.options.map((o) => `<option>${esc(o)}</option>`).join('')}</select>`;
    } else if (meta.kind === 'date') {
      input = `<input type="date" name="${name}" value="${new Date().toLocaleDateString('en-CA')}" required>`;
    } else if (meta.kind === 'number') {
      const attrs = ['min', 'max', 'step'].filter((k) => f[k] != null).map((k) => `${k}="${esc(f[k])}"`).join(' ');
      input = `<input type="number" inputmode="decimal" name="${name}" ${attrs} ${f.step == null ? 'step="any"' : ''} placeholder="${esc(f.placeholder || '')}" required>`;
    } else {
      let list = '';
      if (f.suggest) {
        const vals = query(`SELECT DISTINCT ${h.C(b.slot, f.col)} AS v FROM ${h.T(b.slot)} WHERE ${h.C(b.slot, f.col)} IS NOT NULL ORDER BY 1 LIMIT 30`);
        list = `<datalist id="dl-${i}-${name}">${vals.map((r) => `<option value="${esc(r.v)}">`).join('')}</datalist>`;
      }
      input = `<input type="text" name="${name}" placeholder="${esc(f.placeholder || '')}" ${f.suggest ? `list="dl-${i}-${name}"` : ''} autocomplete="off" required>${list}`;
    }
    return `<label class="row field"><span class="field-label">${label}</span>${input}</label>`;
  }).join('');
  return `<section class="block">
    ${b.title ? `<h3 class="block-title">${esc(b.title)}</h3>` : ''}
    <form class="card form" data-form="${i}">
      ${fields}
      <div class="form-foot"><button class="btn primary" type="submit">${esc(b.submit || 'Save')}</button>
      <span class="hint">Writes to <b>${esc(h.table(b.slot))}</b></span></div>
    </form>
  </section>`;
}

function statsBlock(b, h) {
  const items = b.items.map((it) => {
    const expr = it.agg === 'count' ? 'COUNT(*)' : `${it.agg.toUpperCase()}(${h.C(b.slot, it.col)})`;
    const v = query(`SELECT ${expr} AS v FROM ${h.T(b.slot)}`)[0].v;
    const meta = it.agg === 'count' ? { kind: 'number' } : h.meta(b.slot, it.col);
    return `<div class="stat"><div class="stat-value">${esc(fmt(v, meta, { decimals: it.agg === 'avg' }))}</div><div class="stat-label">${esc(it.label || it.agg)}</div></div>`;
  }).join('');
  return `<section class="block">${b.title ? `<h3 class="block-title">${esc(b.title)}</h3>` : ''}<div class="stats" style="--n:${b.items.length}">${items}</div></section>`;
}

function lineChart(points, yMeta) {
  const W = 320, H = 150, L = 8, R = 8, Tp = 18, B = 22;
  const ys = points.map((p) => Number(p.y));
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
  const X = (i) => L + (points.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (points.length - 1));
  const Y = (v) => Tp + (1 - (v - lo) / (hi - lo)) * (H - Tp - B);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(Number(p.y)).toFixed(1)}`).join(' ');
  const area = `${path} L${X(points.length - 1).toFixed(1)},${H - B} L${X(0).toFixed(1)},${H - B} Z`;
  const iMax = ys.indexOf(Math.max(...ys));
  const last = points.length - 1;
  const dots = points.map((p, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(Number(p.y)).toFixed(1)}" r="${i === last || i === iMax ? 3.5 : 2}" class="${i === last || i === iMax ? 'dot strong' : 'dot'}"/>`).join('');
  const lab = (i) => {
    const x = Math.min(Math.max(X(i), 18), W - 18);
    return `<text x="${x.toFixed(1)}" y="${(Y(ys[i]) - 8).toFixed(1)}" text-anchor="middle" class="pt-label">${esc(fmt(ys[i], yMeta))}</text>`;
  };
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Trend chart">
    <line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" class="axis"/>
    <path d="${area}" class="area"/><path d="${path}" class="line"/>${dots}
    ${lab(iMax)}${last !== iMax ? lab(last) : ''}
    <text x="${L}" y="${H - 6}" class="ax-label">${esc(fmtDate(points[0].x))}</text>
    <text x="${W - R}" y="${H - 6}" text-anchor="end" class="ax-label">${esc(fmtDate(points[last].x))}</text>
  </svg>`;
}

function barChart(rows, yMeta, xIsDate) {
  const max = Math.max(...rows.map((r) => Number(r.v)), 0) || 1;
  return `<div class="bars">${rows.map((r) => `<div class="bar-row">
      <span class="bar-name">${esc(xIsDate ? fmtDate(r.g) : r.g ?? '—')}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.max(2, (Number(r.v) / max) * 100).toFixed(1)}%"></span></span>
      <span class="bar-val">${esc(fmt(r.v, yMeta, { decimals: !Number.isInteger(Number(r.v)) }))}</span>
    </div>`).join('')}</div>`;
}

function chartBlock(b, h) {
  const t = h.T(b.slot);
  const x = h.C(b.slot, b.x);
  const xMeta = h.meta(b.slot, b.x);
  const yMeta = b.y ? h.meta(b.slot, b.y) : { kind: 'number' };
  let body;
  if (b.groupBy) {
    const g = b.groupBy === 'month' ? `substr(${x}, 1, 7)` : x;
    const agg = b.agg === 'count' ? 'COUNT(*)' : `${b.agg.toUpperCase()}(${h.C(b.slot, b.y)})`;
    const order = b.groupBy === 'month' ? '1 ASC' : '2 DESC';
    const rows = query(`SELECT ${g} AS g, ${agg} AS v FROM ${t} GROUP BY 1 ORDER BY ${order} LIMIT 12`);
    const meta = b.agg === 'count' ? { kind: 'number' } : yMeta;
    body = rows.length ? (b.kind === 'line' && rows.length > 1
      ? lineChart(rows.map((r) => ({ x: r.g, y: r.v })), meta)
      : barChart(rows, meta, b.groupBy === 'month')) : '<p class="empty">No data yet.</p>';
  } else {
    let rows = query(`SELECT ${x} AS x, ${h.C(b.slot, b.y)} AS y FROM ${t} WHERE ${x} IS NOT NULL AND ${h.C(b.slot, b.y)} IS NOT NULL ORDER BY ${x} ASC, rowid ASC`);
    rows = rows.slice(-(b.limit || 30));
    if (!rows.length) body = '<p class="empty">No data yet.</p>';
    else if (b.kind === 'bar') body = barChart(rows.slice(-12).map((r) => ({ g: r.x, v: r.y })), yMeta, xMeta.kind === 'date');
    else body = lineChart(rows, yMeta);
  }
  return `<section class="block">${b.title ? `<h3 class="block-title">${esc(b.title)}</h3>` : ''}<div class="card pad">${body}</div></section>`;
}

export function describeRule(b, iface) {
  const h = helpers(iface);
  const parts = [];
  if (b.sort) parts.push(sortLabel(h.meta(b.slot, b.sort.col), b.sort.dir));
  if (b.filter && b.filter.value != null) parts.push(`only ${b.filter.value}`);
  parts.push(`top ${b.limit || 5}`);
  return parts.join(' · ');
}

function sortLabel(meta, dir) {
  if (meta.kind === 'date') return dir === 'desc' ? 'Most recent' : 'Oldest first';
  if (meta.kind === 'number') return `${dir === 'desc' ? 'Highest' : 'Lowest'} ${colLabel(meta).toLowerCase()}`;
  return `${colLabel(meta)} ${dir === 'desc' ? 'Z to A' : 'A to Z'}`;
}

// Choices offered by the "Edit ranking rule" sheet for a list block.
export function ruleOptions(iface, b) {
  const h = helpers(iface);
  const need = h.need(b.slot);
  const sorts = [];
  for (const c of need.columns) {
    if (c.kind === 'text') continue;
    for (const dir of ['desc', 'asc']) sorts.push({ col: c.key, dir, label: sortLabel(c, dir) });
  }
  const filters = need.columns.filter((c) => c.kind === 'text').map((c) => ({
    col: c.key,
    label: colLabel(c),
    values: query(`SELECT DISTINCT ${h.C(b.slot, c.key)} AS v FROM ${h.T(b.slot)} WHERE ${h.C(b.slot, c.key)} IS NOT NULL ORDER BY 1`).map((r) => r.v),
  }));
  return { sorts, filters };
}

function listBlock(b, i, h, iface, open) {
  const keys = [...new Set([b.cols.title, b.cols.subtitle, b.cols.value].filter(Boolean))];
  const sel = keys.map((k) => `${h.C(b.slot, k)} AS ${qi(k)}`).join(', ');
  const params = [];
  let where = '';
  if (b.filter && b.filter.value != null) { where = `WHERE ${h.C(b.slot, b.filter.col)} = ?`; params.push(b.filter.value); }
  const order = b.sort ? `ORDER BY ${h.C(b.slot, b.sort.col)} ${b.sort.dir === 'asc' ? 'ASC' : 'DESC'}, rowid DESC` : 'ORDER BY rowid DESC';
  const rows = query(`SELECT ${sel} FROM ${h.T(b.slot)} ${where} ${order} LIMIT ${Number(b.limit) || 5}`, params);
  const m = (k) => h.meta(b.slot, k);
  const items = rows.map((r, n) => `<div class="row item">
      ${b.rule ? `<span class="rank">${n + 1}</span>` : ''}
      <span class="item-main"><span class="item-title">${esc(b.cols.title ? fmt(r[b.cols.title], m(b.cols.title)) : '')}</span>
      ${b.cols.subtitle ? `<span class="item-sub">${esc(fmt(r[b.cols.subtitle], m(b.cols.subtitle)))}</span>` : ''}</span>
      ${b.cols.value ? `<span class="item-value">${esc(fmt(r[b.cols.value], m(b.cols.value)))}</span>` : ''}
    </div>`).join('');
  const rule = b.rule ? `<button class="rule-bar" data-act="edit-rule" data-block="${i}">
      <span class="rule-text"><span class="rule-cap">Ranking rule</span>${esc(describeRule(b, iface))}</span><span class="rule-edit">${open ? 'Done' : 'Edit ranking rule'}</span></button>` : '';
  let panel = '';
  if (b.rule && open) {
    const o = ruleOptions(iface, b);
    const cur = b.sort ? `${b.sort.col}:${b.sort.dir}` : '';
    panel = `<div class="rule-panel">
      <label class="row field"><span class="field-label">Sort by</span><select data-change="rule-sort" data-block="${i}">${o.sorts.map((s) => `<option value="${esc(s.col)}:${s.dir}" ${cur === `${s.col}:${s.dir}` ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select></label>
      ${o.filters.map((f) => `<label class="row field"><span class="field-label">Only ${esc(f.label.toLowerCase())}</span><select data-change="rule-filter" data-col="${esc(f.col)}" data-block="${i}"><option value="">All</option>${f.values.map((v) => `<option ${b.filter && b.filter.col === f.col && b.filter.value === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>`).join('')}
      <label class="row field"><span class="field-label">Show</span><select data-change="rule-limit" data-block="${i}">${[...new Set([3, 5, 10, Number(b.limit) || 5])].sort((x, y) => x - y).map((n) => `<option value="${n}" ${Number(b.limit) === n ? 'selected' : ''}>Top ${n}</option>`).join('')}</select></label>
    </div>`;
  }
  return `<section class="block">${b.title ? `<h3 class="block-title">${esc(b.title)}</h3>` : ''}
    <div class="card">${rule}${panel}${items || `<p class="empty">${b.rule || (b.filter && b.filter.value != null) ? 'Nothing matches this rule.' : 'Nothing here yet.'}</p>`}</div></section>`;
}

export function renderBlocks(iface, opts = {}) {
  const h = helpers(iface);
  return iface.spec.blocks.map((b, i) => {
    try {
      if (b.type === 'form') return formBlock(b, i, h);
      if (b.type === 'stats') return statsBlock(b, h);
      if (b.type === 'chart') return chartBlock(b, h);
      if (b.type === 'list') return listBlock(b, i, h, iface, opts.ruleOpen === i);
      if (b.type === 'note') return `<section class="block"><p class="note-block">${esc(b.text)}</p></section>`;
      return '';
    } catch (e) {
      console.error(e);
      return `<section class="block"><div class="card pad"><p class="empty">This block can't reach its table. Check the bindings in the menu.</p></div></section>`;
    }
  }).join('');
}

// Insert a row from a form block. Returns the table written to.
export function submitForm(iface, blockIndex, formData) {
  const b = iface.spec.blocks[blockIndex];
  const h = helpers(iface);
  if (!b || b.type !== 'form') throw new Error('Not a form');
  if (iface.bindings[b.slot].access !== 'write') throw new Error('This interface only has read access to that table.');
  const cols = [];
  const vals = [];
  for (const f of b.fields) {
    const meta = h.meta(b.slot, f.col);
    let v = String(formData.get(f.col) ?? '').trim();
    if (v === '') throw new Error(`${f.label || colLabel(meta)} is required.`);
    if (meta.kind === 'number') {
      v = Number(v);
      if (!Number.isFinite(v)) throw new Error(`${f.label || colLabel(meta)} must be a number.`);
    }
    cols.push(h.C(b.slot, f.col));
    vals.push(v);
  }
  run(`INSERT INTO ${h.T(b.slot)} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, vals);
  return h.table(b.slot);
}
