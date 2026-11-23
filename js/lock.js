// Single-writer guard across tabs and windows of the same origin.
//
// Uses the Web Locks API (navigator.locks; Safari 15.4+, Chrome 69+) when it is
// available, and a BroadcastChannel handshake otherwise. Either way, db.js also
// fences every save with a writer claim stored in IndexedDB, so a tab that lost
// the lock can't save over the active tab's data even if a message is missed.
//
// handlers.granted() - this tab is now the writer (load the database, then save freely)
// handlers.busy()    - another tab is the writer; offer "use here" (takeOver)
// handlers.lost()    - another tab took over from this one

import { TAB_ID } from './db.js';

const LOCK = 'onebase-writer';
const bc = 'BroadcastChannel' in self ? new BroadcastChannel('onebase-writer') : null;

export function createWriterLock(handlers) {
  let holding = false;
  let queued = null; // AbortController for the queued (wait-for-it) request

  const becameWriter = () => { holding = true; handlers.granted(); };
  const lostIt = () => { if (!holding) return; holding = false; handlers.lost(); };

  // ---- Web Locks ----
  function request(opts) {
    return navigator.locks.request(LOCK, opts, (lock) => {
      if (!lock) return null;
      if (holding) return null; // already the writer through another request
      becameWriter();
      return new Promise(() => {}); // hold until the page goes away or the lock is stolen
    });
  }
  function waitForTurn() {
    if (queued) return;
    queued = new AbortController();
    const ctl = queued;
    request({ signal: ctl.signal }).catch((e) => {
      if (ctl.signal.aborted) return;
      if (queued === ctl) queued = null;
      lostIt();
      waitForTurn();
    });
  }
  function startLocks() {
    request({ ifAvailable: true }).then((r) => {
      if (holding) return;
      handlers.busy();
      waitForTurn();
    }, () => { lostIt(); waitForTurn(); });
  }
  function stealLocks() {
    if (queued) { queued.abort(); queued = null; }
    request({ steal: true }).catch(() => { lostIt(); waitForTurn(); });
  }

  // ---- BroadcastChannel fallback ----
  function onMessage(e) {
    const m = e.data || {};
    if (m.from === TAB_ID) return;
    if (m.type === 'ping' && holding) bc.postMessage({ type: 'pong', from: TAB_ID });
    // With Web Locks the steal also rejects our held request; this just updates the UI sooner.
    if (m.type === 'takeover') lostIt();
  }
  if (bc) bc.addEventListener('message', onMessage);

  function startChannel() {
    let answered = false;
    const listen = (e) => { if (e.data && e.data.type === 'pong' && e.data.from !== TAB_ID) answered = true; };
    bc.addEventListener('message', listen);
    bc.postMessage({ type: 'ping', from: TAB_ID });
    setTimeout(() => {
      bc.removeEventListener('message', listen);
      if (answered) handlers.busy();
      else becameWriter();
    }, 300);
  }

  return {
    get isWriter() { return holding; },
    start() {
      if (navigator.locks && navigator.locks.request) startLocks();
      else if (bc) startChannel();
      else becameWriter(); // nothing to coordinate with; the IndexedDB claim still fences saves
    },
    takeOver() {
      if (holding) return;
      if (bc) bc.postMessage({ type: 'takeover', from: TAB_ID });
      if (navigator.locks && navigator.locks.request) stealLocks();
      else becameWriter();
    },
  };
}
