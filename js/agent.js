// The agent: turns a conversation into a spec. With an API key it calls Claude;
// without one it falls back to scripted sessions so the demo works offline.
// It is only ever given the table schema and the user's messages. Never rows.
import { validateSpec } from './spec.js';

const KEY_STORE = 'onebase.apiKey';
export const getKey = () => { try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; } };
export const setKey = (k) => { try { k ? localStorage.setItem(KEY_STORE, k) : localStorage.removeItem(KEY_STORE); } catch { /* private mode */ } };

const MODEL = 'claude-opus-5-5';

const SYSTEM = `You design small data interfaces for OneBase, a phone app where all of a user's data lives in one SQLite database on their device. An interface is a declarative JSON spec that the app renders. You never write code or SQL, and you never see the user's rows: you are given table and column names only.

Reply with one or two short plain-text sentences for the user (no markdown). If the request needs a new or changed interface, follow that with exactly one \`\`\`json fenced block holding the COMPLETE spec. If the user only asks a question, answer it and send no JSON.

Spec shape:
{
  "name": string, "icon": one emoji, "color": "#rrggbb", "description": one short sentence,
  "needs": [ { "slot": identifier, "label": string, "access": "read" | "write",
               "columns": [ { "key": identifier, "kind": "date" | "number" | "text", "label": string, "format"?: "currency" } ] } ],
  "blocks": [ block, ... ]
}
A need is a table slot the user binds to one of their tables at install time. Ask for "write" only if the interface has a form. When the user's schema already has a suitable table, use that table's name as the slot and its column names as keys. Never use "id" as a key.

Blocks (every "slot" and column key must be declared in needs):
- {"type":"form","slot","title","submit","fields":[{"col","label","placeholder"?,"min"?,"max"?,"step"?,"options"?:[string],"suggest"?:true}]}  inserts a row; slot must be "write"
- {"type":"stats","slot","title"?,"items":[{"label","agg":"avg"|"max"|"min"|"sum"|"count","col"}]}  col must be a number column; omit col for count; at most 3 items
- {"type":"chart","slot","title","kind":"line"|"bar","x":column,"y":number column,"groupBy"?:"value"|"month","agg"?:"avg"|"max"|"min"|"sum"|"count"}  without groupBy, x must be a date column and each row is a point; groupBy "value" groups by a text x; groupBy "month" groups a date x by month; grouped charts need agg
- {"type":"list","slot","title","cols":{"title"?:column,"subtitle"?:column,"value"?:column},"sort":{"col","dir":"asc"|"desc"},"filter":null|{"col","value"},"limit":1-200,"rule"?:true}  rule:true lets the user edit the sort and filter themselves
- {"type":"note","text"}

Keep interfaces small: two to four blocks. When changing an existing interface, keep everything the user did not ask to change, and keep existing slots and column keys so the user's data bindings still apply.`;

function extractSpec(text) {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (!m) return { reply: text.trim(), spec: null };
  let spec = null;
  let error = null;
  try { spec = JSON.parse(m[1]); } catch (e) { error = `The JSON did not parse: ${e.message}`; }
  return { reply: text.replace(m[0], '').trim(), spec, error };
}

async function post(key, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2026-10-21',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'low' },
      fallbacks: 'default',
      system: SYSTEM,
      messages,
    }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch { /* not JSON */ }
    if (res.status === 401) throw new Error('That API key was rejected. Check it in the key settings.');
    if (res.status === 429) throw new Error('Rate limited. Wait a moment and try again.');
    throw new Error(`The model returned an error (${res.status}). ${detail}`.trim());
  }
  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('The model declined that request.');
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

