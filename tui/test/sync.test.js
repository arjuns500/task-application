'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../lib/store.js');
const { Api, sync } = require('../lib/sync.js');
const M = require('../lib/model.js');

const TODAY = '2026-10-30';
let proc, dir, api;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-tui-'));
  const port = 19000 + Math.floor(Math.random() * 1000);
  proc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.js')], {
    env: { ...process.env, PORT: port, DATA_DIR: dir, NODE_NO_WARNINGS: '1', API_TOKEN: '' }, stdio: 'ignore' });
  api = new Api({ server: `http://127.0.0.1:${port}/` });
  for (let i = 0; i < 50; i++) {
    try { await api.req('GET', '/api/health'); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const client = () => new Store(':memory:');
const server = id => api.req('GET', `/api/tasks/${id}`);
const byTitle = (store, title) => store.all().find(t => t.title === title);

test('offline creates get server ids; edits before the first sync are folded in', async () => {
  const s = client();
  let remapped;
  s.onRemap = (a, b) => { remapped = [a, b]; };
  const t = s.create({ title: 'Buy milk', scheduled_date: '2026-11-01', tags: ['home'] });
  assert.ok(t.id < 0);
  s.update(t.id, { priority: 'high' });
  assert.strictEqual(s.ops().length, 1);
  const r = await sync(s, api, TODAY);
  assert.strictEqual(r.pushed, 1);
  const local = byTitle(s, 'Buy milk');
  assert.ok(local.id > 0);
  assert.deepStrictEqual(remapped, [t.id, local.id]);
  const remote = await server(local.id);
  assert.strictEqual(remote.priority, 'high');
  assert.deepStrictEqual(remote.tags, ['home']);
  assert.strictEqual(s.pendingCount(), 0);
});

test('pull brings in other clients\' tasks and removes deleted ones', async () => {
  const s = client();
  const made = await api.req('POST', '/api/tasks', { title: 'From phone' });
  await sync(s, api, TODAY);
  assert.ok(s.get(made.id));
  await api.req('DELETE', `/api/tasks/${made.id}`);
  await sync(s, api, TODAY);
  assert.strictEqual(s.get(made.id), null);
});

test('edits to different fields on both sides merge', async () => {
  const s = client();
  const made = await api.req('POST', '/api/tasks', { title: 'Merge me' });
  await sync(s, api, TODAY);
  s.update(made.id, { notes: 'from laptop' });
  await api.req('PATCH', `/api/tasks/${made.id}`, { priority: 'low' });
  await sync(s, api, TODAY);
  const remote = await server(made.id);
  assert.strictEqual(remote.notes, 'from laptop');
  assert.strictEqual(remote.priority, 'low');
  assert.deepStrictEqual(s.get(made.id), remote);
});

test('same field changed on both sides: the later edit wins and it is logged', async () => {
  const s = client();
  const made = await api.req('POST', '/api/tasks', { title: 'Conflict' });
  await sync(s, api, TODAY);
  s.update(made.id, { title: 'Conflict (laptop, older)' });
  await new Promise(r => setTimeout(r, 5));
  await api.req('PATCH', `/api/tasks/${made.id}`, { title: 'Conflict (phone, newer)' });
  await sync(s, api, TODAY);
  assert.strictEqual((await server(made.id)).title, 'Conflict (phone, newer)');
  assert.match(s.logs(1)[0].message, /kept the server's/);

  await api.req('PATCH', `/api/tasks/${made.id}`, { title: 'Conflict (phone, older)' });
  await new Promise(r => setTimeout(r, 5));
  s.update(made.id, { title: 'Conflict (laptop, newer)' });
  await sync(s, api, TODAY);
  assert.strictEqual((await server(made.id)).title, 'Conflict (laptop, newer)');
  assert.match(s.logs(1)[0].message, /kept yours/);
});

test('completing a repeating task offline advances it, and is not repeated if done elsewhere', async () => {
  const s = client();
  const made = await api.req('POST', '/api/tasks', { title: 'Water plants', scheduled_date: '2026-10-28', repeat: '+1w' });
  await sync(s, api, TODAY);
  s.complete(made.id, TODAY);
  s.complete(made.id, TODAY);
  assert.strictEqual(s.get(made.id).scheduled_date, '2026-11-11');
  // a reschedule after the local completions must not count as a conflict with the server's advance
  s.update(made.id, { scheduled_date: '2026-11-12' });
  await sync(s, api, TODAY);
  let remote = await server(made.id);
  assert.strictEqual(remote.repeat_count, 2);
  assert.strictEqual(remote.scheduled_date, '2026-11-12');

  s.complete(made.id, TODAY);                                              // laptop, offline
  await api.req('PATCH', `/api/tasks/${made.id}?today=${TODAY}`, { done: true }); // phone got there first
  await sync(s, api, TODAY);
  remote = await server(made.id);
  assert.strictEqual(remote.repeat_count, 3);
  assert.match(s.logs(1)[0].message, /already completed elsewhere/);
});

test('deletes: local delete reaches the server; edit to a server-deleted task is dropped', async () => {
  const s = client();
  const a = await api.req('POST', '/api/tasks', { title: 'Delete me' });
  const b = await api.req('POST', '/api/tasks', { title: 'Deleted on phone' });
  await sync(s, api, TODAY);
  s.remove(a.id);
  s.update(b.id, { notes: 'too late' });
  await api.req('DELETE', `/api/tasks/${b.id}`);
  await sync(s, api, TODAY);
  await assert.rejects(server(a.id), { status: 404 });
  assert.strictEqual(s.get(b.id), null);
  assert.match(s.logs(1)[0].message, /deleted on the server/);

  const c = s.create({ title: 'Never sent' });
  s.remove(c.id);
  assert.strictEqual(s.pendingCount(), 0);
});

test('offline: sync fails, nothing is lost, and the next sync sends it', async () => {
  const s = client();
  s.create({ title: 'Written on a plane' });
  await assert.rejects(sync(s, new Api({ server: 'http://127.0.0.1:1', timeout: 500 }), TODAY));
  assert.strictEqual(s.pendingCount(), 1);
  assert.ok(byTitle(s, 'Written on a plane'));
  await sync(s, api, TODAY);
  assert.ok(byTitle(s, 'Written on a plane').id > 0);
});

test('a create whose response was lost is adopted, not duplicated', async () => {
  const s = client();
  const t = s.create({ title: 'Lost response' });
  const op = s.ops()[0];
  s.markSent(op.seq);                                         // we sent it...
  const made = await api.req('POST', '/api/tasks', { title: 'Lost response' }); // ...and the server did make it
  await sync(s, api, TODAY);
  const all = await api.req('GET', '/api/tasks?q=Lost%20response');
  assert.strictEqual(all.length, 1);
  assert.strictEqual(s.get(made.id).title, 'Lost response');
  assert.strictEqual(s.get(t.id), null);
});

test('a change the server rejects is dropped and logged, the rest still syncs', async () => {
  const s = client();
  const made = await api.req('POST', '/api/tasks', { title: 'Valid' });
  await sync(s, api, TODAY);
  s.update(made.id, { scheduled_time: '09:00' }); // no scheduled_date: the server refuses
  s.create({ title: 'Still sent' });
  await sync(s, api, TODAY);
  assert.match(s.logs(5).map(l => l.message).join('\n'), /rejected update of "Valid"/);
  assert.ok(byTitle(s, 'Still sent').id > 0);
  assert.strictEqual(s.get(made.id).scheduled_time, null);
});

test('saved views sync and filter locally', async () => {
  const s = client();
  await api.req('POST', '/api/views', { name: 'Home', filters: { tags: ['home'] } });
  await sync(s, api, TODAY);
  const [v] = s.getMeta('views');
  assert.strictEqual(v.name, 'Home');
  assert.ok(s.all().filter(t => M.matches(t, v.filters)).every(t => t.tags.includes('home')));
});

test('quick-add text round-trips through the edit prompt', () => {
  const t = M.newTask(1, { title: 'Pay rent', scheduled_date: '2026-11-01', scheduled_time: '09:30', deadline_date: '2026-11-05',
    warning_days: 3, repeat: '+1m', priority: 'high', tags: ['bills'] });
  const text = M.toQuickAdd(t);
  assert.strictEqual(text, 'Pay rent @2026-11-01 09:30 ^2026-11-05 -3d +1m !high #bills');
  assert.deepStrictEqual(M.parseEdit(t, text, TODAY), {});
  assert.deepStrictEqual(M.parseEdit(t, 'Pay rent @2026-11-02 #bills', TODAY),
    { scheduled_date: '2026-11-02', scheduled_time: null, deadline_date: null, warning_days: null, repeat: null, priority: 'normal' });
});

test('local agenda matches the server agenda', async () => {
  const s = client();
  await api.req('POST', '/api/tasks', { title: 'Overdue', scheduled_date: '2026-10-20' });
  await api.req('POST', '/api/tasks', { title: 'Soon due', deadline_date: '2026-11-03', warning_days: 7 });
  await api.req('POST', '/api/tasks', { title: 'Weekly', scheduled_date: '2026-10-31', repeat: '+1w', scheduled_time: '08:00' });
  await sync(s, api, TODAY);
  const remote = await api.req('GET', `/api/agenda?today=${TODAY}&from=${TODAY}&to=2026-11-12`);
  const local = M.agenda(s.all(), TODAY, '2026-11-12', TODAY);
  const shape = days => days.map(d => [d.date, d.items.map(e => [e.kind, e.carried, e.days, e.task.id])]);
  assert.deepStrictEqual(shape(local), shape(remote.days));
});
