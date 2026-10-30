'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${PORT}`;
let proc, dir;

async function req(method, p, body, headers = {}) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-'));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, DATA_DIR: dir, NODE_NO_WARNINGS: '1', API_TOKEN: '' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + '/api/health'); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('create, read, update, delete', async () => {
  let r = await req('POST', '/api/tasks', { title: '  Buy milk ', due_date: '2026-11-03', priority: 'high' });
  assert.strictEqual(r.status, 201);
  const t = r.body;
  assert.strictEqual(t.title, 'Buy milk');
  assert.strictEqual(t.done, false);
  assert.strictEqual(t.due_time, null);

  r = await req('GET', `/api/tasks/${t.id}`);
  assert.strictEqual(r.body.priority, 'high');

  r = await req('PATCH', `/api/tasks/${t.id}`, { done: true, due_time: '09:30' });
  assert.strictEqual(r.body.done, true);
  assert.ok(r.body.completed_at);
  assert.strictEqual(r.body.due_time, '09:30');
  assert.strictEqual(r.body.title, 'Buy milk');

  r = await req('PUT', `/api/tasks/${t.id}`, { title: 'Replaced' });
  assert.strictEqual(r.body.due_date, null);
  assert.strictEqual(r.body.done, false);
  assert.strictEqual(r.body.completed_at, null);

  assert.strictEqual((await req('DELETE', `/api/tasks/${t.id}`)).status, 204);
  assert.strictEqual((await req('GET', `/api/tasks/${t.id}`)).status, 404);
});

test('validation', async () => {
  assert.strictEqual((await req('POST', '/api/tasks', {})).status, 400);
  assert.strictEqual((await req('POST', '/api/tasks', { title: 'x', due_date: '11/03/2026' })).status, 400);
  assert.strictEqual((await req('POST', '/api/tasks', { title: 'x', due_time: '25:00' })).status, 400);
  assert.strictEqual((await req('POST', '/api/tasks', { title: 'x', priority: 'urgent' })).status, 400);
  const bad = await fetch(base + '/api/tasks', { method: 'POST', body: '{nope' });
  assert.strictEqual(bad.status, 400);
});

test('filters by date range, status and search', async () => {
  for (const [title, due_date, done] of [['a', '2027-01-01', false], ['b', '2027-01-15', true], ['c', '2027-02-01', false], ['d', null, false]])
    await req('POST', '/api/tasks', { title: `filter-${title}`, due_date, done });
  const titles = async q => (await req('GET', '/api/tasks?' + q)).body.map(t => t.title).filter(t => t.startsWith('filter-'));
  assert.deepStrictEqual(await titles('from=2027-01-01&to=2027-01-31'), ['filter-a', 'filter-b']);
  assert.deepStrictEqual(await titles('done=false&from=2027-01-01'), ['filter-a', 'filter-c']);
  assert.deepStrictEqual(await titles('undated=true'), ['filter-d']);
  assert.deepStrictEqual(await titles('q=filter-c'), ['filter-c']);
});

test('ics feed includes dated tasks', async () => {
  await req('POST', '/api/tasks', { title: 'Dentist, 2nd floor', due_date: '2027-03-04', due_time: '14:00' });
  const r = await req('GET', '/calendar.ics');
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /BEGIN:VCALENDAR/);
  assert.match(r.body, /SUMMARY:Dentist\\, 2nd floor/);
  assert.match(r.body, /DTSTART:20270304T140000/);
  assert.match(r.body, /DTEND:20270304T143000/);
});

test('serves the web UI', async () => {
  const r = await fetch(base + '/');
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /<title>Tasks<\/title>/);
  assert.strictEqual((await fetch(base + '/../server.js')).status, 404);
});