// chat: [{role:'user'|'agent', text}]. Returns {reply, spec|null}.
export async function askModel({ chat, schema, currentSpec }) {
  const key = getKey();
  const context = `The user's database schema (names and kinds only; you cannot see rows):\n${JSON.stringify(schema)}\n\n` +
    (currentSpec ? `The interface being edited, current spec:\n${JSON.stringify(currentSpec)}` : 'No interface exists yet; the user wants a new one.');
  const messages = [];
  for (const m of chat) {
    const role = m.role === 'user' ? 'user' : 'assistant';
    if (messages.length && messages[messages.length - 1].role === role) messages[messages.length - 1].content += `\n\n${m.text}`;
    else messages.push({ role, content: m.text });
  }
  while (messages.length && messages[0].role !== 'user') messages.shift();
  messages[messages.length - 1].content = `${context}\n\nUser message:\n${messages[messages.length - 1].content}`;

  let out = extractSpec(await post(key, messages));
  let problems = out.error ? [out.error] : out.spec ? validateSpec(out.spec) : [];
  if (problems.length) {
    // One repair attempt: show the model exactly what the validator rejected.
    const retry = [...messages,
      { role: 'assistant', content: '(previous attempt contained an invalid spec)' },
      { role: 'user', content: `That spec was rejected by the validator:\n- ${problems.join('\n- ')}\nSend a corrected reply with the complete spec.` }];
    out = extractSpec(await post(key, retry));
    problems = out.error ? [out.error] : out.spec ? validateSpec(out.spec) : [];
    if (problems.length) return { reply: `I couldn't produce a valid interface for that (${problems[0]}). Try rephrasing.`, spec: null };
  }
  return { reply: out.reply || (out.spec ? `Here is ${out.spec.name}.` : ''), spec: out.spec };
}

// ---------- scripted sessions (no key, or offline) ----------

const clone = (o) => JSON.parse(JSON.stringify(o));

export const SCRIPTED_NEW = [
  {
    prompt: 'Which bowling alley do I score best at?',
    match: /alley|location|where|bowl|leaderboard/i,
    reply: 'Built Alley Leaderboard. It compares your average score at each location, shows your best game, and lists your top games. It only needs read access to a table with a date, a score and a location.',
    spec: {
      name: 'Alley Leaderboard', icon: '🏆', color: '#b7791f', description: 'Compares your scores by location.',
      needs: [{ slot: 'games', label: 'Games to compare', access: 'read', columns: [
        { key: 'date', kind: 'date', label: 'Date' }, { key: 'score', kind: 'number', label: 'Score' }, { key: 'location', kind: 'text', label: 'Location' }] }],
      blocks: [
        { type: 'chart', slot: 'games', title: 'Average score by location', kind: 'bar', x: 'location', y: 'score', groupBy: 'value', agg: 'avg' },
        { type: 'stats', slot: 'games', items: [{ label: 'Best game', agg: 'max', col: 'score' }, { label: 'Games', agg: 'count' }] },
        { type: 'list', slot: 'games', title: 'Top games', rule: true, cols: { title: 'location', subtitle: 'date', value: 'score' }, sort: { col: 'score', dir: 'desc' }, filter: null, limit: 5 },
      ],
    },
  },
  {
    prompt: 'Where is my money going each month?',
    match: /money|spend|expense|budget|month/i,
    reply: 'Built Spending Summary. It totals your expenses, breaks them down by category and by month, and lists the largest ones. Read access only.',
    spec: {
      name: 'Spending Summary', icon: '💸', color: '#0b7285', description: 'Totals by category and by month.',
      needs: [{ slot: 'expenses', label: 'Expenses to summarise', access: 'read', columns: [
        { key: 'date', kind: 'date', label: 'Date' }, { key: 'amount', kind: 'number', label: 'Amount', format: 'currency' }, { key: 'category', kind: 'text', label: 'Category' }] }],
      blocks: [
        { type: 'stats', slot: 'expenses', items: [{ label: 'Total', agg: 'sum', col: 'amount' }, { label: 'Largest', agg: 'max', col: 'amount' }] },
        { type: 'chart', slot: 'expenses', title: 'By category', kind: 'bar', x: 'category', y: 'amount', groupBy: 'value', agg: 'sum' },
        { type: 'chart', slot: 'expenses', title: 'By month', kind: 'bar', x: 'date', y: 'amount', groupBy: 'month', agg: 'sum' },
        { type: 'list', slot: 'expenses', title: 'Largest expenses', rule: true, cols: { title: 'category', subtitle: 'date', value: 'amount' }, sort: { col: 'amount', dir: 'desc' }, filter: null, limit: 5 },
      ],
    },
  },
  {
    prompt: 'Track my car mileage for work trips',
    match: /mile|car|trip|drive/i,
    reply: "Built Mileage Tracker. It logs trips with a date, miles and purpose, and totals the distance. You don't have a trips table yet, so the next step will offer to create one.",
    spec: {
      name: 'Mileage Tracker', icon: '🚗', color: '#6741d9', description: 'Log trips and total the distance.',
      needs: [{ slot: 'trips', label: 'Trips', access: 'write', columns: [
        { key: 'date', kind: 'date', label: 'Date' }, { key: 'miles', kind: 'number', label: 'Miles' }, { key: 'purpose', kind: 'text', label: 'Purpose' }] }],
      blocks: [
        { type: 'form', slot: 'trips', title: 'Add a trip', submit: 'Save trip', fields: [
          { col: 'date', label: 'Date' }, { col: 'miles', label: 'Miles', min: 0, placeholder: '0' }, { col: 'purpose', label: 'Purpose', placeholder: 'Client visit', suggest: true }] },
        { type: 'stats', slot: 'trips', items: [{ label: 'Total miles', agg: 'sum', col: 'miles' }, { label: 'Trips', agg: 'count' }] },
        { type: 'list', slot: 'trips', title: 'Recent trips', cols: { title: 'purpose', subtitle: 'date', value: 'miles' }, sort: { col: 'date', dir: 'desc' }, limit: 5 },
      ],
    },
  },
];

