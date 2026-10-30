# Tasks

A small self-hosted task manager with a calendar view and a REST API.

- **Zero dependencies.** Node 22's built-in HTTP server and SQLite (`node:sqlite`). One container, one database file.
- **Org-mode style scheduling.** Each task can have a *scheduled* date (when to start; it keeps showing on today until done), a *deadline* (shown early, inside a warning period), and a *repeater* (`+1w`, `++1w`, `.+1d`).
- **Agenda view.** Today plus the next 6 days, with overdue scheduled items carried forward and approaching deadlines, then the unscheduled Inbox.
- **Tags and saved views.** Tag tasks (`#work`), then save filter combinations (tags to include/exclude, priority, text, inbox/dated) as views. The selected view applies to the Agenda, List and Calendar alike.
- **Quick-add capture** bar with inline syntax, and a `/api/capture` endpoint for phone shortcuts.
- **Mobile-friendly web UI** with Agenda, List and month Calendar views. On a desktop the calendar goes wide and lists each day's tasks in the cell (click one to edit it). Can be added to your phone's home screen.
- **REST API** for scripts, shortcuts and other apps.
- **Calendar feed** at `/calendar.ics` (scheduled items, deadlines, repeats as RRULEs) for Apple/Google/Outlook calendar.
- **Terminal client** in [`tui/`](tui/README.md): a full-screen TUI that keeps a local copy, works offline and syncs with the server.

## Scheduling, deadlines and repeats

| Field | Meaning |
|-------|---------|
| `scheduled_date` (+ optional `scheduled_time`) | The day you plan to work on it. Until it's done, the agenda keeps showing it on today as "Scheduled N days ago". |
| `deadline_date` | When it must be done. The agenda shows it on today from `warning_days` before (default 14, or `DEFAULT_WARNING_DAYS`) and as "Overdue" after. If the task is scheduled in the future, the early warning waits until the scheduled date. |
| `repeat` | `+Nu` moves the dates forward by N units once; `++Nu` moves them forward until they're in the future, keeping the cadence; `.+Nu` sets them to N units after the day you complete it. Units: `d`, `w`, `m`, `y`. |

Completing a repeating task doesn't mark it done: it records the completion (see `/api/tasks/:id/completions`) and moves the scheduled date and deadline to the next occurrence. Future occurrences show up in the agenda and calendar.

## Quick add

Type in the box at the top of the app (or POST to `/api/capture`):

```
Pay rent @fri ^11-05 -3d +1m !high
```

| Token | Meaning |
|-------|---------|
| `@date` | scheduled date |
| `^date` | deadline |
| `9:30`, `2pm` | scheduled time (today if no date) |
| `+1w` `++1w` `.+1d` | repeater (scheduled today if no date) |
| `-3d`, `-1w` | deadline warning period |
| `!high` / `!!` / `!low` | priority |
| `#tag` | tag (must start with a letter, so `#123` stays in the title) |

Dates: `today`, `tom`, `mon`…`sun` (the next one), `11-05`, `2026-11-05`, `+3d`, `+2w`, `+1m`. Anything without a date lands in the **Inbox**. In the calendar view, an undated capture goes on the selected day. While a view with exactly one tag is selected, new tasks get that tag.

## Views

A view is a saved filter. Pick it from the chips under the quick-add box; it stays selected as you switch between Agenda, List and Calendar (and across reloads). Filters:

| Filter | Meaning |
|--------|---------|
| `tags` | task has **any** of these tags |
| `exclude_tags` | task has **none** of these tags |
| `priority` | any of `high`, `normal`, `low` |
| `q` | title or notes contain this text |
| `scope` | `all`, `dated` (scheduled or with a deadline), or `inbox` (no dates) |

From an iOS Shortcut or Android HTTP Shortcuts app: `POST /api/capture` with a plain-text body (or `{"text": "..."}`).

## Run it

```sh
docker compose up -d --build
```

Then open `http://<server>:8080` (e.g. your Tailscale hostname). Data lives in `./data/tasks.db`; back up that folder.

