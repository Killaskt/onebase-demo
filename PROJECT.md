# OneBase: project brief

This document describes the whole project: the problem, the vision, what is built today, and what is planned. Sections marked **planned** are not built. Items marked *(inferred)* are a reading of the intent, not decisions.

## One-liner

"Obsidian for apps": your personal data lives in one database you own, on your phone or in your own cloud database, and the "apps" are small, swappable interfaces over it. The data is permanent; the interfaces are disposable.

## The problem

There are two problems, and they share a cause.

1. **Your data is stranded inside apps.** Every app keeps its own copy. Stop using the app and the data goes with it; want a different view and you need a different app plus an export or re-entry job.
2. **You're stuck with the app maker's interface and algorithms.** This bites hardest in exercise and finance apps. The app decides how your fitness is scored, what counts as a "good" week, how spending is categorised and what the dashboard emphasises. If you disagree, your only options are to put up with it or leave, and leaving means losing your history.

The cause is that the data, the interface and the logic are welded together and owned by the vendor.

## Vision

Pull the three apart and give each to the user.

- **Data:** one database owned by the user, outliving any interface. The user chooses where it lives (see Storage modes).
- **Interfaces:** small and replaceable. Install one from a marketplace, have an agent generate one from a description, or swap one you dislike for another over the same data.
- **Algorithms:** visible and editable. If you don't like how something is ranked, scored or categorised, you change the rule or ask the agent to.
- **Connectors (planned):** a way to bring data from existing services into your database, so you can keep the sources you already have and put your own interfaces and rules on top.

## Who it's for

People who track things about their own lives (training, spending, habits, mileage, scores) and are unhappy with how their current apps present or judge that data. The early audience is the local-first, Obsidian-style crowd who already care about owning their files.

## Core principles

1. **Data outlives interfaces.** Uninstalling an interface never deletes a row.
2. **One database, owned by the user.** On-device by default. A cloud database is the user's own, not a OneBase-hosted store.
3. **Interfaces are declarative specs, not code.** The app renders the spec; nothing generated is ever executed.
4. **Explicit data binding.** An interface says what it needs; the user picks which table it gets, with read or write access, and can deny.
5. **The user owns the algorithm.** Ranking, filtering and summary rules are part of the spec and editable.
6. **The agent never sees rows.** It gets table and column names plus the user's messages, and returns a spec.

## Storage modes

| Mode | Where the data lives | Status |
|---|---|---|
| On-device | SQLite on the phone; works fully offline | Built (the demo) |
| Cloud | The user's own Supabase (or other cloud) database | Planned |
| Hybrid | A cloud or local database plus tables fed by connectors | Planned |

Interfaces should not care which mode is in use: they bind to tables with read or write access either way.

## Connectors (planned, not built)

A connector pulls the user's data from an outside source into a table in their database. Examples would be a fitness service, a bank or card export, a health app, or a CSV file. Once the rows are in the database, any interface can bind to them like any other table. In hybrid mode, connector data sits alongside the user's own tables, and interfaces can bind to either.

What this implies *(inferred, none of it decided)*:

- Each connector declares which tables and columns it writes, and goes through the same Allow/Deny step as an interface.
- Imports are one-way into the user's database; the source is never the system of record.
- Most real sources need sign-in and a server-side token exchange, which conflicts with having no backend. File import (CSV, exports) avoids that and is the natural first connector.
- Repeated imports need de-duplication, so imported rows need a stable source ID.

## What exists today

A clickable demo, built as an installable, offline web app. It uses the on-device storage mode only.

- **Live:** https://killaskt.github.io/onebase-demo/
- **Code:** https://github.com/Killaskt/onebase-demo (public)

**Purpose of the demo:** prove one moment in under 60 seconds. Enter data in one interface, open another and the data is already there, delete the first and nothing is lost.

### Screens

- **Home:** grid of installed interfaces, a "New interface" button, a database summary, and a persistent "Offline · on this device" indicator.
- **Marketplace:** three working interfaces and three "Soon" placeholders (Mileage Tracker, Habit Streaks, Reading List).
- **My Data:** the raw tables and rows, which interfaces use each table, and "Export database" (downloads a SQLite file).
- **Interface view:** a flip control between using the interface and its agent session; a menu for bindings, history and uninstall.

### Seeded interfaces

| Interface | Table | Access | What it does |
|---|---|---|---|
| Bowling Scorer | `games` | Read and write | Form to add a game (date, score, location); recent games list |
| Sports Stats | `games` | Read only | Average, best game, count, trend chart, "Best games" list with an editable ranking rule |
| Expense Log | `expenses` | Read and write | Form to add an expense (date, amount, category); total and recent list |