export function scriptedNew(text) {
  const hit = SCRIPTED_NEW.find((s) => s.prompt === text) || SCRIPTED_NEW.find((s) => s.match.test(text));
  if (!hit) {
    return { reply: 'No API key is set, so I can only run the three example sessions below. Add a key (the key icon on Home) to describe anything you like.', spec: null };
  }
  return { reply: hit.reply, spec: clone(hit.spec) };
}

function explain(spec) {
  const parts = spec.blocks.map((b) => {
    if (b.type === 'form') return `a form that adds a row to "${b.slot}"`;
    if (b.type === 'stats') return `${b.items.length} summary number${b.items.length > 1 ? 's' : ''} (${b.items.map((i) => i.label).join(', ')})`;
    if (b.type === 'chart') return `a ${b.kind} chart${b.title ? ` ("${b.title}")` : ''}`;
    if (b.type === 'list') return `a list${b.title ? ` ("${b.title}")` : ''}${b.rule ? ' with a ranking rule you can edit' : ''}`;
    return 'a note';
  });
  const needs = spec.needs.map((n) => `${n.access === 'write' ? 'read and write' : 'read-only'} access to "${n.slot}" (${n.columns.map((c) => c.key).join(', ')})`);
  return `${spec.name} is ${parts.join(', ')}. It asks for ${needs.join(' and ')}. It is a spec the app renders, not code, and deleting it leaves your data untouched.`;
}

const firstOf = (spec, type) => spec.blocks.find((b) => b.type === type);
const numCol = (spec, slot) => spec.needs.find((n) => n.slot === slot)?.columns.find((c) => c.kind === 'number');
const dateCol = (spec, slot) => spec.needs.find((n) => n.slot === slot)?.columns.find((c) => c.kind === 'date');
const textCol = (spec, slot) => spec.needs.find((n) => n.slot === slot)?.columns.find((c) => c.kind === 'text');

