// Dev-only. Gives the app's browser ES modules the globals they expect when they
// are imported directly in Node: window/self, IndexedDB (fake-indexeddb),
// localStorage (in memory) and window.initSqlJs (the vendored sql.js build).
import 'fake-indexeddb/auto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// vendor/sql-wasm.js is a CommonJS/UMD build, but package.json says "type":
// "module", so require() would treat it as ESM. Run it as CommonJS by hand.
function loadVendoredSqlJs() {
  const file = path.join(root, 'vendor/sql-wasm.js');
  const mod = { exports: {} };
  const wrapper = vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${readFileSync(file, 'utf8')}\n})`, { filename: file });
  wrapper(mod.exports, createRequire(file), mod, file, path.dirname(file));
  return mod.exports;
}
const initSqlJs = loadVendoredSqlJs();

globalThis.self ??= globalThis;
globalThis.window ??= globalThis;

const store = new Map();
const memoryStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
};
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true, writable: true });

// The app calls initSqlJs({ locateFile: (f) => `vendor/${f}` }); resolve that from the repo root.
globalThis.initSqlJs = (opts = {}) => initSqlJs({
  ...opts,
  locateFile: (f) => path.join(root, opts.locateFile ? opts.locateFile(f) : `vendor/${f}`),
});

export const ROOT = root;
