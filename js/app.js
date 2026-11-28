import {
  openFromStore, loadSql, claimWriter, setWritable, isWritable, onSaveState, getSaveState, retrySave, whenSaved,
  query, batch, run, userTables, columns, rowCount, schemaSummary, createTable, addColumns, exportBytes, validIdent, qi,
  NotOwnerError, ExistsError, inspectSqlite, replaceWith,
} from './db.js';
import { createWriterLock } from './lock.js';
import { seed, isSeeded, ensureMeta, META_SQL, CATALOG } from './seed.js';
import { validateSpec, candidates, matchTable, reconcile, accessLabel, homeScreenId, screenById, blockAt } from './spec.js';
import { renderScreen, submitForm, describeRule, esc, fmtDate } from './render.js';
import { getKey, setKey, askModel, scriptedNew, scriptedEdit, scriptedSuggestions, SCRIPTED_NEW } from './agent.js';

const $app = document.getElementById('app');
const clone = (o) => JSON.parse(JSON.stringify(o));
const rowsText = (n) => `${n} row${n === 1 ? '' : 's'}`;
// block: a full-screen state that replaces the app (loading, read error, other tab).
const state = { tab: 'home', view: null, sheet: null, toast: null, block: { kind: 'loading' }, storage: { supported: false, persisted: null } };

// ---------- interface store (bookkeeping tables in the same database) ----------

function loadInterfaces() {
  return query('SELECT * FROM _ob_interfaces ORDER BY position').map((r) => ({
    id: r.id, spec: JSON.parse(r.spec), bindings: JSON.parse(r.bindings), chat: JSON.parse(r.chat), source: r.source,
  }));
}
const getIface = (id) => loadInterfaces().find((i) => i.id === id);

