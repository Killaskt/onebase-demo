# OneBase demo

A clickable prototype of "Obsidian for apps": all your data lives in one SQLite database on your device, and the apps are small, swappable interfaces over it. Delete an interface and the data stays.

It is a static, installable PWA. No build step, no backend.

## Run locally

```bash
python -m http.server 8765
```

Then open http://localhost:8765.

## How it works

- **Storage:** real SQLite (sql.js, vendored in `vendor/`), saved to IndexedDB after every write. `js/db.js` is the only module that touches it.
- **Interfaces:** each one is a declarative JSON spec (`needs` + `blocks`) that `js/render.js` turns into UI and parameterised SQL. `js/spec.js` validates specs and matches their needs against your tables.
- **Agent sessions:** `js/agent.js`. With a Claude API key (stored in `localStorage` on the device) it calls the API directly from the browser and sends only table and column names plus your messages. Without a key it runs scripted sessions.
- **Offline:** `sw.js` precaches every file.

## Reset the demo data

Clear the site's data in the browser (or delete and reinstall the home-screen app). The seed data is recreated on next open.
