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

- **Local store.** `tasks` holds your copy of every task (the server's JSON as-is, so new fields such as tags come along), `server` the server's version as of the last sync, and `outbox` the changes not yet sent. Tasks created offline get a negative id until the server assigns one.
- **A sync** asks `GET /api/sync?since=<cursor>` for only what changed since last time (including deletes), sends the outbox in order against that snapshot, then makes the snapshot your local copy (keeping anything you changed while the sync ran). If the server's database is a different one, or was restored from a backup, the server says so and the client does a full resync.
- **Edits** are sent as `PATCH` with only the fields you changed. Each queued edit remembers what each field was before you changed it, so the sync can tell three cases apart: only you changed it (yours is sent), only the server changed it (theirs is kept), or both did. In that last case **the later edit wins**, comparing your edit time with the server's `updated_at`, and the outcome goes in the sync log. Different fields changed on different devices merge cleanly.
- **Writes are conditional.** Every `PATCH` carries `If-Match` with the task version the merge was based on. If someone changed the task in the meantime, the server answers 412 with the current task and the client redoes the merge against it.
- **Completing** is its own kind of change because it isn't idempotent: completing a repeating task twice advances it twice. It records the `repeat_count` you completed it at, and is skipped (and logged) if the task was completed elsewhere in the meantime.
- **Deletes** win over edits on the other side: deleting here removes it on the server, and an edit to a task someone deleted on the server is dropped and logged.
- **Creates** carry an `Idempotency-Key`, so if the connection drops after the server made the task, the retry gets that same task back instead of a duplicate.
- Network errors, timeouts, 5xx and 401 leave the outbox untouched for the next try. A change the server rejects with 4xx (say, an invalid date) is dropped and logged so it can't block the queue.
- **Older servers** (without `/api/sync`) still work: the client falls back to fetching every task and matching lost creates by title and time.

The agenda is `agenda()` from `public/shared.js`, the same code behind `/api/agenda`, so it looks the same offline.

## Limits

- Run one instance per database file at a time.
- Saved views are read-only here; make and edit them in the web app.
- Completion history (`/api/tasks/:id/completions`) isn't shown.

## Tests

`npm test` from the repo root runs these too. They start a real server and check offline creates, merges, conflicts, repeats, deletes, lost responses, rejected changes, views and agenda parity.