function installInterface(spec, bindings, chat, source) {
  const id = `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const pos = (query('SELECT MAX(position) AS p FROM _ob_interfaces')[0].p || 0) + 1;
  batch((exec) => {
    exec('INSERT INTO _ob_interfaces (id, spec, bindings, chat, position, source) VALUES (?, ?, ?, ?, ?, ?)',
      [id, JSON.stringify(spec), JSON.stringify(bindings), JSON.stringify(chat || []), pos, source || null]);
    exec('INSERT INTO _ob_versions (iface, spec, note, at) VALUES (?, ?, ?, ?)', [id, JSON.stringify(spec), 'Installed', new Date().toISOString()]);
  });
  return id;
}
function saveSpec(id, spec, note) {
  batch((exec) => {
    exec('UPDATE _ob_interfaces SET spec = ? WHERE id = ?', [JSON.stringify(spec), id]);
    exec('INSERT INTO _ob_versions (iface, spec, note, at) VALUES (?, ?, ?, ?)', [id, JSON.stringify(spec), note, new Date().toISOString()]);
  });
}
const saveBindings = (id, b) => run('UPDATE _ob_interfaces SET bindings = ? WHERE id = ?', [JSON.stringify(b), id]);
const saveChat = (id, chat) => run('UPDATE _ob_interfaces SET chat = ? WHERE id = ?', [JSON.stringify(chat), id]);
const versions = (id) => query('SELECT * FROM _ob_versions WHERE iface = ? ORDER BY id', [id]);

function undoLast(id) {
  const vs = versions(id);
  if (vs.length < 2) return null;
  const last = vs[vs.length - 1];
  const prev = vs[vs.length - 2];
  batch((exec) => {
    exec('DELETE FROM _ob_versions WHERE id = ?', [last.id]);
    exec('UPDATE _ob_interfaces SET spec = ? WHERE id = ?', [prev.spec, id]);
  });
  return { note: last.note, now: vs.length - 1 };
}
function uninstall(id) {
  batch((exec) => {
    exec('DELETE FROM _ob_interfaces WHERE id = ?', [id]);
    exec('DELETE FROM _ob_versions WHERE iface = ?', [id]);
  });
}

// ---------- icons ----------

const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
const ICON = {
  home: svg('<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>'),
  market: svg('<path d="M5 8h14l-1 12H6L5 8z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>'),
  data: svg('<ellipse cx="12" cy="6" rx="7" ry="2.8"/><path d="M5 6v6c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6"/><path d="M5 12v6c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-6"/>'),
  key: svg('<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l3 3M14 9l2 2"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  more: svg('<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  chev: svg('<path d="M9 5l7 7-7 7"/>', 'class="chev"'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 'class="sm"'),
};

// ---------- screens ----------

function topbar() {
  const online = navigator.onLine !== false;
  return `<header class="topbar">
    <span class="pill" title="Your database is stored in this browser on this device"><span class="dot-live ${online ? '' : 'off'}"></span>On this device${online ? '' : ' · offline'}</span>
    <button class="icon-btn" data-act="key" aria-label="API key">${ICON.key}</button>
  </header>${saveBanner()}`;
}

function saveBanner() {
  const s = getSaveState();
  if (s.status !== 'error') return '';
  const e = s.error || {};
  const why = e.name === 'QuotaExceededError' ? 'This device is out of storage space for OneBase.'
    : e.message ? e.message : 'The browser refused the write.';
  return `<div class="banner danger" role="alert"><span><b>Your last change wasn't saved.</b> ${esc(why)} It is still on screen; retry to save it.</span>
    <button class="btn small" data-act="retry-save">Retry</button></div>`;
}

// ---------- blocking screens ----------

function blockScreen() {
  const b = state.block;
  if (b.kind === 'loading') return '<div class="boot">OneBase</div>';
  if (b.kind === 'read-error') {
    return `<div class="blocker" role="alertdialog" aria-labelledby="blk-h">
      <div class="blocker-ico">${ICON.data}</div>
      <h2 id="blk-h">Couldn't open your data</h2>
      <p>${esc(b.message)}</p>
      <p class="dim">Nothing was changed or replaced. Your saved database is left exactly as it was.</p>
      <button class="btn primary wide" data-act="retry-open" ${b.busy ? 'disabled' : ''}>${b.busy ? 'Trying…' : 'Try again'}</button>
    </div>`;
  }
  if (b.kind === 'exists') {
    return `<div class="blocker" role="alertdialog" aria-labelledby="blk-h">
      <h2 id="blk-h">Saved data found</h2>
      <p>OneBase found saved data while it was starting fresh. Nothing was overwritten.</p>
      <button class="btn primary wide" data-act="reload">Reload</button>
    </div>`;
  }
  if (b.kind === 'other-tab') {
    return `<div class="blocker" role="alertdialog" aria-labelledby="blk-h">
      <div class="blocker-ico">${ICON.lock}</div>
      <h2 id="blk-h">OneBase is open in another tab</h2>
      <p>${b.lost ? 'Another tab or window took over. Your data is safe there, and this tab has stopped saving so it can\'t overwrite it.' : 'Only one tab can change your data at a time, so nothing gets overwritten.'}</p>
      <button class="btn primary wide" data-act="take-over">Use OneBase here instead</button>
      <p class="dim">The other tab will stop saving. This tab opens as soon as the other one closes, too.</p>
    </div>`;
  }
  return '';
}

function tabbar() {
  const tab = (id, label, icon) => `<button class="tab ${state.tab === id ? 'on' : ''}" data-act="tab" data-tab="${id}">${icon}<span>${label}</span></button>`;
  return `<nav class="tabbar">${tab('home', 'Home', ICON.home)}${tab('market', 'Marketplace', ICON.market)}${tab('data', 'My Data', ICON.data)}</nav>`;
}

const appIcon = (spec, cls = '') => `<span class="app-icon ${cls}" style="background:${esc(/^#[0-9a-fA-F]{6}$/.test(spec.color || '') ? spec.color : '#5b6b7f')}">${esc(spec.icon || '◻️')}</span>`;

function dbSummary() {
  const tables = userTables();
  const rows = tables.reduce((n, t) => n + rowCount(t), 0);
  return `${tables.length} table${tables.length === 1 ? '' : 's'} · ${rowsText(rows)}`;
}

function homeScreen() {
  const list = loadInterfaces();
  const tiles = list.map((i) => `<button class="tile" data-act="open" data-id="${i.id}">${appIcon(i.spec, 'lg')}<span class="tile-name">${esc(i.spec.name)}</span></button>`).join('');
  return `<main class="scroll">
    ${installPrompt()}
    <h1 class="large-title">OneBase</h1>
    <p class="lede">One database. Interfaces you can swap.</p>
    <div class="grid">${tiles}
      <button class="tile" data-act="new"><span class="app-icon lg add">${ICON.plus}</span><span class="tile-name">New interface</span></button>
    </div>
    ${list.length ? '<p class="hint center">Press and hold an interface for options</p>' : '<p class="hint center">No interfaces installed. Your data is still in My Data.</p>'}
    <button class="btn primary wide" data-act="new">New interface</button>
    <button class="card db-card" data-act="tab" data-tab="data">
      <span class="db-ico">${ICON.data}</span>
      <span class="db-text"><b>Your database</b><span>${esc(dbSummary())} · stays when interfaces go</span></span>${ICON.chev}
    </button>
  </main>`;
}

// iOS Safari keeps a Home Screen web app's storage separate from Safari's, and
// Safari may clear site data after 7 days without a visit. So on iOS, in Safari,
// ask people to install first and keep their data in the installed app.
const A2HS_KEY = 'onebase.a2hsDismissed';
function isIosSafari() {
  const ua = navigator.userAgent || '';
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios && /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua);
}
function showInstallPrompt() {
  if (!isIosSafari() || isStandalone()) return false;
  try { return localStorage.getItem(A2HS_KEY) !== '1'; } catch { return true; }
}
const SHARE_ICON = svg('<path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5v9h14v-9h-1"/>', 'class="inline"');
function installPrompt() {
  if (!showInstallPrompt()) return '';
  return `<div class="card a2hs" role="note" aria-labelledby="a2hs-h">
    <button class="close" data-act="a2hs-dismiss" aria-label="Dismiss">×</button>
    <b id="a2hs-h">Add OneBase to your Home Screen first</b>
    <p>Tap ${SHARE_ICON} <b>Share</b>, then <b>Add to Home Screen</b>, and open OneBase from there.</p>
    <p class="dim">On iPhone the Home Screen app keeps its own data, separate from Safari, and Safari can clear website data you haven't opened for a week. Anything you add here in Safari stays in Safari.</p>
  </div>`;
}

function needsLine(spec) {
  return spec.needs.map((n) => `${n.access === 'write' ? 'Reads & writes' : 'Reads'} ${n.columns.map((c) => c.kind).join(' + ')}`).join('; ');
}

function marketScreen() {
  const installed = new Set(loadInterfaces().map((i) => i.source).filter(Boolean));
  const rows = CATALOG.map((c) => {
    const s = c.spec || c.placeholder;
    const btn = !c.spec ? '<span class="get soon">Soon</span>'
      : installed.has(c.key) ? '<span class="get done">Installed</span>'
      : `<button class="get" data-act="get" data-key="${c.key}">Get</button>`;
    return `<div class="row market-row">${appIcon(s)}
      <span class="item-main"><span class="item-title">${esc(s.name)}</span><span class="item-sub">${esc(s.description)}</span>
      ${c.spec ? `<span class="item-needs">${esc(needsLine(c.spec))}</span>` : ''}</span>${btn}</div>`;
  }).join('');
  return `<main class="scroll">
    <h1 class="large-title">Marketplace</h1>
    <p class="lede">Interfaces are small. Installing one never moves your data.</p>
    <div class="card">${rows}</div>
  </main>`;
}

function dataScreen() {
  const ifaces = loadInterfaces();
  const tables = userTables().map((t) => {
    const cols = columns(t);
    const rows = query(`SELECT * FROM ${qi(t)} ORDER BY rowid DESC LIMIT 100`);
    const users = ifaces.filter((i) => Object.values(i.bindings).some((b) => b.table === t)).map((i) => i.spec.name);
    const head = `<tr><th>id</th>${cols.map((c) => `<th>${esc(c.name)}<small>${esc(c.kind)}</small></th>`).join('')}</tr>`;
    const body = rows.map((r) => `<tr><td class="dim">${esc(r.id)}</td>${cols.map((c) => `<td>${esc(r[c.name] ?? '')}</td>`).join('')}</tr>`).join('');
    return `<section class="block">
      <div class="table-head"><h3 class="table-name">${esc(t)}</h3><span class="count">${rowsText(rowCount(t))}</span></div>
      <p class="used-by">${users.length ? `Used by ${esc(users.join(', '))}` : 'Not used by any interface right now'}</p>
      <div class="card table-wrap"><table class="grid-table"><thead>${head}</thead><tbody>${body || `<tr><td colspan="${cols.length + 1}" class="dim">No rows yet</td></tr>`}</tbody></table></div>
    </section>`;
  }).join('');
  return `<main class="scroll">
    <h1 class="large-title">My Data</h1>
    <p class="lede">The raw tables in your SQLite database. They belong to you, not to any interface.</p>
    ${storageCard()}
    <button class="btn wide" data-act="export">Export database</button>
    <label class="btn wide file-btn">Restore from a .sqlite file…<input type="file" data-change="restore-file" hidden></label>
    <p class="hint center">Restore replaces everything on this device. A backup of your current data downloads first.</p>
    ${tables}
  </main>`;
}

function storageCard() {
  const st = state.storage;
  let status, detail, ask = false;
  if (!st.supported) { status = 'Not reported'; detail = 'This browser doesn\'t say whether it may clear site data. Export a backup now and then.'; }
  else if (st.persisted) { status = 'Persistent'; detail = 'The browser has agreed not to clear your database to free up space.'; }
  else { status = 'Best effort'; detail = 'The browser may clear your database if the device runs low on space. Installing the app helps.'; ask = true; }
  return `<div class="card storage-card">
    <div class="row"><span class="item-main"><span class="item-title">Storage</span><span class="item-sub">${esc(detail)}</span></span>
    <span class="badge ${st.persisted ? 'ok' : 'read'}">${esc(status)}</span></div>
    ${ask ? '<button class="btn small wide-in" data-act="persist-ask">Ask the browser to keep it</button>' : ''}
  </div>`;
}

function privacyNote() {
  return `<p class="privacy">${ICON.lock}<span>The agent sees your table and column names and what you type here. It never sees your rows. ${getKey() ? 'Live model.' : 'No API key set: scripted examples.'}</span></p>`;
}

function bubbles(chat) {
  return chat.map((m) => `<div class="msg ${m.role === 'user' ? 'me' : 'them'}"><div class="bubble">${esc(m.text)}${m.tag ? `<span class="tag">${esc(m.tag)}</span>` : ''}</div>
    ${m.draft ? draftCard(state.view.draft) : ''}</div>`).join('');
}

function draftCard(spec) {
  if (!spec) return '';
  return `<div class="card draft">
    <div class="row">${appIcon(spec)}<span class="item-main"><span class="item-title">${esc(spec.name)}</span><span class="item-sub">${esc(spec.description || '')}</span><span class="item-needs">${esc(needsLine(spec))}</span></span></div>
    <button class="btn primary wide" data-act="draft-bind">Choose data & install</button>
  </div>`;
}

function composer(chips, placeholder, busy) {
  return `<div class="composer-wrap">
    ${chips.length ? `<div class="chips">${chips.map((c) => `<button class="chip" data-act="chip" data-text="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : ''}
    <form class="composer" data-form="chat"><input name="msg" type="text" placeholder="${esc(placeholder)}" autocomplete="off" ${busy ? 'disabled' : ''}>
    <button class="send" type="submit" aria-label="Send" ${busy ? 'disabled' : ''}>↑</button></form>
  </div>`;
}

const typing = '<div class="msg them"><div class="bubble typing"><i></i><i></i><i></i></div></div>';

function newScreen() {
  const v = state.view;
  return `<div class="navbar"><button class="nav-back" data-act="back">${ICON.back}Home</button><span class="nav-title">New interface</span><span class="nav-spacer"></span></div>
  <main class="scroll chat">
    ${privacyNote()}
    <div class="msg them"><div class="bubble">Describe the interface you want. I'll write a spec for it, then you choose which of your tables it can use.</div></div>
    ${bubbles(v.chat)}${v.busy ? typing : ''}
  </main>
  ${composer(v.draft || getKey() ? [] : SCRIPTED_NEW.map((s) => s.prompt), 'Describe an interface…', v.busy)}`;
}

// The open interface's screen stack, reset to home when its top screen no longer exists
// (after an agent edit, undo or restore).
function screenStack(iface) {
  const v = state.view;
  if (!Array.isArray(v.stack) || !v.stack.length || !v.stack.every((id) => screenById(iface.spec, id))) v.stack = [homeScreenId(iface.spec)];
  return v.stack;
}

function ifaceScreen() {
  const v = state.view;
  const iface = getIface(v.id);
  if (!iface) { state.view = null; return homeScreen() + tabbar(); }
  const stack = screenStack(iface);
  const top = stack[stack.length - 1];
  const screen = screenById(iface.spec, top);
  const head = stack.length > 1
    ? `<div class="screen-head"><button class="nav-back" data-act="go" data-to="back" aria-label="Back">${ICON.back}</button><span class="screen-title">${esc(screen.title)}</span></div>`
    : `<div class="iface-head">${appIcon(iface.spec)}<h1 class="large-title">${esc(screen.title)}</h1></div>`;
  return `${saveBanner()}<main class="scroll iface-scroll">${head}${renderScreen(iface, top, { ruleOpen: v.ruleOpen })}</main>${edgeTab()}`;
}

// The only OneBase control inside an interface. Pulses once, the first time it is ever shown.
const EDGE_KEY = 'onebase.edgeTabSeen';
function edgeTab() {
  let pulse = false;
  try {
    if (localStorage.getItem(EDGE_KEY) !== '1') { pulse = true; localStorage.setItem(EDGE_KEY, '1'); }
  } catch { /* storage unavailable: no pulse */ }
  return `<button class="edge-tab ${pulse ? 'pulse' : ''}" data-act="drawer" aria-label="OneBase menu"><span class="edge-grip"></span></button>`;
}

function drawerSheet(s) {
  const i = getIface(s.id);
  const bound = Object.values(i.bindings).map((b) => `<b>${esc(b.table)}</b> (${esc(accessLabel(b.access).toLowerCase())})`).join(', ');
  return `<div class="drawer-head">${appIcon(i.spec, 'lg')}<h2>${esc(i.spec.name)}</h2><p>${esc(i.spec.description || '')}</p></div>
    <div class="drawer-rows">
      <button class="drawer-row" data-act="agent-open">Edit with agent${ICON.chev}</button>
      <button class="drawer-row" data-act="back">Home${ICON.chev}</button>
      <button class="drawer-row" data-act="menu-bind">Data & bindings${ICON.chev}</button>
      <button class="drawer-row" data-act="menu-history">Version history${ICON.chev}</button>
      <button class="drawer-row" data-act="key">Claude API key${ICON.chev}</button>
      <button class="drawer-row danger" data-act="menu-uninstall">Uninstall</button>
    </div>
    <p class="drawer-note">${bound ? `Bound to ${bound}. ` : ''}Deleting this interface keeps the data.</p>`;
}

function agentSheet(s) {
  const v = state.view;
  const iface = getIface(s.id);
  const vs = versions(iface.id);
  const last = vs[vs.length - 1];
  return `<div class="agent-top"><div class="grabber"></div><button class="icon-btn agent-close" data-act="close-sheet" aria-label="Close">${ICON.close}</button></div>
  <div class="version-bar"><span class="v-text"><b>Version ${vs.length}</b> · ${esc(last ? last.note : '')}</span>
    <button class="link" data-act="undo" ${vs.length < 2 ? 'disabled' : ''}>Undo</button><button class="link" data-act="history">History</button></div>
  <main class="scroll chat">${privacyNote()}${bubbles(iface.chat)}${v.busy ? typing : ''}</main>
  ${composer(getKey() ? [] : scriptedSuggestions(iface.spec), 'Ask about it or request a change…', v.busy)}`;
}

// ---------- sheets ----------

// A table that is only missing some needed columns can be extended instead of replaced.
// Returns the columns to add, or null when the table fits already or can't be fixed by adding.
function extendWith(need, table) {
  if (matchTable(need, table).ok) return null;
  const cols = columns(table);
  const missing = [];
  for (const c of need.columns) {
    const hit = cols.find((t) => t.name.toLowerCase() === c.key.toLowerCase());
    if (!hit) { if (c.key.toLowerCase() === 'id') return null; missing.push(c); } else if (hit.kind !== c.kind) return null;
  }
  return missing.length ? missing : null;
}

function bindSheet(s) {
  const tables = userTables();
  const needs = s.spec.needs.map((need) => {
    const c = candidates(need);
    const choice = s.choice[need.slot];
    const ext = {};
    for (const m of c.all) if (!m.ok) { const x = extendWith(need, m.table); if (x) ext[m.table] = x; }
    const opts = [...c.all].sort((a, b) => (b.table === c.suggested) - (a.table === c.suggested) || (b.ok || !!ext[b.table]) - (a.ok || !!ext[a.table])).map((m) => `<option value="${esc(m.table)}" ${choice.table === m.table ? 'selected' : ''} ${m.ok || ext[m.table] ? '' : 'disabled'}>${esc(m.table)}${m.table === c.suggested ? ' (suggested)' : ext[m.table] ? ` (adds ${ext[m.table].map((x) => esc(x.key)).join(', ')})` : m.ok ? '' : ' (columns don\'t fit)'}</option>`).join('');
    let detail;
    if (choice.table === '__new__') {
      detail = `<label class="row field"><span class="field-label">Name</span><input type="text" data-input="bind-name" data-slot="${esc(need.slot)}" value="${esc(choice.newName)}" autocapitalize="off" autocomplete="off"></label>
        <p class="map">A new empty table with ${need.columns.map((x) => esc(x.key)).join(', ')}.</p>`;
    } else {
      const add = extendWith(need, choice.table);
      const m = matchTable(need, choice.table);
      const rest = need.columns.filter((x) => !add || !add.includes(x));
      detail = `${add ? `<p class="map">Adds column ${add.map((x) => `${esc(x.key)} (${esc(x.kind)})`).join(', ')} to ${esc(choice.table)}. Existing rows keep their data; the new column starts empty.</p>` : ''}
        ${rest.length ? `<p class="map">${rest.map((x) => `${esc(x.key)} → ${esc(m.columns[x.key] || '?')}`).join(' · ')}</p>` : ''}`;
    }
    return `<div class="card need">
      <div class="need-head"><b>${esc(need.label || need.slot)}</b><span class="badge ${need.access}">${accessLabel(need.access)}</span></div>
      <p class="need-cols">Needs a table with ${need.columns.map((x) => `<span class="kind">${esc(x.kind)}</span>`).join(' ')}</p>
      <label class="row field"><span class="field-label">Table</span><select data-change="bind-table" data-slot="${esc(need.slot)}">${opts}<option value="__new__" ${choice.table === '__new__' ? 'selected' : ''}>Create new table…</option></select></label>
      ${detail}
      <p class="access-line">${need.access === 'write' ? 'It can read this table and add rows to it.' : 'It can read this table. It cannot change it.'}</p>
    </div>`;
  }).join('');
  const install = s.mode === 'install';
  return `<div class="sheet-head">${appIcon(s.spec)}<div><h2>${install ? 'Connect data' : s.mode === 'respec' ? 'This change needs data access' : 'Data bindings'}</h2>
      <p>${esc(s.spec.name)} ${install ? 'is asking for:' : 'uses:'}</p></div></div>
    ${needs}
    <p class="hint">It gets nothing else. ${tables.length > 1 ? 'Your other tables stay invisible to it.' : ''}</p>
    ${s.error ? `<p class="error">${esc(s.error)}</p>` : ''}
    <div class="sheet-actions"><button class="btn" data-act="bind-deny">${install ? 'Deny' : 'Cancel'}</button><button class="btn primary" data-act="bind-allow">${install ? 'Allow' : 'Save'}</button></div>`;
}

function openBind(spec, opts) {
  const choice = {};
  for (const need of spec.needs) {
    const cur = opts.bindings && opts.bindings[need.slot];
    const c = candidates(need);
    const taken = userTables();
    let newName = need.slot;
    for (let n = 2; taken.includes(newName); n++) newName = `${need.slot}_${n}`;
    const fits = (t) => taken.includes(t) && (matchTable(need, t).ok || !!extendWith(need, t));
    let pick = cur && fits(cur.table) ? cur.table : null;
    // A renamed slot has no binding of its own: try the tables of bindings the new spec no longer uses.
    if (!pick && !cur && opts.bindings) {
      pick = Object.keys(opts.bindings).filter((k) => !spec.needs.some((n) => n.slot === k)).map((k) => opts.bindings[k].table).find(fits) || null;
    }
    choice[need.slot] = { table: pick || c.suggested || '__new__', newName };
  }
  state.sheet = { kind: 'bind', spec, choice, fresh: true, ...opts };
  render();
}

function menuSheet(s) {
  const i = getIface(s.id);
  return `<div class="sheet-head">${appIcon(i.spec)}<div><h2>${esc(i.spec.name)}</h2><p>${esc(i.spec.description || '')}</p></div></div>
    <div class="card"><button class="row action" data-act="menu-bind">Change data bindings</button>
    <button class="row action" data-act="menu-history">Version history</button>
    <button class="row action danger" data-act="menu-uninstall">Uninstall</button></div>
    <button class="btn wide" data-act="close-sheet">Cancel</button>`;
}

function uninstallSheet(s) {
  const i = getIface(s.id);
  const tables = [...new Set(Object.values(i.bindings).map((b) => b.table))];
  const lines = tables.map((t) => `<div class="row"><span class="item-main"><span class="item-title">${esc(t)}</span></span><span class="item-value small">${rowsText(rowCount(t))} stay${rowCount(t) === 1 ? 's' : ''}</span></div>`).join('');
  return `<div class="sheet-head">${appIcon(i.spec)}<div><h2>Uninstall ${esc(i.spec.name)}?</h2><p>Only the interface is removed. Your data stays in your database, and other interfaces keep working.</p></div></div>
    <div class="card">${lines}</div>
    <div class="sheet-actions"><button class="btn" data-act="close-sheet">Cancel</button><button class="btn danger" data-act="confirm-uninstall">Uninstall</button></div>`;
}

function historySheet(s) {
  const vs = versions(s.id);
  const rows = vs.map((v, n) => ({ v, n: n + 1 })).reverse().map(({ v, n }) => `<div class="row"><span class="item-main"><span class="item-title">Version ${n}${n === vs.length ? ' · current' : ''}</span>
      <span class="item-sub">${esc(v.note)} · ${esc(new Date(v.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</span></span>
      ${n === vs.length ? '' : `<button class="get" data-act="restore" data-vid="${v.id}" data-n="${n}">Restore</button>`}</div>`).join('');
  return `<div class="sheet-head"><div><h2>Version history</h2><p>Every change to this interface is kept. Your data is never part of a version.</p></div></div>
    <div class="card">${rows}</div>
    <div class="sheet-actions"><button class="btn" data-act="close-sheet">Done</button><button class="btn primary" data-act="undo" ${vs.length < 2 ? 'disabled' : ''}>Undo last change</button></div>`;
}

function keySheet() {
  const k = getKey();
  return `<div class="sheet-head"><div><h2>Claude API key</h2><p>Optional. With a key, the agent sessions use a live model. Without one they run scripted examples.</p></div></div>
    <form class="card" data-form="key"><label class="row field"><span class="field-label">Key</span><input name="key" type="password" placeholder="sk-ant-…" value="${esc(k)}" autocomplete="off" autocapitalize="off" spellcheck="false"></label></form>
    <p class="hint">Stored only on this device, outside the database, so it is never in an export. Sent only to api.anthropic.com, along with your table names and messages. Never your rows.</p>
    <div class="sheet-actions"><button class="btn" data-act="${k ? 'key-clear' : 'close-sheet'}">${k ? 'Remove key' : 'Cancel'}</button><button class="btn primary" data-act="key-save">Save</button></div>`;
}

function restoreSheet(s) {
  const cur = currentSummary();
  const sum = s.summary;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return `<div class="sheet-head"><span class="app-icon" style="background:#d23f31">⚠️</span><div><h2>Replace all your data?</h2>
      <p>Everything on this device is replaced with <b>${esc(s.name)}</b>. This can't be merged or undone here.</p></div></div>
    <div class="card">
      <div class="row"><span class="item-main"><span class="item-title">From the file</span><span class="item-sub">${plural(sum.tables, 'table')} · ${rowsText(sum.rows)} · ${plural(sum.interfaces, 'interface')}</span></span></div>
      <div class="row"><span class="item-main"><span class="item-title">On this device now</span><span class="item-sub">${plural(cur.tables, 'table')} · ${rowsText(cur.rows)} · ${plural(cur.interfaces, 'interface')}</span></span></div>
    </div>
    <p class="hint">${sum.hasMeta ? '' : 'The file has no OneBase interfaces. Its tables will show in My Data and you can install interfaces over them. '}Your current database downloads as <b>${esc(s.backupName)}</b> before anything is replaced.</p>
    ${s.error ? `<p class="error">${esc(s.error)}</p>` : ''}
    <div class="sheet-actions"><button class="btn" data-act="close-sheet">Cancel</button><button class="btn danger" data-act="confirm-restore" ${s.busy ? 'disabled' : ''}>${s.busy ? 'Restoring…' : 'Back up and replace'}</button></div>`;
}

function currentSummary() {
  const tables = userTables();
  return { tables: tables.length, rows: tables.reduce((n, t) => n + rowCount(t), 0), interfaces: isSeeded() ? loadInterfaces().length : 0 };
}

function sheetHtml() {
  const s = state.sheet;
  if (!s) return '';
  if (s.kind === 'drawer') {
    const fresh = s.fresh ? 'enter' : '';
    s.fresh = false;
    return `<div class="scrim ${fresh}" data-act="scrim"></div><aside class="drawer ${fresh}" role="dialog" aria-label="OneBase menu">${drawerSheet(s)}</aside>`;
  }
  if (s.kind === 'agent') {
    const fresh = s.fresh ? 'enter' : '';
    s.fresh = false;
    return `<div class="scrim light ${fresh}" data-act="scrim"></div><div class="sheet tall ${fresh}" role="dialog" aria-label="Edit with agent">${agentSheet(s)}</div>`;
  }
  const body = s.kind === 'bind' ? bindSheet(s) : s.kind === 'menu' ? menuSheet(s) : s.kind === 'uninstall' ? uninstallSheet(s)
    : s.kind === 'history' ? historySheet(s) : s.kind === 'key' ? keySheet() : s.kind === 'restore' ? restoreSheet(s) : '';
  const fresh = s.fresh ? 'enter' : '';
  s.fresh = false;
  return `<div class="scrim ${fresh}" data-act="scrim"></div><div class="sheet ${fresh}" role="dialog"><div class="grabber"></div>${body}</div>`;
}

// ---------- render ----------

let lastKey = '';
function render() {
  if (state.block) {
    $app.innerHTML = blockScreen();
    lastKey = '';
    return;
  }
  const v = state.view;
  const key = v ? `${v.type}:${v.id || ''}:${v.stack ? v.stack[v.stack.length - 1] : ''}` : `tab:${state.tab}`;
  const old = $app.querySelector('.scroll:not(.chat)');
  const keep = old && key === lastKey ? old.scrollTop : 0;
  let body;
  if (v && v.type === 'iface') body = ifaceScreen();
  else if (v && v.type === 'new') body = newScreen();
  else body = (state.tab === 'home' ? homeScreen() : state.tab === 'market' ? marketScreen() : dataScreen()) + tabbar();
  const immersive = !!(state.view && state.view.type === 'iface');
  $app.innerHTML = (immersive ? '' : topbar()) + body + sheetHtml() + (state.toast ? `<div class="toast">${esc(state.toast)}</div>` : '');
  const sc = $app.querySelector('.scroll:not(.chat)');
  if (sc) sc.scrollTop = keep;
  const chat = $app.querySelector('.scroll.chat');
  if (chat) chat.scrollTop = chat.scrollHeight;
  lastKey = key;
  syncUi();
}

let toastTimer;
function toast(text) {
  state.toast = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { state.toast = null; const t = $app.querySelector('.toast'); if (t) t.remove(); }, 2600);
}

// ---------- agent flows ----------

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function ask(text, chat, currentSpec, scripted) {
  if (getKey()) {
    try {
      return await askModel({ chat, schema: schemaSummary(), currentSpec });
    } catch (e) {
      // Show what actually went wrong. Scripted replies are only for when no key is set.
      console.error('model call failed', e);
      return { reply: e instanceof TypeError ? `Something went wrong talking to Claude: ${e.message}` : e.message, spec: null };
    }
  }
  await wait(650);
  return scripted();
}

async function sendNew(text) {
  const v = state.view;
  v.chat.push({ role: 'user', text });
  v.busy = true;
  render();
  const out = await ask(text, v.chat.map(({ role, text: t }) => ({ role, text: t })), v.draft, () => scriptedNew(text));
  if (state.view !== v) return;
  v.busy = false;
  v.chat.forEach((m) => { m.draft = false; });
  const errs = out.spec ? validateSpec(out.spec) : [];
  if (out.spec && !errs.length) {
    v.draft = out.spec;
    v.chat.push({ role: 'agent', text: out.reply, draft: true });
  } else {
    v.chat.push({ role: 'agent', text: errs.length ? `I couldn't build that (${errs[0]})` : out.reply, draft: !!v.draft && !out.spec && false });
    if (v.draft) v.chat[v.chat.length - 1].draft = true;
  }
  render();
}

async function sendIface(text) {
  const v = state.view;
  let iface = getIface(v.id);
  const chat = [...iface.chat, { role: 'user', text }];
  saveChat(iface.id, chat);
  v.busy = true;
  render();
  const out = await ask(text, chat.map(({ role, text: t }) => ({ role, text: t })), iface.spec, () => scriptedEdit(text, iface.spec));
  iface = getIface(v.id);
  if (!iface) return;
  v.busy = false;
  const msg = { role: 'agent', text: out.reply };
  if (out.spec) {
    const errs = validateSpec(out.spec);
    if (errs.length) {
      msg.text = `I couldn't apply that (${errs[0]})`;
    } else if (JSON.stringify(out.spec) !== JSON.stringify(iface.spec)) {
      const note = out.note || (text.length > 44 ? `${text.slice(0, 43)}…` : text);
      const r = reconcile(out.spec, iface.bindings);
      if (r.missing.length) {
        msg.text = `${out.reply} This needs access it doesn't have yet, so I've asked you to approve it.`;
        saveChat(iface.id, [...chat, msg]);
        if (state.view === v) openBind(out.spec, { mode: 'respec', ifaceId: iface.id, bindings: iface.bindings, note });
        return;
      }
      saveSpec(iface.id, out.spec, note);
      saveBindings(iface.id, r.bindings);
      msg.tag = `Applied as version ${versions(iface.id).length}`;
    }
  }
  saveChat(iface.id, [...chat, msg]);
  if (state.view === v) render();
}

function doUndo(id) {
  const res = undoLast(id);
  if (!res) return;
  const iface = getIface(id);
  const r = reconcile(iface.spec, iface.bindings);
  if (!r.missing.length) saveBindings(id, r.bindings);
  saveChat(id, [...iface.chat, { role: 'agent', text: `Undid "${res.note}". Back on version ${res.now}.`, tag: 'Undone' }]);
  toast(`Undone. Back on version ${res.now}`);
  if (r.missing.length) openBind(iface.spec, { mode: 'edit', ifaceId: id, bindings: iface.bindings });
}

function changeRule(ref, mutate) {
  const iface = getIface(state.view.id);
  const spec = clone(iface.spec);
  const b = blockAt(spec, ref);
  if (!b || b.type !== 'list') return;
  mutate(b);
  saveSpec(iface.id, spec, `Rule: ${describeRule(b, { ...iface, spec })}`);
  render();
}

// ---------- actions ----------

const actions = {
  tab(el) { state.tab = el.dataset.tab; state.view = null; render(); },
  open(el) {
    const saved = ui.stacks[el.dataset.id];
    state.view = { type: 'iface', id: el.dataset.id, stack: Array.isArray(saved) ? [...saved] : undefined };
    render();
  },
  back() { state.view = null; state.sheet = null; state.tab = 'home'; render(); },
  drawer() {
    if (!state.view || state.view.type !== 'iface' || state.sheet) return;
    state.sheet = { kind: 'drawer', id: state.view.id, fresh: true };
    render();
  },
  'agent-open'() { state.sheet = { kind: 'agent', id: state.view.id, fresh: true }; render(); },
  new() { state.view = { type: 'new', chat: [], draft: null, busy: false }; render(); },
  chip(el) { if (state.view.busy) return; state.view.type === 'new' ? sendNew(el.dataset.text) : sendIface(el.dataset.text); },
  key() { state.sheet = { kind: 'key', fresh: true }; render(); },
  'key-save'() {
    const input = $app.querySelector('input[name="key"]');
    setKey(input.value.trim());
    state.sheet = null;
    toast(getKey() ? 'Key saved on this device' : 'No key set. Using scripted examples');
    render();
  },
  'key-clear'() { setKey(''); state.sheet = null; toast('Key removed'); render(); },
  scrim() { actions['close-sheet'](); },
  'close-sheet'() {
    const s = state.sheet;
    state.sheet = null;
    if (s && s.kind === 'bind' && s.mode === 'install') toast('Not installed. Nothing was shared.');
    render();
  },
  menu(el) { state.sheet = { kind: 'menu', id: el.dataset.id, fresh: true }; render(); },
  'menu-bind'() { const i = getIface(state.sheet.id); openBind(i.spec, { mode: 'edit', ifaceId: i.id, bindings: i.bindings }); },
  'menu-history'() { state.sheet = { kind: 'history', id: state.sheet.id }; render(); },
  'menu-uninstall'() { state.sheet = { kind: 'uninstall', id: state.sheet.id }; render(); },
  'confirm-uninstall'() {
    const i = getIface(state.sheet.id);
    const tables = [...new Set(Object.values(i.bindings).map((b) => b.table))];
    uninstall(i.id);
    state.sheet = null;
    state.view = null;
    state.tab = 'home';
    delete ui.stacks[i.id];
    toast(`${i.spec.name} removed. ${tables.map((t) => `${t}: ${rowsText(rowCount(t))} kept`).join(', ')}`);
    render();
  },
  history() { state.sheet = { kind: 'history', id: state.view.id, fresh: true }; render(); },
  undo() {
    const id = state.sheet && state.sheet.kind === 'history' ? state.sheet.id : state.view.id;
    doUndo(id);
    render();
  },
  restore(el) {
    const id = state.sheet.id;
    const v = versions(id).find((x) => String(x.id) === el.dataset.vid);
    if (!v) return;
    saveSpec(id, JSON.parse(v.spec), `Restored version ${el.dataset.n}`);
    const iface = getIface(id);
    const r = reconcile(iface.spec, iface.bindings);
    state.sheet = null;
    toast(`Restored version ${el.dataset.n}`);
    if (r.missing.length) openBind(iface.spec, { mode: 'edit', ifaceId: id, bindings: iface.bindings });
    else { saveBindings(id, r.bindings); render(); }
  },
  get(el) {
    const item = CATALOG.find((c) => c.key === el.dataset.key);
    openBind(clone(item.spec), { mode: 'install', chat: clone(item.chat), source: item.key });
  },
  'draft-bind'() {
    const v = state.view;
    openBind(clone(v.draft), { mode: 'install', chat: v.chat.map(({ role, text }) => ({ role, text })) });
  },
  'bind-deny'() { actions['close-sheet'](); },
  'bind-allow'() {
    const s = state.sheet;
    const bindings = {};
    const toCreate = [];
    const toExtend = [];
    const existing = userTables();
    for (const need of s.spec.needs) {
      const c = s.choice[need.slot];
      if (c.table === '__new__') {
        const name = (c.newName || '').trim();
        if (!validIdent(name) || name.startsWith('_ob_') || name.toLowerCase().startsWith('sqlite_')) { s.error = 'Table names use letters, digits and underscores, and start with a letter.'; render(); return; }
        if (existing.includes(name) || toCreate.some((t) => t.name === name)) { s.error = `You already have a table called "${name}".`; render(); return; }
        toCreate.push({ name, need });
        const cols = {};
        for (const col of need.columns) cols[col.key] = col.key;
        bindings[need.slot] = { table: name, columns: cols, access: need.access };
      } else {
        const add = extendWith(need, c.table);
        if (add) { toExtend.push({ need, table: c.table, cols: add }); continue; }
        const m = matchTable(need, c.table);
        if (!m.ok) { s.error = `"${c.table}" doesn't have the columns this needs.`; render(); return; }
        const prev = s.bindings && s.bindings[need.slot];
        bindings[need.slot] = { table: c.table, columns: prev && prev.table === c.table ? { ...m.columns, ...prev.columns } : m.columns, access: need.access };
      }
    }
    for (const t of toCreate) createTable(t.name, t.need.columns);
    // Validation passed: add the missing columns (the statements run now), then bind as usual.
    for (const a of toExtend) {
      // Re-check right before altering: an earlier need may already have added the same column.
      const still = extendWith(a.need, a.table);
      if (still) addColumns(a.table, still);
      const m = matchTable(a.need, a.table);
      const prev = s.bindings && s.bindings[a.need.slot];
      bindings[a.need.slot] = { table: a.table, columns: prev && prev.table === a.table ? { ...m.columns, ...prev.columns } : m.columns, access: a.need.access };
    }
    state.sheet = null;
    if (s.mode === 'install') {
      const id = installInterface(s.spec, bindings, s.chat, s.source);
      state.tab = 'home';
      state.view = { type: 'iface', id };
      toast(`${s.spec.name} installed`);
    } else {
      if (s.mode === 'respec') {
        saveSpec(s.ifaceId, s.spec, s.note || 'Changed');
        const i = getIface(s.ifaceId);
        saveChat(s.ifaceId, [...i.chat, { role: 'agent', text: 'Access approved and the change is applied.', tag: `Applied as version ${versions(s.ifaceId).length}` }]);
      }
      saveBindings(s.ifaceId, bindings);
      toast(s.mode === 'respec' ? 'Change applied' : 'Bindings updated');
    }
    render();
  },
  'edit-rule'(el) {
    const ref = el.dataset.block;
    state.view.ruleOpen = state.view.ruleOpen === ref ? null : ref;
    render();
  },
  go(el) {
    const v = state.view;
    if (!v || v.type !== 'iface') return;
    const stack = screenStack(getIface(v.id));
    if (el.dataset.to === 'back') { if (stack.length > 1) stack.pop(); } else stack.push(el.dataset.to);
    v.ruleOpen = null;
    render();
  },
  'retry-save'() { retrySave().then((ok) => { toast(ok ? 'Saved' : 'Still not saved'); render(); }); },
  'retry-open'() { state.block = { ...state.block, busy: true }; render(); becomeWriter(); },
  reload() { location.reload(); },
  'take-over'() { state.block = { kind: 'loading' }; render(); writerLock.takeOver(); },
  'persist-ask'() { requestPersistence(true); },
  'a2hs-dismiss'() { try { localStorage.setItem(A2HS_KEY, '1'); } catch { /* private mode */ } render(); },
  export() {
    download(exportBytes(), 'onebase.sqlite');
    toast('Exported onebase.sqlite');
  },
  async 'confirm-restore'() {
    const s = state.sheet;
    if (!s || s.kind !== 'restore' || s.busy) return;
    if (!isWritable()) { s.error = 'OneBase is open in another tab, so nothing can be restored here.'; render(); return; }
    s.busy = true;
    s.error = null;
    render();
    download(exportBytes(), s.backupName);
    let ok = false;
    try {
      ok = await replaceWith(s.bytes, (exec) => META_SQL.forEach((sql) => exec(sql)));
    } catch (e) {
      console.error(e);
    }
    if (!ok) {
      s.busy = false;
      s.error = 'Couldn\'t save the restored database. Your current data is unchanged.';
      render();
      return;
    }
    state.sheet = null;
    state.view = null;
    state.tab = 'data';
    toast(`Restored ${s.name}`);
    requestPersistence();
    render();
  },
};

function download(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/vnd.sqlite3' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

async function pickRestoreFile(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  if (!isWritable()) { toast('OneBase is open in another tab'); return; }
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); } catch (e) { toast('Couldn\'t read that file'); return; }
  const res = await inspectSqlite(bytes);
  if (!res.ok) { toast(res.error); render(); return; }
  state.sheet = { kind: 'restore', fresh: true, name: file.name, bytes, summary: res.summary, backupName: `onebase-backup-${stamp()}.sqlite` };
  render();
}

// ---------- events ----------

// After a long-press opens a menu, ignore the click from lifting the finger
// unless it lands on a button inside the sheet.
let suppressUntil = 0;
$app.addEventListener('click', (e) => {
  if (Date.now() < suppressUntil && !e.target.closest('.sheet')) { e.preventDefault(); return; }
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) fn(el, e);
});

$app.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  const kind = form.dataset.form;
  if (kind === 'key') { actions['key-save'](); return; }
  if (kind === 'chat') {
    const text = new FormData(form).get('msg').trim();
    if (!text || state.view.busy) return;
    state.view.type === 'new' ? sendNew(text) : sendIface(text);
    return;
  }
  try {
    const iface = getIface(state.view.id);
    const { table, then } = submitForm(iface, kind, new FormData(form));
    if (then) actions.go({ dataset: { to: then } });
    toast(`Saving to ${table}…`);
    whenSaved().then((ok) => {
      if (ok) { toast(`Saved to ${table}`); requestPersistence(); } else { state.toast = null; }
      render();
    });
  } catch (err) {
    toast(err.message);
  }
  render();
});

