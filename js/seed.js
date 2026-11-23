// First-run data and the marketplace catalog. Every interface here is a plain spec.
import { batch, query } from './db.js';

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export const today = () => daysAgo(0);

const GAMES = [
  [80, 142, 'Sunset Lanes'], [73, 156, 'Sunset Lanes'], [66, 131, 'Pin Palace'], [59, 168, 'Sunset Lanes'],
  [52, 174, 'Downtown Bowl'], [45, 149, 'Pin Palace'], [38, 187, 'Sunset Lanes'], [31, 162, 'Downtown Bowl'],
  [24, 195, 'Pin Palace'], [17, 171, 'Sunset Lanes'], [10, 203, 'Downtown Bowl'], [3, 184, 'Sunset Lanes'],
];
const EXPENSES = [
  [21, 54.2, 'Groceries'], [19, 12.5, 'Coffee'], [17, 38.0, 'Transport'], [14, 86.4, 'Groceries'], [12, 24.0, 'Bowling'],
  [10, 9.75, 'Coffee'], [8, 61.3, 'Dining'], [6, 45.0, 'Transport'], [3, 72.15, 'Groceries'], [1, 18.0, 'Bowling'],
];

const bowlingScorer = {
  name: 'Bowling Scorer',
  icon: '🎳',
  color: '#e8590c',
  description: 'Log each game with its date, score and location.',
  needs: [{
    slot: 'games', label: 'Bowling games', access: 'write',
    columns: [
      { key: 'date', kind: 'date', label: 'Date' },
      { key: 'score', kind: 'number', label: 'Score' },
      { key: 'location', kind: 'text', label: 'Location' },
    ],
  }],
  blocks: [
    {
      type: 'form', slot: 'games', title: 'Add a game', submit: 'Save game',
      fields: [
        { col: 'date', label: 'Date' },
        { col: 'score', label: 'Score', min: 0, max: 300, placeholder: '0 to 300' },
        { col: 'location', label: 'Location', placeholder: 'Where did you bowl?', suggest: true },
      ],
    },
    { type: 'list', slot: 'games', title: 'Recent games', cols: { title: 'location', subtitle: 'date', value: 'score' }, sort: { col: 'date', dir: 'desc' }, limit: 5 },
  ],
};

const sportsStats = {
  name: 'Sports Stats',
  icon: '📈',
  color: '#2f6fed',
  description: 'Average, best game and trend. Reads your games; never writes.',
  needs: [{
    slot: 'games', label: 'Games to analyse', access: 'read',
    columns: [
      { key: 'date', kind: 'date', label: 'Date' },
      { key: 'score', kind: 'number', label: 'Score' },
      { key: 'location', kind: 'text', label: 'Location' },
    ],
  }],
  blocks: [
    { type: 'stats', slot: 'games', items: [
      { label: 'Average', agg: 'avg', col: 'score' },
      { label: 'Best game', agg: 'max', col: 'score' },
      { label: 'Games', agg: 'count' },
    ] },
    { type: 'chart', slot: 'games', title: 'Score trend', kind: 'line', x: 'date', y: 'score' },
    { type: 'list', slot: 'games', title: 'Best games', rule: true, cols: { title: 'location', subtitle: 'date', value: 'score' }, sort: { col: 'score', dir: 'desc' }, filter: null, limit: 5 },
  ],
};

const expenseLog = {
  name: 'Expense Log',
  icon: '🧾',
  color: '#2b8a3e',
  description: 'Record what you spend, by category.',
  needs: [{
    slot: 'expenses', label: 'Expenses', access: 'write',
    columns: [
      { key: 'date', kind: 'date', label: 'Date' },
      { key: 'amount', kind: 'number', label: 'Amount', format: 'currency' },
      { key: 'category', kind: 'text', label: 'Category' },
    ],
  }],
  blocks: [
    {
      type: 'form', slot: 'expenses', title: 'Add an expense', submit: 'Save expense',
      fields: [
        { col: 'date', label: 'Date' },
        { col: 'amount', label: 'Amount', min: 0, step: 0.01, placeholder: '0.00' },
        { col: 'category', label: 'Category', options: ['Groceries', 'Dining', 'Coffee', 'Transport', 'Bowling', 'Other'] },
      ],
    },
    { type: 'stats', slot: 'expenses', items: [
      { label: 'Total spent', agg: 'sum', col: 'amount' },
      { label: 'Entries', agg: 'count' },
    ] },
    { type: 'list', slot: 'expenses', title: 'Recent expenses', cols: { title: 'category', subtitle: 'date', value: 'amount' }, sort: { col: 'date', dir: 'desc' }, limit: 6 },
  ],
};

