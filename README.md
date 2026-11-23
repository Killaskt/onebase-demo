# OneBase demo

A clickable prototype of "Obsidian for apps": all your data lives in one SQLite database on your device, and the apps are small, swappable interfaces over it. Delete an interface and the data stays.

It is a static, installable PWA. No build step, no backend.

## Run locally

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765.

## How it works

- **Storage:** real SQLite (sql.js, vendored in `vendor/`), saved to IndexedDB after every write. `js/db.js` is the only module that touches it.
- **Interfaces:** each one is a declarative JSON spec (`needs` + `blocks`) that `js/render.js` turns into UI and parameterised SQL. `js/spec.js` validates specs and matches their needs against your tables.
- **Agent sessions:** `js/agent.js`. With a Claude API key (stored in `localStorage` on the device) it calls the API directly from the browser and sends only table and column names plus your messages. Without a key it runs scripted sessions.
- **Offline:** `sw.js` precaches every file. Bump `CACHE` in `sw.js` and add any new file to `FILES` when you ship.

## Data safety

- **Unreadable storage never becomes a fresh start.** "No database yet" (nothing stored) is told apart from "the read failed". If IndexedDB can't be read or the stored file can't be opened, OneBase shows *Couldn't open your data* with **Try again** and writes nothing: no seed data, no save. The first save of a brand-new database is create-only, so it can't replace a record that turns up later.
- **One writer at a time.** `js/lock.js` uses the Web Locks API (BroadcastChannel fallback) so only one tab or window can change the database. Another tab shows *OneBase is open in another tab* with **Use OneBase here instead**, and opens by itself when the other tab closes. Each save is also checked against a writer claim inside the same IndexedDB transaction, so a tab that lost the lock can't save over the active tab's data.
- **Save errors are visible.** If a save fails (for example, the device is out of space), a red banner says so and offers **Retry**. The change stays on screen until it is saved.
- **Storage persistence.** OneBase asks the browser to keep its data (`navigator.storage.persist()`) after your first save, or when the installed app launches. My Data shows the status (*Persistent* or *Best effort*) and has a button to ask again.
- **iPhone: install first.** In iOS Safari (not when already installed) Home shows a dismissible card asking you to Add to Home Screen first. On iOS the Home Screen app keeps its own data, separate from Safari, and Safari can clear data for sites you haven't opened in a week.
- **Backup and restore.** My Data → **Export database** downloads `onebase.sqlite`. **Restore from a .sqlite file…** replaces everything on the device with a SQLite file (checked with sql.js first). A backup of the current database downloads before anything is replaced. Merging is not supported yet.

## Reset the demo data

Clear the site's data in the browser (or delete and reinstall the home-screen app). The seed data is recreated on next open, but only when the browser reports that nothing is stored; a failed read never resets anything.