Without Docker (Node 22.13+): `node server.js`.

### Settings (environment variables)

| Variable    | Default  | Meaning |
|-------------|----------|---------|
| `PORT`      | `8080`   | Listen port |
| `DATA_DIR`  | `./data` (`/data` in Docker) | Where `tasks.db` is stored |
| `API_TOKEN` | *(empty)* | If set, every API call and the `.ics` feed need this token. The web UI asks for it once and remembers it. |
| `TZ`        | `UTC`    | Server time zone: decides "today" for API calls that don't pass `?today=` |
| `DEFAULT_WARNING_DAYS` | `14` | How early deadlines appear on today when a task has no `warning_days` |

Behind Tailscale you can leave `API_TOKEN` empty. Set it if you ever expose the port more widely.

## API

All bodies are JSON. If `API_TOKEN` is set, send `Authorization: Bearer <token>` (or `?token=<token>`).

A task looks like:

```json
{
  "id": 1, "title": "Pay rent", "notes": "",
  "scheduled_date": "2026-11-01", "scheduled_time": null,
  "deadline_date": "2026-11-05", "warning_days": 3, "repeat": "+1m",
  "priority": "high", "done": false, "repeat_count": 4, "tags": ["home", "bills"],
  "created_at": "...", "updated_at": "...", "completed_at": "..."
}
```

`tags` is an array of lowercase strings (a space-separated string is also accepted). Dates are `YYYY-MM-DD`, times `HH:MM`; all optional. `priority` is `low`, `normal` or `high`.

"Today" for the agenda and for repeats is taken from `?today=YYYY-MM-DD` when given (the web UI always sends the phone's date), otherwise the server's local date, so set `TZ` in `docker-compose.yml`.

| Method | Path | Notes |
|--------|------|-------|
| `GET`    | `/api/tasks` | Filters: `from`, `to` (scheduled or deadline in range), `done=true\|false`, `inbox=true`, `repeating=true`, plus the view filters below |
| `POST`   | `/api/tasks` | `title` required |
| `POST`   | `/api/capture` | Quick-add text, parsed as above |
| `GET`    | `/api/agenda` | `from`, `to` (default: today + 6 days). Days with entries `{kind: scheduled\|deadline, carried, days, task}` |
| `GET`    | `/api/tasks/:id/completions` | Completion history |
| `GET`    | `/api/tags` | Tags in use, with total and open counts |
| `GET` `POST` | `/api/views` | List / create views: `{"name": "Work", "filters": {"tags": ["work"]}}` |
| `GET` `PATCH` `PUT` `DELETE` | `/api/views/:id` | |
| `GET`    | `/api/tasks/:id` | |
| `PATCH`  | `/api/tasks/:id` | Change only the fields you send; `{"done": true}` completes (or advances a repeating task) |
| `PUT`    | `/api/tasks/:id` | Replace the task; omitted fields reset to defaults |
| `DELETE` | `/api/tasks/:id` | |
| `GET`    | `/calendar.ics` | iCalendar feed of dated tasks |
| `GET`    | `/api/health` | Health check |

`/api/tasks` and `/api/agenda` accept view filters as query parameters: `view=<id>` (a saved view), and/or `tag=a,b`, `not_tag=c`, `priority=high,normal`, `q=text`, `scope=inbox|dated`.

Examples:

```sh
curl -X POST http://tasks:8080/api/tasks -H 'Content-Type: application/json' \
  -d '{"title":"Pay rent","scheduled_date":"2026-11-01","deadline_date":"2026-11-05","repeat":"+1m"}'

curl -X POST http://tasks:8080/api/capture -d 'Call dentist @mon 10am !high'

curl 'http://tasks:8080/api/agenda?tag=work'

curl -X PATCH http://tasks:8080/api/tasks/3 -H 'Content-Type: application/json' -d '{"done":true}'
```

## Development

```sh
node server.js   # http://localhost:8080
npm test         # API tests (node:test)
```

Upgrading from the first version is automatic: the old `due_date`/`due_time` become `scheduled_date`/`scheduled_time` on first start.
