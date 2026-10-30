'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const base = port => `http://127.0.0.1:${port}`;
let PORT, proc, dir;

function start(dataDir, port) {
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: port, DATA_DIR: dataDir, NODE_NO_WARNINGS: '1', API_TOKEN: '' }, stdio: 'ignore' });
  return (async () => {
    for (let i = 0; i < 50; i++) {
      try { await fetch(base(port) + '/api/health'); return p; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    throw new Error('server did not start');
  })();
}

async function req(method, p, body, headers = {}) {
  const res = await fetch(base(PORT) + p, { method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-'));
  PORT = 18000 + Math.floor(Math.random() * 1000);
  proc = await start(dir, PORT);
});
after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('create, read, update, delete', async () => {
  let r = await req('POST', '/api/tasks', { title: '  Buy milk ', scheduled_date: '2026-11-03', priority: 'high' });
  assert.strictEqual(r.status, 201);
  const t = r.body;
  assert.strictEqual(t.title, 'Buy milk');
  assert.strictEqual(t.done, false);
  assert.strictEqual(t.scheduled_time, null);

  r = await req('GET', `/api/tasks/${t.id}`);
  assert.strictEqual(r.body.priority, 'high');

  r = await req('PATCH', `/api/tasks/${t.id}`, { done: true, scheduled_time: '09:30' });
  assert.strictEqual(r.body.done, true);
  assert.ok(r.body.completed_at);
  assert.strictEqual(r.body.scheduled_time, '09:30');

  r = await req('PUT', `/api/tasks/${t.id}`, { title: 'Replaced' });
  assert.strictEqual(r.body.scheduled_date, null);
  assert.strictEqual(r.body.done, false);
  assert.strictEqual(r.body.completed_at, null);

  assert.strictEqual((await req('DELETE', `/api/tasks/${t.id}`)).status, 204);
  assert.strictEqual((await req('GET', `/api/tasks/${t.id}`)).status, 404);
});

test('validation', async () => {
  const bad = async body => (await req('POST', '/api/tasks', body)).status;
  assert.strictEqual(await bad({}), 400);
  assert.strictEqual(await bad({ title: 'x', scheduled_date: '11/03/2026' }), 400);
  assert.strictEqual(await bad({ title: 'x', deadline_date: '2026-02-30' }), 400);
  assert.strictEqual(await bad({ title: 'x', scheduled_date: '2026-11-01', scheduled_time: '25:00' }), 400);
  assert.strictEqual(await bad({ title: 'x', priority: 'urgent' }), 400);
  assert.strictEqual(await bad({ title: 'x', repeat: 'weekly', scheduled_date: '2026-11-01' }), 400);
  assert.strictEqual(await bad({ title: 'x', repeat: '+1w' }), 400); // repeat needs a date
  assert.strictEqual(await bad({ title: 'x', warning_days: -1 }), 400);
  assert.strictEqual((await req('POST', '/api/tasks', '{nope')).status, 400);
});

test('completing a repeating task moves it forward and logs it', async () => {
  const today = '2026-10-30';
  let r = await req('POST', '/api/tasks', { title: 'Water plants', scheduled_date: '2026-10-20', deadline_date: '2026-10-22', repeat: '++1w' });
  const id = r.body.id;
  r = await req('PATCH', `/api/tasks/${id}?today=${today}`, { done: true });
  assert.strictEqual(r.body.done, false);
  assert.strictEqual(r.body.scheduled_date, '2026-11-03');
  assert.strictEqual(r.body.deadline_date, '2026-11-05');
  assert.strictEqual(r.body.repeat_count, 1);
  assert.ok(r.body.completed_at);

  r = await req('POST', '/api/tasks', { title: 'Haircut', scheduled_date: '2026-10-01', repeat: '.+4w' });
  r = await req('PATCH', `/api/tasks/${r.body.id}?today=${today}`, { done: true });
  assert.strictEqual(r.body.scheduled_date, '2026-11-27');

  r = await req('GET', `/api/tasks/${id}/completions`);
  assert.strictEqual(r.body.length, 1);
  assert.strictEqual(r.body[0].scheduled_date, '2026-10-20');
});

test('agenda: carry-over, deadline warnings and projected repeats', async () => {
  const mk = async b => (await req('POST', '/api/tasks', { ...b, title: 'ag-' + b.title })).body;
  await mk({ title: 'late', scheduled_date: '2027-03-07' });
  await mk({ title: 'warn', deadline_date: '2027-03-15', warning_days: 7 });
  await mk({ title: 'farwarn', deadline_date: '2027-03-30' }); // default 14 days: not yet
  await mk({ title: 'overdue', deadline_date: '2027-03-09' });
  await mk({ title: 'daily', scheduled_date: '2027-03-10', scheduled_time: '08:00', repeat: '+1d' });
  await mk({ title: 'notyet', scheduled_date: '2027-03-12', deadline_date: '2027-03-13' }); // scheduled in future hides prewarning
  const r = await req('GET', '/api/agenda?today=2027-03-10&from=2027-03-10&to=2027-03-12');
  assert.strictEqual(r.status, 200);
  const day = i => r.body.days[i].items.filter(e => e.task.title.startsWith('ag-')).map(e => `${e.task.title.slice(3)}:${e.kind[0]}${e.carried ? e.days : ''}`);
  assert.deepStrictEqual(day(0), ['daily:s', 'overdue:d-1', 'warn:d5', 'late:s3']);
  assert.deepStrictEqual(day(1), ['daily:s']);
  assert.deepStrictEqual(day(2), ['daily:s', 'notyet:s']);
});

test('quick capture endpoint', async () => {
  let r = await req('POST', '/api/capture?today=2026-10-30', { text: 'Call dentist @mon 10am !high' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.title, 'Call dentist');
  assert.strictEqual(r.body.scheduled_date, '2026-11-02');
  assert.strictEqual(r.body.scheduled_time, '10:00');
  r = await req('POST', '/api/capture', 'Buy stamps', { 'Content-Type': 'text/plain' });
  assert.strictEqual(r.body.title, 'Buy stamps');
  assert.strictEqual(r.body.scheduled_date, null);
  r = await req('GET', '/api/tasks?inbox=true');
  assert.ok(r.body.some(t => t.title === 'Buy stamps'));
});

test('ics feed includes scheduled, deadlines and repeats', async () => {
  await req('POST', '/api/tasks', { title: 'Dentist, 2nd floor', scheduled_date: '2027-03-04', scheduled_time: '14:00', deadline_date: '2027-03-05', repeat: '+1m' });
  const r = await req('GET', '/calendar.ics');
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /SUMMARY:Dentist\\, 2nd floor/);
  assert.match(r.body, /DTSTART:20270304T140000/);
  assert.match(r.body, /DTEND:20270304T143000/);
  assert.match(r.body, /SUMMARY:Deadline: Dentist/);
  assert.match(r.body, /RRULE:FREQ=MONTHLY;INTERVAL=1/);
});

test('serves the web UI', async () => {
  const r = await fetch(base(PORT) + '/');
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /<title>Tasks<\/title>/);
});

test('migrates a v1 database', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-v1-'));
  const old = new DatabaseSync(path.join(d, 'tasks.db'));
  old.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
    due_date TEXT, due_time TEXT, priority TEXT NOT NULL DEFAULT 'normal', done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT);
    CREATE INDEX idx_tasks_due ON tasks(due_date);
    INSERT INTO tasks (title, due_date, due_time, created_at, updated_at) VALUES ('old', '2026-11-01', '09:00', 'x', 'x');`);
  old.close();
  const port = PORT + 1000;
  const p = await start(d, port);
  try {
    const t = (await (await fetch(base(port) + '/api/tasks/1')).json());
    assert.strictEqual(t.scheduled_date, '2026-11-01');
    assert.strictEqual(t.scheduled_time, '09:00');
    assert.ok(!('due_date' in t));
  } finally { p.kill(); fs.rmSync(d, { recursive: true, force: true }); }
});
