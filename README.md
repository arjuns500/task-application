# Tasks

A small self-hosted task manager with a calendar view and a REST API.

- **Zero dependencies.** Node 22's built-in HTTP server and SQLite (`node:sqlite`). One container, one database file.
- **Mobile-friendly web UI.** List view (Overdue / Today / Upcoming / No date / Done) and a month calendar. Can be added to your phone's home screen.
- **REST API** for scripts, shortcuts and other apps.
- **Calendar feed** at `/calendar.ics` so tasks with due dates show up in Apple/Google/Outlook calendar.

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
| `TZ`        | `UTC`    | Container time zone (only affects logs; dates are stored as plain `YYYY-MM-DD`) |

Behind Tailscale you can leave `API_TOKEN` empty. Set it if you ever expose the port more widely.

## API

All bodies are JSON. If `API_TOKEN` is set, send `Authorization: Bearer <token>` (or `?token=<token>`).

A task looks like:

```json
{
  "id": 1, "title": "Dentist", "notes": "",
  "due_date": "2026-11-04", "due_time": "14:30",
  "priority": "normal", "done": false,
  "created_at": "...", "updated_at": "...", "completed_at": null
}
```

`due_date` (`YYYY-MM-DD`) and `due_time` (`HH:MM`) are optional. `priority` is `low`, `normal` or `high`.

| Method | Path | Notes |
|--------|------|-------|
| `GET`    | `/api/tasks` | Filters: `from`, `to` (due date range), `done=true\|false`, `undated=true`, `q` (text search) |
| `POST`   | `/api/tasks` | `title` required |
| `GET`    | `/api/tasks/:id` | |
| `PATCH`  | `/api/tasks/:id` | Change only the fields you send |
| `PUT`    | `/api/tasks/:id` | Replace the task; omitted fields reset to defaults |
| `DELETE` | `/api/tasks/:id` | |
| `GET`    | `/calendar.ics` | iCalendar feed of dated tasks |
| `GET`    | `/api/health` | Health check |

Examples:

```sh
curl -X POST http://tasks:8080/api/tasks -H 'Content-Type: application/json' \
  -d '{"title":"Pay rent","due_date":"2026-11-01","priority":"high"}'

curl 'http://tasks:8080/api/tasks?from=2026-11-01&to=2026-11-30&done=false'

curl -X PATCH http://tasks:8080/api/tasks/3 -H 'Content-Type: application/json' -d '{"done":true}'
```

## Development

```sh
node server.js   # http://localhost:8080
npm test         # API tests (node:test)
```
