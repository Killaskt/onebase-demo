# App-like interfaces: slice 1 (screens, navigation, immersive look)

Decided by Shaz on 2026-11-28 (OneBase Plan & Roadmap, decision 10). Goal: the demo shows that a
mini app generated over your own data can look and behave like a real app, not one stacked form.

Out of this slice (next): workout sessions (`ref` column kind, start/finish), charts by week,
`derive`, `bignumber`.

## 1. Spec format (v2, still closed vocabulary)

A spec has **either** top-level `blocks` (v1, still valid, rendered as one screen) **or** `screens`:

```json
{
  "name": "Training Log", "icon": "🏋️", "color": "#2b8a3e", "description": "...",
  "needs": [ ... unchanged ... ],
  "screens": [
    { "id": "home", "title": "Training", "blocks": [ ... ] },
    { "id": "log", "title": "Log a set", "blocks": [ ... ] }
  ]
}
```

- 1 to 8 screens. The first one is home. Ids are identifiers, unique, and not `back`.
- Each screen has a non-empty `title` and 1 to 8 blocks.
- Every screen other than home must be reachable: some `button.to` or `form.then` points at it.
- Shared helpers in `js/spec.js`: `screensOf`, `homeScreenId`, `screenById`, `allBlocks`, `blockAt`.
  A block is addressed by a ref string `"<screenId>.<index>"` (for example `"home.0"`).

### New block: `button`

```json
{ "type": "button", "label": "Log a set", "to": "log", "style": "primary" }
```

- `to`: a screen id, or `"back"`.
- `style`: `primary` (one filled full-width button: the screen's main intent), `secondary`
  (outlined), or `link` (a list row with a chevron, for menus like "History ›"). Default `primary`.
- No URLs, no free-form actions.

### Form: optional `then`

`{ "type": "form", ..., "then": "back" }` navigates after a successful save: a screen id or `"back"`.
This is the "complete the intent, return to where you came from" pattern.

## 2. Navigation and lifecycle (app shell)

- Each open interface has a screen stack, starting at home. `to: id` pushes, `back` pops.
- Sub-screens show a minimal header with a back arrow and the screen title. Home shows the
  interface's own large title with its icon. No OneBase chrome.
- **Resume:** the stack per interface, and which interface was open, are remembered on the device
  (`localStorage`, per-viewer UI state only; never data). Reopening the app or the interface returns
  to the same screen. If an edit removes that screen, fall back to home.

## 3. Immersive chrome

Inside an interface there is no OneBase top bar, no "Home" back button, no Interface/Agent toggle
and no tab bar. The only OneBase control is a **low-key edge tab**: a thin, semi-transparent handle
on the right edge, vertically centred, with a large invisible hit area. It pulses once the first
time it is ever shown.

Tapping it (or swiping left from it) opens a **side drawer** from the right with:

- the interface icon and name
- **Edit with agent**: opens the agent chat as a tall bottom sheet over the live interface, so
  changes show behind it (version bar with Undo and History stays at the top of that sheet)
- **Home**: back to OneBase Home
- **Data & bindings**, **Version history**, **Uninstall**

The save-error banner still appears over everything when a save fails (data safety wins over looks).

## 4. Agent: app-developer-aware generation

The prompt teaches the model to design like an app developer:

- Think in **intents**: what does the user come to do? Each main intent gets a clear place and one
  primary button.
- Default shape for anything that logs data: **home** (summary stats, one primary button for the
  main intent, recent items, link rows to other screens), an **entry** screen (the form, with
  `then: "back"`), and a **history/progress** screen when there is a date plus a number.
- One primary action per screen; at most about 5 blocks per screen.
- Never answer "single screen only" or "I can't" when the catalog comes close. Build the closest
  version and say plainly what is not possible yet.
- The training log is the worked example in the prompt.