$app.addEventListener('change', (e) => {
  const el = e.target;
  const c = el.dataset.change;
  if (c === 'restore-file') { pickRestoreFile(el); return; }
  if (c === 'bind-table') { state.sheet.choice[el.dataset.slot].table = el.value; state.sheet.error = null; render(); }
  if (c === 'rule-sort') { const [col, dir] = el.value.split(':'); changeRule(el.dataset.block, (b) => { b.sort = { col, dir }; }); }
  if (c === 'rule-filter') changeRule(el.dataset.block, (b) => { b.filter = el.value === '' ? null : { col: el.dataset.col, value: el.value }; });
  if (c === 'rule-limit') changeRule(el.dataset.block, (b) => { b.limit = Number(el.value); });
});

$app.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.input === 'bind-name') state.sheet.choice[el.dataset.slot].newName = el.value;
});

// Long-press (or right-click) an interface tile for its menu.
let pressTimer = null;
const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
$app.addEventListener('pointerdown', (e) => {
  const tile = e.target.closest('.tile[data-id]');
  if (!tile) return;
  cancelPress();
  pressTimer = setTimeout(() => {
    suppressUntil = Date.now() + 450;
    actions.menu(tile);
  }, 480);
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave', 'pointermove']) {
  $app.addEventListener(ev, (e) => { if (ev !== 'pointermove' || Math.abs(e.movementX) + Math.abs(e.movementY) > 6) cancelPress(); }, true);
}
$app.addEventListener('contextmenu', (e) => {
  const tile = e.target.closest('.tile[data-id]');
  if (!tile) return;
  e.preventDefault();
  cancelPress();
  actions.menu(tile);
});

// ---------- resume (per-viewer UI state, never data) ----------

const UI_KEY = 'onebase.ui';
function loadUi() {
  try {
    const o = JSON.parse(localStorage.getItem(UI_KEY));
    if (o && typeof o === 'object') {
      const stacks = {};
      if (o.stacks && typeof o.stacks === 'object') {
        for (const [k, st] of Object.entries(o.stacks)) if (Array.isArray(st) && st.every((x) => typeof x === 'string')) stacks[k] = st;
      }
      return { open: typeof o.open === 'string' ? o.open : null, stacks };
    }
  } catch { /* no storage or bad JSON */ }
  return { open: null, stacks: {} };
}
const ui = loadUi();
let uiSaved = JSON.stringify(ui);
function syncUi() {
  const v = state.view;
  ui.open = v && v.type === 'iface' ? v.id : null;
  if (ui.open && Array.isArray(v.stack)) ui.stacks[v.id] = [...v.stack];
  const json = JSON.stringify(ui);
  if (json === uiSaved) return;
  uiSaved = json;
  try { localStorage.setItem(UI_KEY, json); } catch { /* storage unavailable */ }
}

// Left swipe that starts within 24px of the right edge opens the drawer; swipe right closes it.
let touch = null;
$app.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  touch = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, edge: t.clientX >= $app.getBoundingClientRect().right - 24 } : null;
}, { passive: true });
$app.addEventListener('touchend', (e) => {
  const st = touch;
  touch = null;
  if (!st || state.block) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - st.x;
  const dy = t.clientY - st.y;
  if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return;
  if (state.sheet && state.sheet.kind === 'drawer' && dx > 0) actions['close-sheet']();
  else if (!state.sheet && st.edge && dx < 0 && state.view && state.view.type === 'iface') actions.drawer();
}, { passive: true });

