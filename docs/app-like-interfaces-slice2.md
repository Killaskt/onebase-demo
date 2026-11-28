# App-like interfaces: slice 2 (smart generation + sessions)

Decided 2026-11-28 after Shaz tested slice 1 on his iPhone. A vague prompt ("workout tracker")
produced a flat app: two forms over one table. The user should not have to be an expert prompter.
A short request should come back better than what was typed, as it does in a normal Claude chat.

## Why the result was flat

1. **The vocabulary can't express it.** Every block reads or adds rows of one flat table. A
   workout session holding several exercises and sets needs parent and child records.
2. **No thinking step.** The call runs at `effort: low` and goes straight to JSON. In chat, Claude
   first works out what you meant.
3. **No domain knowledge.** Nothing tells the agent what a workout, habit or spending app
   normally has.

## Track A: engine (closed vocabulary additions)

All still declarative. The renderer writes every SQL statement, parameterised. Nothing is executed.

### A1. `datetime` column kind
`{ "key": "started_at", "kind": "datetime" }` holds an ISO timestamp (`2026-11-28T08:38:00`).
SQL type `DATETIME`. Forms show `<input type="datetime-local">` defaulting to now. It is shown as
`Nov 28, 8:38 AM`. It is allowed where `date` is allowed (chart x, sort, groupBy month).

### A2. `ref` column kind (parent and child records)
`{ "key": "session", "kind": "ref", "to": "sessions" }`, where `to` names another slot in `needs`.
It holds the parent row's `id`, SQL type `INTEGER`. A ref is never shown as a form field: it is
filled in by scope (below). The binding sheet shows the pair, for example "sets → sessions".

### A3. Flows: start / finish (the lifecycle pattern)
A need can declare that its rows are flows with a start and an end:

```json
{ "slot": "sessions", "access": "write", "flow": { "start": "started_at", "end": "ended_at", "screen": "active" },
  "columns": [ { "key": "started_at", "kind": "datetime" }, { "key": "ended_at", "kind": "datetime" }, { "key": "notes", "kind": "text" } ] }
```

- `start` and `end` must be `datetime` columns of that slot. `screen` is the screen shown while a
  flow is open.
- **The open flow** is the newest row of that slot whose `end` is null. It lives in the database,
  so a reload or a killed app resumes it.
- New button actions:
  - `{ "type": "button", "label": "Start workout", "action": "start", "slot": "sessions" }`
    inserts a row with `start` = now and navigates to `flow.screen`. If a flow is already open, it
    just navigates there.
  - `{ "type": "button", "label": "Finish", "action": "finish", "slot": "sessions" }` sets `end` = now
    on the open flow, then goes back to home.
  - A button has either `to` or `action`, never both.
- **Active bar:** while a flow is open and the user is not on `flow.screen`, the shell shows a slim
  sticky bar at the bottom: "<interface name> · 23 min · Resume". Tapping it opens `flow.screen`.

### A4. Scope: blocks that follow a parent row
`"scope"` on a `form`, `list` or `stats` block whose slot has a `ref` column:

- `"scope": "open"` means use the open flow of the ref's target slot. A form fills the ref in
  automatically. Lists and stats only count rows of that flow. If there is no open flow, the form
  is replaced by a note: "Start one first".
- `"scope": "row"` means use the row this screen was opened for (see A5).

### A5. Row detail screens
A list can open a screen for the tapped row: `{ "type": "list", ..., "open": "session_detail" }`.
That screen receives the row's id. On it, blocks with `"scope": "row"` follow that row:

- on the same slot, they show that one row;
- on a child slot, they show its children.

### A6. Validator rules
- `ref.to` is an existing slot other than its own.
- `flow.start` and `flow.end` are datetime columns of the slot, and `flow.screen` is an existing
  screen.
- `action` buttons name a slot with a `flow`, and that slot needs write access.
- `scope` needs a ref column in the block's slot, pointing at the flow slot (for `open`) or at the
  list's slot (for `row`).
- A screen that is a `list.open` target counts as reachable.

## Track B: agent brain (better than what you typed)

### B1. Think first, then build
New interfaces go through two steps in one call. The model first writes a short **app brief**
inside `<brief>` tags, which the app strips out. Then it writes the reply and the JSON. The brief
covers:

- who it's for;
- the core records and how they relate;
- the 3–5 things the user comes to do (intents);
- the screens;
- smart defaults the user didn't ask for but would expect;
- what's out of scope.

The user-facing reply summarises the result in plain words, including the assumptions made
("I assumed you train in sessions of several exercises; say if you'd rather log single sets").
`effort` is `medium` for new interfaces and `low` for small edits and questions.

### B2. Recipe library (`js/recipes.js`)
Curated "what an app developer already knows" for common personal-tracking domains. Each recipe
covers:

- **match:** the keywords that select it;
- **assumptions:** the records and relations it implies;
- **intents:** what the user comes to do;
- **must-have screens;**
- **default stats and charts;**
- **nice-to-haves.**

The recipes are:

- workouts and training (sessions → sets; exercises, PRs and volume; a rest note);
- runs, rides and cardio;
- habits and streaks;
- spending and budget;
- reading;
- meals and nutrition;
- sleep and mood journal;
- general "track X".

The best matching recipe, or two, is added to the context sent with a new-interface request. A
compact general checklist is always added for any app. It covers home, intents, history, progress,
editing, empty states and resume.

### B3. Quality lint plus one repair
Beyond the validator, `lintSpec(spec)` returns soft problems, for example:

- home has no primary action;
- a logging app has no history screen;
- an app with a date and a number has no progress view;
- a screen has more than one primary button;
- a list has no sort;
- a flow slot has no Finish button.

Hard validator errors and lint problems both feed the existing single repair attempt.

### B4. Evaluation harness (opt-in, uses a real key)
`tests/eval/` holds about 8 deliberately vague prompts ("workout tracker", "track my spending",
"habit app", …). `npm run eval` generates each one with the real model and runs the validator and
lint. It prints a scorecard (screens, intents, use of flows and refs, lint score) and saves the
specs. It never runs in CI, and it is skipped without `ANTHROPIC_API_KEY`. It costs a few cents per
prompt.

## Track C: polish from the phone test

- The edge tab reads as a scrollbar. Make it a visible but quiet pill with a grip.
