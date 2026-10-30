# tasks-tui

A terminal client for the Tasks server. It keeps a full copy of your tasks in a local SQLite file, so it opens instantly and works offline (on a plane, off Tailscale, server down). Changes are queued and sent on the next sync.

Like the server it has no dependencies: Node 22.13+ only. It reuses `public/shared.js`, so quick-add syntax, dates and repeaters behave exactly as in the web app.

## Run it

```sh
node tui/tasks-tui.js config --server http://tasks.your-tailnet.ts.net:8080   # once; add --token if API_TOKEN is set
node tui/tasks-tui.js                                                          # full-screen UI
```

Or `npm link ./tui` (or `npm i -g ./tui`) to get a `tasks-tui` command. Settings live in `~/.config/tasks-tui/config.json`; the local copy in `~/.local/share/tasks-tui/tasks.db`. `TASKS_SERVER`, `TASKS_TOKEN` and `TASKS_DB` (or `--server`, `--token`, `--db`) override them. With no server set it works as a local-only task list.

Other commands, handy in scripts and shell aliases:

```sh
tasks-tui add Call dentist @mon 10am !high #health   # queued locally, then sent if the server is reachable
tasks-tui agenda                                      # print the next 7 days
tasks-tui sync                                        # sync once
tasks-tui log                                         # conflicts and rejected changes
```

## Keys

| Key | |
|-----|--|
| `1` `2` / `tab` | Agenda (7 days + Inbox) / All tasks |
| `j` `k` `↓` `↑` `g` `G` `PgUp` `PgDn` | move |
| `enter` | details |
| `a` | quick add, same syntax as the web app (`@fri ^11-05 9am +1w -3d !high #tag`) |
| `e` | edit: the task is shown as quick-add text; change any token and press enter |
| `x` / `space` | done / not done (a repeating task moves to its next date) |
| `s` / `d` | set scheduled date (optionally `fri 9:30`) / deadline; empty clears |
| `>` / `<` | reschedule a day later / earlier |
| `p` | cycle priority |
| `n` | edit notes in `$EDITOR` |
| `D` | delete |
| `/` | search; `esc` clears |
| `v` / `V` | cycle through saved views (made in the web app) |
| `h` / `l` / `t` | agenda: previous / next week / today |
| `H` | All tasks: show done |
| `r` | sync now (it also syncs every minute and a moment after each change) |
| `L` | sync log |
| `?` | help |
| `q` | quit (sends any unsent changes first) |

The status line shows the sync state and how many changes are waiting. Tasks with unsent changes have a `↑`.

## How sync works

It works against the server's existing REST API; no server changes needed.

- **Local store.** `tasks` holds your copy of every task (the server's JSON as-is, so new fields such as tags come along). `outbox` holds changes not yet sent. Tasks created offline get a negative id until the server assigns one.
- **A sync** pulls every task (`GET /api/tasks`) and the saved views, sends the outbox in order against that snapshot, then makes the snapshot your local copy (keeping anything you changed while the sync ran).
- **Edits** are sent as `PATCH` with only the fields you changed. Each queued edit remembers what each field was before you changed it, so the sync can tell three cases apart: only you changed it (yours is sent), only the server changed it (theirs is kept), or both did. In that last case **the later edit wins**, comparing your edit time with the server's `updated_at`, and the outcome goes in the sync log. Different fields changed on different devices merge cleanly.
- **Completing** is its own kind of change because it isn't idempotent: completing a repeating task twice advances it twice. It records the `repeat_count` you completed it at, and is skipped (and logged) if the task was completed elsewhere in the meantime.
- **Deletes** win over edits on the other side: deleting here removes it on the server, and an edit to a task someone deleted on the server is dropped and logged.
- **Creates** whose response was lost (connection dropped mid-request) are matched to the task the server made, by title and time, instead of being sent twice.
- Network errors, timeouts, 5xx and 401 leave the outbox untouched for the next try. A change the server rejects with 4xx (say, an invalid date) is dropped and logged so it can't block the queue.

### Server additions that would make it better (not done yet)

- `GET /api/tasks?updated_since=<time>` plus tombstones for deleted tasks, so a sync fetches only what changed instead of every task. Full pulls are fine at a few thousand tasks.
- An idempotency key on `POST /api/tasks` (a client-generated id), replacing the title-and-time match for lost responses.
- Conditional `PATCH` (`If-Unmodified-Since`, or an expected `updated_at` that returns 409), so conflict checks are atomic instead of comparing against the snapshot from the start of the sync.
- Moving `agenda()` from `server.js` into `public/shared.js`. The TUI has a copy for offline use; a test checks both give the same result.

## Limits

- Run one instance per database file at a time.
- Saved views are read-only here; make and edit them in the web app.
- Completion history (`/api/tasks/:id/completions`) isn't shown.

## Tests

`npm test` from the repo root runs these too. They start a real server and check offline creates, merges, conflicts, repeats, deletes, lost responses, rejected changes, views and agenda parity.