// ---------- storage persistence ----------

const isStandalone = () => navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);

async function refreshStorage() {
  const sto = navigator.storage;
  if (!sto || !sto.persisted) { state.storage = { supported: false, persisted: null }; return; }
  try { state.storage = { supported: true, persisted: await sto.persisted() }; } catch { state.storage = { supported: false, persisted: null }; }
}

// Ask once per session after the user has real data worth keeping (first save,
// or on launch of the installed app), or whenever they tap the button.
let askedPersist = false;
async function requestPersistence(fromButton = false) {
  const sto = navigator.storage;
  if (!sto || !sto.persist || state.storage.persisted) { if (fromButton) toast('Not available in this browser'); return; }
  if (askedPersist && !fromButton) return;
  askedPersist = true;
  try {
    const granted = await sto.persist();
    state.storage = { supported: true, persisted: granted };
    if (fromButton) toast(granted ? 'The browser will keep your data' : 'The browser said no for now. Installing the app usually helps');
  } catch (e) {
    console.warn('storage.persist failed', e);
  }
  if (!state.block) render();
}

// ---------- boot ----------

onSaveState((s) => {
  if (s.status === 'error' && s.error instanceof NotOwnerError) { setWritable(false); state.sheet = null; state.block = { kind: 'other-tab', lost: true }; }
  if (s.status === 'error' && s.error instanceof ExistsError) { setWritable(false); state.block = { kind: 'exists' }; }
  if (s.status === 'error' || s.status === 'saved') render();
});

