// Tasks: a small self-hosted task manager with a calendar.
// Zero dependencies: Node's built-in http server and SQLite (node:sqlite).
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const API_TOKEN = process.env.API_TOKEN || ''; // optional; empty = no auth
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'tasks.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT NOT NULL,
    notes        TEXT NOT NULL DEFAULT '',
    due_date     TEXT,              -- YYYY-MM-DD
    due_time     TEXT,              -- HH:MM, optional
    priority     TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
    done         INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
`);

const PRIORITIES = ['low', 'normal', 'high'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function toTask(row) {
  return row && { ...row, done: !!row.done };
}

// Validates a create/update body. `partial` allows missing fields (PATCH).
function validate(body, partial) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be a JSON object');
  const out = {};
  if ('title' in body || !partial) {
    if (typeof body.title !== 'string' || !body.title.trim()) throw new HttpError(400, 'title is required');
    out.title = body.title.trim().slice(0, 500);
  }
  if ('notes' in body) {
    if (body.notes != null && typeof body.notes !== 'string') throw new HttpError(400, 'notes must be a string');
    out.notes = body.notes || '';
  }
  if ('due_date' in body) {
    if (body.due_date != null && body.due_date !== '' && !(typeof body.due_date === 'string' && DATE_RE.test(body.due_date)))
      throw new HttpError(400, 'due_date must be YYYY-MM-DD or null');
    out.due_date = body.due_date || null;
  }
  if ('due_time' in body) {
    if (body.due_time != null && body.due_time !== '' && !(typeof body.due_time === 'string' && TIME_RE.test(body.due_time)))
      throw new HttpError(400, 'due_time must be HH:MM or null');
    out.due_time = body.due_time || null;
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

function listTasks(q) {
  const where = [];
  const params = [];
  if (q.from) { if (!DATE_RE.test(q.from)) throw new HttpError(400, 'from must be YYYY-MM-DD'); where.push('due_date >= ?'); params.push(q.from); }
  if (q.to) { if (!DATE_RE.test(q.to)) throw new HttpError(400, 'to must be YYYY-MM-DD'); where.push('due_date <= ?'); params.push(q.to); }
  if (q.done === 'true' || q.done === 'false') { where.push('done = ?'); params.push(q.done === 'true' ? 1 : 0); }
  if (q.undated === 'true') where.push('due_date IS NULL');
  if (q.q) { where.push('(title LIKE ? OR notes LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`); }
  const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY done, due_date IS NULL, due_date, due_time IS NULL, due_time,
             CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, id`;
  return db.prepare(sql).all(...params).map(toTask);
}

function createTask(body) {
  const t = validate(body, false);
  const now = new Date().toISOString();
  const done = t.done ? 1 : 0;
  const r = db.prepare(`INSERT INTO tasks (title, notes, due_date, due_time, priority, done, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    t.title, t.notes ?? '', t.due_date ?? null, t.due_time ?? null, t.priority ?? 'normal', done, now, now, done ? now : null);
  return toTask(getStmt.get(r.lastInsertRowid));
}

function updateTask(id, body, partial) {
  const existing = getStmt.get(id);
  if (!existing) throw new HttpError(404, 'task not found');
  const t = validate(body, partial);
  if (!partial) { // PUT replaces: unspecified optional fields reset to defaults
    t.notes ??= ''; t.due_date ??= null; t.due_time ??= null; t.priority ??= 'normal'; t.done ??= false;
  }
  const now = new Date().toISOString();
  if ('done' in t) {
    t.completed_at = t.done ? (existing.done ? existing.completed_at : now) : null;
    t.done = t.done ? 1 : 0;
  }
  const keys = Object.keys(t);
  if (keys.length) {
    db.prepare(`UPDATE tasks SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map(k => t[k]), now, id);
  }
  return toTask(getStmt.get(id));
}

// ---- iCalendar feed: subscribe from a phone/desktop calendar app ----
function icsEscape(s) { return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function icsDate(d) { return d.replace(/-/g, ''); }
function nextDay(d) { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); }
function buildIcs() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//tasks//self-hosted//EN', 'X-WR-CALNAME:Tasks', 'CALSCALE:GREGORIAN'];
  for (const t of db.prepare('SELECT * FROM tasks WHERE due_date IS NOT NULL').all()) {
    lines.push('BEGIN:VEVENT', `UID:task-${t.id}@tasks`, `DTSTAMP:${stamp}`);
    if (t.due_time) {
      // Floating local time (no TZ), 30 minutes long
      const start = `${icsDate(t.due_date)}T${t.due_time.replace(':', '')}00`;
      const [h, m] = t.due_time.split(':').map(Number);
      const endMin = Math.min(h * 60 + m + 30, 23 * 60 + 59);
      const end = `${icsDate(t.due_date)}T${String(Math.floor(endMin / 60)).padStart(2, '0')}${String(endMin % 60).padStart(2, '0')}00`;
      lines.push(`DTSTART:${start}`, `DTEND:${end}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(t.due_date)}`, `DTEND;VALUE=DATE:${icsDate(nextDay(t.due_date))}`);
    }
    lines.push(`SUMMARY:${icsEscape((t.done ? '✓ ' : '') + t.title)}`);
    if (t.notes) lines.push(`DESCRIPTION:${icsEscape(t.notes)}`);
    lines.push('END:VEVENT');
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

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', c => { data += c; if (data.length > 1e6) { reject(new HttpError(413, 'body too large')); req.destroy(); } });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new HttpError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
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
    if (req.method === 'POST') return send(res, 201, createTask(await readJson(req)));
    return send(res, 405, { error: 'method not allowed' });
  }

  const m = pathname.match(/^\/api\/tasks\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    if (req.method === 'GET') {
      const t = toTask(getStmt.get(id));
      return t ? send(res, 200, t) : send(res, 404, { error: 'task not found' });
    }
    if (req.method === 'PATCH') return send(res, 200, updateTask(id, await readJson(req), true));
    if (req.method === 'PUT') return send(res, 200, updateTask(id, await readJson(req), false));
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
