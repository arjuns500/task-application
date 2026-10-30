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
        repeat_count   INTEGER NOT NULL DEFAULT 0,
        tags           TEXT NOT NULL DEFAULT '[]' -- JSON array of lowercase strings
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
  if (!db.prepare("SELECT 1 FROM pragma_table_info('tasks') WHERE name = 'tags'").get())
    db.exec("ALTER TABLE tasks ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
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
    CREATE TABLE IF NOT EXISTS views (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      name     TEXT NOT NULL,
      filters  TEXT NOT NULL DEFAULT '{}', -- JSON, see validateFilters
      position INTEGER NOT NULL DEFAULT 0
    );
    PRAGMA user_version = 3;`);
}

const PRIORITIES = ['low', 'normal', 'high'];
const FIELDS = ['title', 'notes', 'scheduled_date', 'scheduled_time', 'deadline_date', 'warning_days', 'repeat', 'priority', 'done', 'tags'];
const DEFAULTS = { notes: '', scheduled_date: null, scheduled_time: null, deadline_date: null, warning_days: null, repeat: null, priority: 'normal', done: false, tags: [] };
const SCOPES = ['all', 'inbox', 'dated'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function toTask(row) {
  return row && { ...row, done: !!row.done, tags: JSON.parse(row.tags || '[]') };
}

// Accepts an array or a space/comma separated string; returns unique normalized tags.
function parseTags(v, field = 'tags') {
  if (v == null || v === '') return [];
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : null;
  if (!list || list.some(t => typeof t !== 'string')) throw new HttpError(400, `${field} must be an array of strings`);
  const out = [...new Set(list.map(S.normalizeTag).filter(Boolean))];
  if (out.length > 30) throw new HttpError(400, `too many ${field}`);
  return out;
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
  if ('tags' in body) out.tags = parseTags(body.tags);
  return out;
}

// ---- Filters (shared by task lists, the agenda and saved views) ----
// tags: match any of them; exclude_tags: match none; priority: any of; q: text; scope: all | inbox | dated
function validateFilters(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw new HttpError(400, 'filters must be an object');
  const out = {};
  if (f.tags != null) out.tags = parseTags(f.tags, 'tags');
  if (f.exclude_tags != null) out.exclude_tags = parseTags(f.exclude_tags, 'exclude_tags');
  if (f.priority != null) {
    const p = Array.isArray(f.priority) ? f.priority : String(f.priority).split(',').filter(Boolean);
    if (p.some(x => !PRIORITIES.includes(x))) throw new HttpError(400, `priority must be any of ${PRIORITIES.join(', ')}`);
    out.priority = [...new Set(p)];
  }
  if (f.q != null && f.q !== '') {
    if (typeof f.q !== 'string') throw new HttpError(400, 'q must be a string');
    out.q = f.q.slice(0, 200);
  }
  if (f.scope != null && f.scope !== 'all') {
    if (!SCOPES.includes(f.scope)) throw new HttpError(400, `scope must be one of ${SCOPES.join(', ')}`);
    out.scope = f.scope;
  }
  for (const k of ['tags', 'exclude_tags', 'priority']) if (out[k] && !out[k].length) delete out[k];
  return out;
}

// Filters from query params: tag=a,b  not_tag=c  priority=high,normal  q=text  scope=inbox  view=<id>
function filtersFromQuery(q) {
  let f = {};
  if (q.view) {
    const v = db.prepare('SELECT filters FROM views WHERE id = ?').get(Number(q.view));
    if (!v) throw new HttpError(404, 'view not found');
    f = JSON.parse(v.filters);
  }
  const extra = validateFilters({ tags: q.tag, exclude_tags: q.not_tag, priority: q.priority, q: q.q, scope: q.scope });
  return { ...f, ...extra };
}

function filterSql(f) {
  const where = [], params = [];
  const inList = a => a.map(() => '?').join(', ');
  if (f.tags) { where.push(`EXISTS (SELECT 1 FROM json_each(tasks.tags) WHERE value IN (${inList(f.tags)}))`); params.push(...f.tags); }
  if (f.exclude_tags) { where.push(`NOT EXISTS (SELECT 1 FROM json_each(tasks.tags) WHERE value IN (${inList(f.exclude_tags)}))`); params.push(...f.exclude_tags); }
  if (f.priority) { where.push(`priority IN (${inList(f.priority)})`); params.push(...f.priority); }
  if (f.q) { where.push('(title LIKE ? OR notes LIKE ?)'); params.push(`%${f.q}%`, `%${f.q}%`); }
  if (f.scope === 'inbox') where.push('scheduled_date IS NULL AND deadline_date IS NULL');
  if (f.scope === 'dated') where.push('(scheduled_date IS NOT NULL OR deadline_date IS NOT NULL)');
  return { where, params };
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

function dbValue(k, v) {
  if (k === 'tags') return JSON.stringify(v || []);
  if (k === 'repeat_count') return v ?? 0;
  return v ?? null;
}

function save(id, next, completion) {
  const cols = [...FIELDS, 'updated_at', 'completed_at', 'repeat_count'];
  db.exec('BEGIN');
  try {
    if (id == null) {
      cols.push('created_at');
      const r = db.prepare(`INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map(k => dbValue(k, next[k])));
      id = Number(r.lastInsertRowid);
    } else {
      db.prepare(`UPDATE tasks SET ${cols.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...cols.map(k => dbValue(k, next[k])), id);
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
  const { where, params } = filterSql(filtersFromQuery(q));
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
function agenda(from, to, today, filters = {}) {
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

  const fw = filterSql(filters);
  const rows = db.prepare(`SELECT * FROM tasks WHERE (scheduled_date IS NOT NULL OR deadline_date IS NOT NULL)${fw.where.map(w => ' AND ' + w).join('')}`).all(...fw.params);
  for (const task of rows.map(toTask)) {
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

// ---- Saved views ----
function toView(row) { return row && { ...row, filters: JSON.parse(row.filters) }; }
function validateView(body, partial) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be a JSON object');
  const out = {};
  if ('name' in body || !partial) {
    if (typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, 'name is required');
    out.name = body.name.trim().slice(0, 60);
  }
  if ('filters' in body || !partial) out.filters = validateFilters(body.filters ?? {});
  if ('position' in body) {
    if (!Number.isInteger(body.position)) throw new HttpError(400, 'position must be an integer');
    out.position = body.position;
  }
  return out;
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
    return send(res, 200, agenda(from, to, today, filtersFromQuery(Object.fromEntries(url.searchParams))));
  }

  if (pathname === '/api/tags' && req.method === 'GET')
    return send(res, 200, db.prepare(`SELECT value AS tag, COUNT(*) AS count, SUM(done = 0) AS open
      FROM tasks, json_each(tasks.tags) GROUP BY value ORDER BY open DESC, value`).all());

  if (pathname === '/api/views') {
    if (req.method === 'GET') return send(res, 200, db.prepare('SELECT * FROM views ORDER BY position, id').all().map(toView));
    if (req.method === 'POST') {
      const v = validateView(await readJson(req), false);
      const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM views').get().p;
      const r = db.prepare('INSERT INTO views (name, filters, position) VALUES (?, ?, ?)').run(v.name, JSON.stringify(v.filters || {}), v.position ?? pos);
      return send(res, 201, toView(db.prepare('SELECT * FROM views WHERE id = ?').get(r.lastInsertRowid)));
    }
    return send(res, 405, { error: 'method not allowed' });
  }
  const vm = pathname.match(/^\/api\/views\/(\d+)$/);
  if (vm) {
    const id = Number(vm[1]);
    const existing = db.prepare('SELECT * FROM views WHERE id = ?').get(id);
    if (!existing) return send(res, 404, { error: 'view not found' });
    if (req.method === 'GET') return send(res, 200, toView(existing));
    if (req.method === 'PATCH' || req.method === 'PUT') {
      const v = { ...toView(existing), ...validateView(await readJson(req), req.method === 'PATCH') };
      db.prepare('UPDATE views SET name = ?, filters = ?, position = ? WHERE id = ?').run(v.name, JSON.stringify(v.filters), v.position, id);
      return send(res, 200, toView(db.prepare('SELECT * FROM views WHERE id = ?').get(id)));
    }
    if (req.method === 'DELETE') { db.prepare('DELETE FROM views WHERE id = ?').run(id); return send(res, 204); }
    return send(res, 405, { error: 'method not allowed' });
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