// Runs whenever this tab becomes the writer (first load, take-over, or the
// other tab closing). The database is (re)read after the claim, so changes the
// previous writer saved are picked up.
async function becomeWriter() {
  setWritable(false);
  try {
    await claimWriter();
    const { fresh } = await openFromStore();
    setWritable(true);
    if (fresh) seed(installInterface);
    else if (!isSeeded()) ensureMeta();
    state.block = null;
    state.view = null;
    state.sheet = null;
    // Resume the interface that was open, on its saved screen (if it still exists).
    if (ui.open && getIface(ui.open)) state.view = { type: 'iface', id: ui.open, stack: ui.stacks[ui.open] ? [...ui.stacks[ui.open]] : undefined };
    await refreshStorage();
    render();
    if (isStandalone()) requestPersistence();
  } catch (e) {
    console.error(e);
    setWritable(false);
    state.block = { kind: 'read-error', message: e.message || String(e) };
    render();
  }
}

const writerLock = createWriterLock({
  granted: () => { becomeWriter(); },
  busy: () => { setWritable(false); state.block = { kind: 'other-tab', lost: false }; render(); },
  lost: () => { setWritable(false); state.sheet = null; state.block = { kind: 'other-tab', lost: true }; render(); },
});

addEventListener('online', () => { if (!state.block) render(); });
addEventListener('offline', () => { if (!state.block) render(); });

async function boot() {
  render();
  try {
    await loadSql();
  } catch (e) {
    console.error(e);
    $app.innerHTML = `<div class="boot-error"><h2>OneBase couldn't start</h2><p>${esc(e.message || e)}</p></div>`;
    return;
  }
  writerLock.start();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker not registered', e));
}
boot();