// Each scripted edit: when it applies, the chip text, how free text matches it, and what it does.
const EDITS = [
  {
    chip: () => 'What does this interface do?',
    applies: () => true,
    match: /what|explain|how does|describe/i,
    run: (spec) => ({ reply: explain(spec) }),
  },
  {
    chip: (spec) => `Make the chart a ${firstOf(spec, 'chart').kind === 'line' ? 'bar' : 'line'} chart`,
    applies: (spec) => { const c = firstOf(spec, 'chart'); return c && (!c.groupBy || c.groupBy === 'month'); },
    match: /\b(bar|line)\b/i,
    run: (spec) => {
      const c = firstOf(spec, 'chart');
      c.kind = c.kind === 'line' ? 'bar' : 'line';
      return { reply: `Done. "${c.title || 'The chart'}" is now a ${c.kind} chart. Flip back to see it.`, spec, note: `Chart changed to ${c.kind}` };
    },
  },
  {
    chip: (spec) => { const c = numCol(spec, firstOf(spec, 'stats').slot); return `Add my lowest ${(c.label || c.key).toLowerCase()} to the summary`; },
    applies: (spec) => { const s = firstOf(spec, 'stats'); return s && s.items.length < 4 && numCol(spec, s.slot) && !s.items.some((i) => i.agg === 'min'); },
    match: /lowest|worst|minimum|\bmin\b/i,
    run: (spec) => {
      const s = firstOf(spec, 'stats');
      const c = numCol(spec, s.slot);
      s.items.push({ label: `Lowest ${(c.label || c.key).toLowerCase()}`, agg: 'min', col: c.key });
      return { reply: `Added "Lowest ${(c.label || c.key).toLowerCase()}" to the summary row. Flip back to see it.`, spec, note: 'Added lowest to summary' };
    },
  },
  {
    chip: () => 'Add a count of entries',
    applies: (spec) => { const s = firstOf(spec, 'stats'); return s && s.items.length < 4 && !s.items.some((i) => i.agg === 'count'); },
    match: /count|how many|number of/i,
    run: (spec) => {
      firstOf(spec, 'stats').items.push({ label: 'Entries', agg: 'count' });
      return { reply: 'Added an entry count to the summary row.', spec, note: 'Added entry count' };
    },
  },
  {
    chip: () => 'Show the 3 most recent instead',
    applies: (spec) => { const l = firstOf(spec, 'list'); return l && dateCol(spec, l.slot) && !(l.sort?.col === dateCol(spec, l.slot).key && l.limit === 3); },
    match: /recent|latest|newest/i,
    run: (spec) => {
      const l = firstOf(spec, 'list');
      l.sort = { col: dateCol(spec, l.slot).key, dir: 'desc' };
      l.limit = 3;
      l.title = 'Most recent';
      return { reply: 'The list now shows your 3 most recent entries, newest first.', spec, note: 'List: 3 most recent' };
    },
  },
  {
    chip: (spec) => `Add a chart by ${(textCol(spec, spec.needs[0].slot).label || textCol(spec, spec.needs[0].slot).key).toLowerCase()}`,
    applies: (spec) => { const n = spec.needs[0]; return textCol(spec, n.slot) && numCol(spec, n.slot) && !spec.blocks.some((b) => b.type === 'chart' && b.groupBy === 'value'); },
    match: /\bby (location|category|purpose|place)|breakdown|compare/i,
    run: (spec) => {
      const n = spec.needs[0];
      const t = textCol(spec, n.slot);
      const y = numCol(spec, n.slot);
      const agg = y.format === 'currency' ? 'sum' : 'avg';
      const title = `${agg === 'sum' ? 'Total' : 'Average'} ${(y.label || y.key).toLowerCase()} by ${(t.label || t.key).toLowerCase()}`;
      spec.blocks.push({ type: 'chart', slot: n.slot, title, kind: 'bar', x: t.key, y: y.key, groupBy: 'value', agg });
      return { reply: `Added a bar chart: "${title}". It uses the same table, so no new access is needed.`, spec, note: `Added chart by ${t.key}` };
    },
  },
];

export function scriptedSuggestions(spec) {
  return EDITS.filter((e) => { try { return e.applies(spec); } catch { return false; } }).map((e) => e.chip(spec)).slice(0, 4);
}

// Returns {reply, spec?, note?}. spec is a changed copy; the caller validates and versions it.
export function scriptedEdit(text, spec) {
  const usable = EDITS.filter((e) => { try { return e.applies(spec); } catch { return false; } });
  const hit = usable.find((e) => e.chip(spec) === text) || usable.slice(1).find((e) => e.match.test(text)) || (EDITS[0].match.test(text) ? EDITS[0] : null);
  if (!hit) {
    return { reply: 'No API key is set, so I can only handle the example requests below. Add a key (the key icon on Home) for free-form changes.' };
  }
  return hit.run(clone(spec));
}