// Marketplace listing. `spec` present means it really installs; otherwise it is a placeholder.
export const CATALOG = [
  {
    key: 'bowling', spec: bowlingScorer,
    chat: [
      { role: 'user', text: 'I want to log my bowling games: date, score and where I played.' },
      { role: 'agent', text: 'Built Bowling Scorer. It has a form that adds a row to your games table and a list of your five most recent games. It needs write access to one table with a date, a number and a text column.' },
    ],
  },
  {
    key: 'stats', spec: sportsStats,
    chat: [
      { role: 'user', text: 'Show me how my bowling is going: average, best game, and a trend over time.' },
      { role: 'agent', text: 'Built Sports Stats. It reads your games table and shows your average, best game and game count, a score trend chart, and a "Best games" list. The ranking rule for that list is yours to edit. It only asks for read access, so it can never change your data.' },
    ],
  },
  {
    key: 'expenses', spec: expenseLog,
    chat: [
      { role: 'user', text: 'A simple expense log. Date, amount, category.' },
      { role: 'agent', text: 'Built Expense Log. It adds rows to your expenses table and shows the total and your recent entries. It lives in the same database as your bowling games but only touches the expenses table.' },
    ],
  },
  { key: 'mileage', placeholder: { name: 'Mileage Tracker', icon: '🚗', color: '#6741d9', description: 'Trips, distance and purpose for tax time.' } },
  { key: 'habits', placeholder: { name: 'Habit Streaks', icon: '🔥', color: '#c2255c', description: 'Daily check-ins with streak counts.' } },
  { key: 'reading', placeholder: { name: 'Reading List', icon: '📚', color: '#0b7285', description: 'Books finished, with ratings and notes.' } },
];

// App bookkeeping tables. Created with seed data on first run, or on their own
// for a database that doesn't have them yet (for example a restored file).
const META = [
  'CREATE TABLE IF NOT EXISTS _ob_interfaces (id TEXT PRIMARY KEY, spec TEXT, bindings TEXT, chat TEXT, position INTEGER, source TEXT)',
  'CREATE TABLE IF NOT EXISTS _ob_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, iface TEXT, spec TEXT, note TEXT, at TEXT)',
];
export const META_SQL = META;

export function ensureMeta() {
  batch((exec) => META.forEach((sql) => exec(sql)));
}

export function seed(installInterface) {
  batch((exec) => {
    exec('CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, date DATE, score INTEGER, location TEXT)');
    exec('CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, date DATE, amount REAL, category TEXT)');
    for (const [d, s, l] of GAMES) exec('INSERT INTO games (date, score, location) VALUES (?, ?, ?)', [daysAgo(d), s, l]);
    for (const [d, a, c] of EXPENSES) exec('INSERT INTO expenses (date, amount, category) VALUES (?, ?, ?)', [daysAgo(d), a, c]);
    META.forEach((sql) => exec(sql));
  });
  for (const item of CATALOG.filter((c) => c.spec)) {
    const slot = item.spec.needs[0];
    const cols = {};
    for (const c of slot.columns) cols[c.key] = c.key;
    installInterface(item.spec, { [slot.slot]: { table: slot.slot, columns: cols, access: slot.access } }, item.chat, item.key);
  }
}

export function isSeeded() {
  return query("SELECT name FROM sqlite_master WHERE name = '_ob_interfaces'").length > 0;
}