Seed data is 12 bowling games and 10 expenses.

### Data binding

- On install, a sheet lists what the interface needs, suggests a table, and lets the user pick another or create a new one.
- A table is only suggested when it clearly matches (same name as the slot, or every needed column present by name); otherwise the suggestion is a new table.
- Access is shown as read or read-and-write per table. Deny cancels the install.
- Bindings can be changed later from the interface's menu.

### Editable rule

In Sports Stats, "Edit ranking rule" changes the sort (highest, lowest, most recent, oldest), filters to one location, and sets how many to show. The list updates immediately.

### Agent sessions

- "New interface" opens a chat; the agent returns a spec, the user binds data, and it appears on Home.
- Every interface has a session where the user can ask what it does or request changes. Changes apply live.
- If a change needs more access (for example read to write), the binding sheet reopens for approval.
- Every change is a version; history has one-tap undo and restore.
- With a Claude API key pasted in (stored only on the device, outside the database), it calls the model directly. Without one, it runs three scripted sessions and a handful of scripted edits.

### Uninstall

Long-press an interface or use its menu. The confirmation names the tables and row counts that stay.

## How it works

- **Storage:** real SQLite in the browser (sql.js, bundled in `vendor/`), saved to the device's IndexedDB after every write. App bookkeeping (installed interfaces, bindings, versions, chats) lives in hidden `_ob_*` tables in the same database.
- **Spec:** JSON with `needs` (table slots, column kinds of date, number or text, and read/write access) and `blocks` (form, stats, chart, list, note). A validator rejects anything outside that vocabulary.
- **Rendering:** a spec plus its bindings becomes screens and parameterised database queries.
- **Model:** `claude-opus-5-5` at low effort, called from the browser with the user's own key.
- **Offline and install:** a service worker caches every file; a web manifest and icons make it installable to a home screen.
- **No build step:** plain HTML, CSS and JavaScript, hosted on GitHub Pages.

| File | Role |
|---|---|
| `js/db.js` | The database: open, query, save, export |
| `js/spec.js` | Spec validation; matching needs to tables |
| `js/render.js` | Turns spec blocks into UI and queries |
| `js/agent.js` | Model call, scripted fallback, edits |
| `js/app.js` | Screens, sheets, install/uninstall, versions |
| `js/seed.js` | Seed data and the marketplace catalog |
| `sw.js`, `manifest.webmanifest` | Offline and home-screen install |

### What a second storage mode means for the code

Every query goes through `js/db.js`, which is the natural seam for a cloud mode. The queries that `js/render.js` builds are written for SQLite, so cloud mode (Supabase is Postgres) would need those reworked too.

## Verified and not verified

- **Verified:** both demo flows on the live site, data surviving reloads, loading with the server stopped, a valid SQLite export, and the model producing valid specs (run from Node).
- **Not verified:** installing on a physical iPhone or Android device, and the model call made from inside a browser.

## Known limits

- Only the on-device mode exists. There is no cloud database support and no way to switch modes.
- No connectors or import of any kind; all data is typed in or seeded.
- The "Offline · on this device" indicator is hard-coded, so it would be wrong in cloud mode.
- Interfaces can add rows but not edit or delete them.
- The only user-editable algorithm is list ranking (sort, one filter, count). Scoring formulas, categorisation rules and custom calculations are not expressible yet.
- Binding is per table; there is no column-level or row-level permission.
- Without an API key, typed requests only work if they match the scripted examples.
- The marketplace is a fixed list in the code.

## Out of scope for the demo

Cloud storage modes, connectors, sync and accounts are in scope for the product but not the demo. A drag-and-drop builder and settings beyond the API key field are out of scope for both.

## Open questions

- How far does the spec need to grow to cover the algorithms people actually object to in exercise and finance apps (scores, budgets, categories)?
- Which connector comes first, and can connectors work without a server?
- In hybrid mode, is connector data copied into the user's database or queried live from the source? *(inferred)*
- Supabase is Postgres and the device is SQLite. Do specs target one common subset, or does each mode get its own query layer? *(inferred)*
- Does cloud mode need sign-in, and does the "agent never sees rows" rule hold the same way there? *(inferred)*
- Can a user move from on-device to cloud later without losing data or bindings?
- Is this a native app eventually, or does the web app stay the product?
- How are marketplace interfaces and connectors shared and trusted?
- What happens when interfaces want incompatible shapes for the same table?
