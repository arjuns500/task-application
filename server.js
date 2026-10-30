// Tasks: a small self-hosted task manager with a calendar.
// Zero dependencies: Node's built-in http server and SQLite (node:sqlite).
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const S = require('./public/shared.js');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const API_TOKEN = process.env.API_TOKEN || ''; // optional; empty = no auth
const DEFAULT_WARNING_DAYS = Number(process.env.DEFAULT_WARNING_DAYS ?? 14); // like org-deadline-warning-days
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'tasks.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
migrate();

function migrate() {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const hasTasks = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").get();
  if (!hasTasks) {
    db.exec(`
      CREATE TABLE tasks (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        title          TEXT NOT NULL,
        notes          TEXT NOT NULL DEFAULT '',
        scheduled_date TEXT,              -- YYYY-MM-DD: when to start working on it
        scheduled_time TEXT,              -- HH:MM, optional
        deadline_date  TEXT,              -- YYYY-MM-DD: when it must be done
        warning_days   INTEGER,           -- days before the deadline to start showing it; null = default
        repeat         TEXT,              -- org-style repeater: +1w, ++1w, .+1d
        priority       TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
        done           INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        completed_at   TEXT,              -- last time it was completed (repeating tasks too)
        repeat_count   INTEGER NOT NULL DEFAULT 0
      );`);
  } else if (version < 2) {
    // v1 had a single due_date/due_time; treat it as the scheduled date.
    db.exec(`
      BEGIN;
      ALTER TABLE tasks ADD COLUMN scheduled_date TEXT;
      ALTER TABLE tasks ADD COLUMN scheduled_time TEXT;
      ALTER TABLE tasks ADD COLUMN deadline_date TEXT;
      ALTER TABLE tasks ADD COLUMN warning_days INTEGER;
      ALTER TABLE tasks ADD COLUMN repeat TEXT;
      ALTER TABLE tasks ADD COLUMN repeat_count INTEGER NOT NULL DEFAULT 0;
      UPDATE tasks SET scheduled_date = due_date, scheduled_time = due_time;
      DROP INDEX IF EXISTS idx_tasks_due;
      ALTER TABLE tasks DROP COLUMN due_date;
      ALTER TABLE tasks DROP COLUMN due_time;
      COMMIT;`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_sched ON tasks(scheduled_date);
    CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline_date);
    CREATE TABLE IF NOT EXISTS completions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      done_at        TEXT NOT NULL,
      scheduled_date TEXT,
      deadline_date  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_completions_task ON completions(task_id);
    PRAGMA user_version = 2;`);
}

const PRIORITIES = ['low', 'normal', 'high'];
const FIELDS = ['title', 'notes', 'scheduled_date', 'scheduled_time', 'deadline_date', 'warning_days', 'repeat', 'priority', 'done'];
const DEFAULTS = { notes: '', scheduled_date: null, scheduled_time: null, deadline_date: null, warning_days: null, repeat: null, priority: 'normal', done: false };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function toTask(row) {
  return row && { ...row, done: !!row.done };
}

// The date "today" is relative to: ?today=YYYY-MM-DD from the client, else the server's local date (TZ).
function todayFrom(url) {
  const t = url.searchParams.get('today');
  if (t && !S.isValidDate(t)) throw new HttpError(400, 'today must be YYYY-MM-DD');
  return t || S.localToday();
}

// Validates a create/update body. `partial` allows missing fields (PATCH).
function validate(body, partial) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be a JSON object');
  const out = {};
  const blank = k => body[k] == null || body[k] === '';
  if ('title' in body || !partial) {
    if (typeof body.title !== 'string' || !body.title.trim()) throw new HttpError(400, 'title is required');
    out.title = body.title.trim().slice(0, 500);
  }
  if ('notes' in body) {
    if (body.notes != null && typeof body.notes !== 'string') throw new HttpError(400, 'notes must be a string');
    out.notes = body.notes || '';
  }
  for (const k of ['scheduled_date', 'deadline_date']) {
    if (!(k in body)) continue;
    if (!blank(k) && !S.isValidDate(body[k])) throw new HttpError(400, `${k} must be YYYY-MM-DD or null`);
    out[k] = blank(k) ? null : body[k];
  }
  if ('scheduled_time' in body) {
    if (!blank('scheduled_time') && !(typeof body.scheduled_time === 'string' && S.TIME_RE.test(body.scheduled_time)))
      throw new HttpError(400, 'scheduled_time must be HH:MM or null');
    out.scheduled_time = blank('scheduled_time') ? null : body.scheduled_time;
  }
  if ('warning_days' in body) {
    if (!blank('warning_days') && !(Number.isInteger(body.warning_days) && body.warning_days >= 0 && body.warning_days <= 365))
      throw new HttpError(400, 'warning_days must be an integer 0-365 or null');
    out.warning_days = blank('warning_days') ? null : body.warning_days;
  }
  if ('repeat' in body) {
    if (!blank('repeat') && !S.parseRepeat(body.repeat)) throw new HttpError(400, 'repeat must look like +1w, ++1w or .+1d (units d, w, m, y)');
    out.repeat = blank('repeat') ? null : body.repeat;
  }
  if ('priority' in body) {
    if (!PRIORITIES.includes(body.priority)) throw new HttpError(400, `priority must be one of ${PRIORITIES.join(', ')}`);
    out.priority = body.priority;
  }
  if ('done' in body) {
    if (typeof body.done !== 'boolean') throw new HttpError(400, 'done must be a boolean');
    out.done = body.done;
  }
  return out;
}

const getStmt = db.prepare('SELECT * FROM tasks WHERE id = ?');

// Applies validated fields to a task (existing row or defaults) and handles completion.
// Marking a repeating task done logs a completion and moves its dates forward instead.
function apply(existing, t, today) {
  const now = new Date().toISOString();
  const next = { ...existing, ...t };
  if (next.scheduled_time && !next.scheduled_date) throw new HttpError(400, 'scheduled_time needs a scheduled_date');
  if (next.scheduled_date == null) next.scheduled_time = null;
  if (next.repeat && !next.scheduled_date && !next.deadline_date) throw new HttpError(400, 'a repeating task needs a scheduled_date or deadline_date');

  let completion = null;
  const wasDone = !!existing.done;
  if (next.done && !wasDone) {
    next.completed_at = now;
    completion = { scheduled_date: next.scheduled_date, deadline_date: next.deadline_date };
    if (next.repeat) {
      next.scheduled_date = next.scheduled_date && S.nextRepeat(next.scheduled_date, next.repeat, today);
      next.deadline_date = next.deadline_date && S.nextRepeat(next.deadline_date, next.repeat, today);
      next.repeat_count = (existing.repeat_count || 0) + 1;
      next.done = false;
    }
  } else if (!next.done && wasDone) {
    next.completed_at = null;
  }
  next.done = next.done ? 1 : 0;
  next.updated_at = now;
  return { next, completion };
}

function save(id, next, completion) {
  const cols = [...FIELDS, 'updated_at', 'completed_at', 'repeat_count'];
  db.exec('BEGIN');
  try {
    if (id == null) {
      cols.push('created_at');
      const r = db.prepare(`INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map(k => next[k] ?? (k === 'repeat_count' ? 0 : null)));
      id = Number(r.lastInsertRowid);
    } else {
      db.prepare(`UPDATE tasks SET ${cols.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...cols.map(k => next[k] ?? (k === 'repeat_count' ? 0 : null)), id);
    }
    if (completion) db.prepare('INSERT INTO completions (task_id, done_at, scheduled_date, deadline_date) VALUES (?, ?, ?, ?)')
      .run(id, next.completed_at, completion.scheduled_date, completion.deadline_date);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return toTask(getStmt.get(id));
}

function createTask(body, today) {
  const t = validate(body, false);
  const base = { ...DEFAULTS, done: false, repeat_count: 0, created_at: new Date().toISOString() };
  const { next, completion } = apply(base, t, today);
  return save(null, next, completion);
}

function updateTask(id, body, partial, today) {
  const existing = toTask(getStmt.get(id));
  if (!existing) throw new HttpError(404, 'task not found');
  let t = validate(body, partial);
  if (!partial) t = { ...DEFAULTS, ...t }; // PUT replaces: unspecified fields reset to defaults
  const { next, completion } = apply(existing, t, today);
  return save(id, next, completion);
}

function listTasks(q) {
  const where = [];
  const params = [];
  for (const k of ['from', 'to']) if (q[k] && !S.isValidDate(q[k])) throw new HttpError(400, `${k} must be YYYY-MM-DD`);
  if (q.from || q.to) {
    // A task matches if its scheduled date or its deadline falls in the range
    const range = col => `(${col} IS NOT NULL${q.from ? ` AND ${col} >= ?` : ''}${q.to ? ` AND ${col} <= ?` : ''})`;
    where.push(`(${range('scheduled_date')} OR ${range('deadline_date')})`);
    for (let i = 0; i < 2; i++) { if (q.from) params.push(q.from); if (q.to) params.push(q.to); }
  }
  if (q.done === 'true' || q.done === 'false') { where.push('done = ?'); params.push(q.done === 'true' ? 1 : 0); }
  if (q.undated === 'true' || q.inbox === 'true') where.push('scheduled_date IS NULL AND deadline_date IS NULL');
  if (q.inbox === 'true') where.push('done = 0');
  if (q.repeating === 'true') where.push('repeat IS NOT NULL');
  if (q.q) { where.push('(title LIKE ? OR notes LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`); }
  const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY done, COALESCE(MIN(scheduled_date, deadline_date), scheduled_date, deadline_date) IS NULL,
             COALESCE(MIN(scheduled_date, deadline_date), scheduled_date, deadline_date), scheduled_time IS NULL, scheduled_time,
             CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, id`;
  return db.prepare(sql).all(...params).map(toTask);
}

// ---- Agenda (org-mode style) ----
// For each day in [from, to]:
//  - tasks scheduled that day (including future repeats)
//  - deadlines that day (including future repeats)
//  - on today only: unfinished tasks scheduled in the past ("carried", with days since),
//    and deadlines within their warning period or overdue.
function agenda(from, to, today) {
  if (!S.isValidDate(from) || !S.isValidDate(to)) throw new HttpError(400, 'from and to must be YYYY-MM-DD');
  if (to < from || S.diffDays(from, to) > 366) throw new HttpError(400, 'range must be 0-366 days');
  const days = new Map();
  for (let d = from; d <= to; d = S.addDays(d, 1)) days.set(d, new Map());
  const put = (date, task, entry) => {
    const day = days.get(date);
    if (!day) return;
    const prev = day.get(task.id);
    if (!prev || (entry.kind === 'deadline' && prev.kind !== 'deadline')) day.set(task.id, { ...entry, kind: entry.kind, task });
  };

  for (const task of db.prepare('SELECT * FROM tasks WHERE scheduled_date IS NOT NULL OR deadline_date IS NOT NULL').all().map(toTask)) {
    const { scheduled_date: sd, deadline_date: dd } = task;
    if (sd) {
      put(sd, task, { kind: 'scheduled', carried: false, days: 0 });
      if (!task.done) {
        for (const d of S.occurrences(sd, task.repeat, from, to)) if (d > today) put(d, task, { kind: 'scheduled', carried: false, days: 0, projected: true });
        if (sd < today) put(today, task, { kind: 'scheduled', carried: true, days: S.diffDays(sd, today) });
      }
    }
    if (dd) {
      put(dd, task, { kind: 'deadline', carried: false, days: 0 });
      if (!task.done) {
        for (const d of S.occurrences(dd, task.repeat, from, to)) if (d > today) put(d, task, { kind: 'deadline', carried: false, days: 0, projected: true });
        const until = S.diffDays(today, dd); // positive: due in N days; negative: overdue
        const warn = task.warning_days ?? DEFAULT_WARNING_DAYS;
        if (dd !== today && until <= warn && (sd == null || sd <= today || until < 0))
          put(today, task, { kind: 'deadline', carried: true, days: until });
      }
    }
  }

  const rank = { high: 0, normal: 1, low: 2 };
  const order = e => [
    e.task.done ? 1 : 0,
    e.kind === 'scheduled' && e.task.scheduled_time && !e.carried ? e.task.scheduled_time : '99',
    e.kind === 'deadline' ? (e.carried ? e.days : 0) : 1000 - (e.carried ? e.days : 0),
    rank[e.task.priority], e.task.id];
  const cmp = (a, b) => { const x = order(a), y = order(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };
  return { today, from, to, days: [...days].map(([date, m]) => ({ date, items: [...m.values()].sort(cmp) })) };
}

// ---- iCalendar feed: subscribe from a phone/desktop calendar app ----
function icsEscape(s) { return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function icsDate(d) { return d.replace(/-/g, ''); }
function rrule(repeat) {
  const r = S.parseRepeat(repeat);
  return r && `RRULE:FREQ=${{ d: 'DAILY', w: 'WEEKLY', m: 'MONTHLY', y: 'YEARLY' }[r.unit]};INTERVAL=${r.n}`;
}
function buildIcs() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//tasks//self-hosted//EN', 'X-WR-CALNAME:Tasks', 'CALSCALE:GREGORIAN'];
  const event = (uid, date, time, summary, t) => {
    lines.push('BEGIN:VEVENT', `UID:${uid}@tasks`, `DTSTAMP:${stamp}`);
    if (time) {
      // Floating local time (no TZ), 30 minutes long
      const [h, m] = time.split(':').map(Number);
      const endMin = Math.min(h * 60 + m + 30, 23 * 60 + 59);
      lines.push(`DTSTART:${icsDate(date)}T${time.replace(':', '')}00`, `DTEND:${icsDate(date)}T${String(Math.floor(endMin / 60)).padStart(2, '0')}${String(endMin % 60).padStart(2, '0')}00`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(date)}`, `DTEND;VALUE=DATE:${icsDate(S.addDays(date, 1))}`);
    }
    if (t.repeat) lines.push(rrule(t.repeat));
    lines.push(`SUMMARY:${icsEscape((t.done ? '✓ ' : '') + summary)}`);
    if (t.notes) lines.push(`DESCRIPTION:${icsEscape(t.notes)}`);
    lines.push('END:VEVENT');
  };
  for (const t of db.prepare('SELECT * FROM tasks WHERE scheduled_date IS NOT NULL OR deadline_date IS NOT NULL').all()) {
    if (t.scheduled_date) event(`task-${t.id}`, t.scheduled_date, t.scheduled_time, t.title, t);
    if (t.deadline_date) event(`task-${t.id}-deadline`, t.deadline_date, null, `Deadline: ${t.title}`, t);
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// ---- HTTP plumbing ----
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = body === undefined ? '' : isJson ? JSON.stringify(body) : body;
  res.writeHead(status, { ...(isJson && body !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', c => { data += c; if (data.length > 1e6) { reject(new HttpError(413, 'body too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const data = await readBody(req);
  if (!data) return {};
  try { return JSON.parse(data); } catch { throw new HttpError(400, 'invalid JSON'); }
}

function authorized(req, url) {
  if (!API_TOKEN) return true;
  const header = req.headers.authorization || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : (url.searchParams.get('token') || '');
  const a = Buffer.from(given), b = Buffer.from(API_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'not found' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (pathname === '/api/health') return send(res, 200, { ok: true, auth: !!API_TOKEN });

  if (pathname.startsWith('/api/') || pathname === '/calendar.ics') {
    if (!authorized(req, url)) return send(res, 401, { error: 'unauthorized' });
  }

  if (pathname === '/calendar.ics' && req.method === 'GET')
    return send(res, 200, buildIcs(), { 'Content-Type': 'text/calendar; charset=utf-8' });

  if (pathname === '/api/tasks') {
    if (req.method === 'GET') return send(res, 200, listTasks(Object.fromEntries(url.searchParams)));
    if (req.method === 'POST') return send(res, 201, createTask(await readJson(req), todayFrom(url)));
    return send(res, 405, { error: 'method not allowed' });
  }

  // Quick capture: {"text": "..."} or a text/plain body, parsed with the quick-add syntax
  if (pathname === '/api/capture') {
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    const raw = await readBody(req);
    let text = raw;
    if ((req.headers['content-type'] || '').includes('json')) {
      try { text = JSON.parse(raw).text; } catch { throw new HttpError(400, 'invalid JSON'); }
    }
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'text is required');
    const today = todayFrom(url);
    const parsed = S.parseQuickAdd(text, today);
    if (!parsed.title) parsed.title = text.trim();
    return send(res, 201, createTask(parsed, today));
  }

  if (pathname === '/api/agenda' && req.method === 'GET') {
    const today = todayFrom(url);
    const from = url.searchParams.get('from') || today;
    const to = url.searchParams.get('to') || S.addDays(from, 6);
    return send(res, 200, agenda(from, to, today));
  }

  let m = pathname.match(/^\/api\/tasks\/(\d+)\/completions$/);
  if (m && req.method === 'GET') {
    if (!getStmt.get(Number(m[1]))) return send(res, 404, { error: 'task not found' });
    return send(res, 200, db.prepare('SELECT * FROM completions WHERE task_id = ? ORDER BY done_at DESC').all(Number(m[1])));
  }

  m = pathname.match(/^\/api\/tasks\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    if (req.method === 'GET') {
      const t = toTask(getStmt.get(id));
      return t ? send(res, 200, t) : send(res, 404, { error: 'task not found' });
    }
    if (req.method === 'PATCH') return send(res, 200, updateTask(id, await readJson(req), true, todayFrom(url)));
    if (req.method === 'PUT') return send(res, 200, updateTask(id, await readJson(req), false, todayFrom(url)));
    if (req.method === 'DELETE') {
      const r = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      return r.changes ? send(res, 204) : send(res, 404, { error: 'task not found' });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  if (pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  serveStatic(res, pathname);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error(err);
    send(res, 500, { error: 'internal error' });
  });
});

server.listen(PORT, () => console.log(`tasks listening on :${PORT} (data: ${DATA_DIR}, auth: ${API_TOKEN ? 'token' : 'off'})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
