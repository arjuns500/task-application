// Talks to the server's REST API and reconciles it with the local store.
//
// One sync = pull every task, push the outbox against that snapshot, then make the snapshot the local copy.
// Conflicts are resolved per field: if only one side changed a field, that side wins; if both did,
// the later edit wins (local edit time vs the server's updated_at). Every conflict is written to the log.
'use strict';
const { EventEmitter } = require('node:events');
const S = require('../../public/shared.js');
const M = require('./model.js');

class Api {
  constructor({ server, token, timeout = 10000 }) {
    this.base = String(server).replace(/\/+$/, '');
    this.token = token;
    this.timeout = timeout;
  }
  async req(method, p, body) {
    const headers = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(this.base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout) });
    const text = await res.text();
    const data = text && (res.headers.get('content-type') || '').includes('json') ? JSON.parse(text) : text;
    if (!res.ok) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status });
    return data;
  }
}

// Errors that mean "try the whole sync again later" rather than "this one change is bad".
const retryable = e => !e.status || e.status === 401 || e.status === 408 || e.status === 429 || e.status >= 500;
const show = v => v == null || v === '' ? '(empty)' : Array.isArray(v) ? (v.length ? v.map(x => '#' + x).join(' ') : '(none)') : String(v);

async function sync(store, api, today = S.localToday()) {
  const [list, views] = await Promise.all([api.req('GET', '/api/tasks'), api.req('GET', '/api/views').catch(() => null)]);
  const snap = new Map(list.map(t => [t.id, t]));
  const known = new Set(store.all().map(t => t.id).filter(id => id > 0));
  const q = `?today=${today}`;
  let pushed = 0;

  const handlers = {
    async create(op) {
      const fields = op.payload.fields;
      // A previous attempt may have reached the server and lost the response: adopt that task instead of making a twin.
      if (op.sent_at) {
        const since = new Date(Date.parse(op.sent_at) - 10 * 60e3).toISOString();
        const twin = [...snap.values()].find(t => !known.has(t.id) && t.title === String(fields.title).trim() && t.created_at >= since);
        if (twin) { known.add(twin.id); store.remap(op.task_id, twin.id); return; }
      }
      store.markSent(op.seq);
      const t = await api.req('POST', '/api/tasks' + q, fields);
      snap.set(t.id, t); known.add(t.id);
      store.remap(op.task_id, t.id);
    },
    async update(op) {
      const s = snap.get(op.task_id);
      const title = s?.title ?? store.get(op.task_id)?.title;
      if (!s) return store.log(`"${title}" was deleted on the server, so your edit to it was dropped`);
      const send = {};
      for (const [k, mine] of Object.entries(op.payload.fields)) {
        const theirs = s[k], base = op.payload.base[k];
        if (M.same(theirs, mine)) continue;
        if (M.same(theirs, base)) { send[k] = mine; continue; }
        const keepMine = op.at >= s.updated_at;
        if (keepMine) send[k] = mine;
        store.log(`Conflict on "${title}" ${k}: kept ${keepMine ? 'yours' : "the server's"} (${show(keepMine ? mine : theirs)}) over ${keepMine ? "the server's" : 'yours'} (${show(keepMine ? theirs : mine)})`);
      }
      if (Object.keys(send).length) snap.set(op.task_id, await api.req('PATCH', `/api/tasks/${op.task_id}${q}`, send));
    },
    async complete(op) {
      const s = snap.get(op.task_id);
      if (!s) return store.log(`Task ${op.task_id} was deleted on the server before your "done" was sent`);
      if (s.done || (s.repeat_count || 0) !== op.payload.repeat_count)
        return store.log(`"${s.title}" was already completed elsewhere; skipped completing it again`);
      snap.set(op.task_id, await api.req('PATCH', `/api/tasks/${op.task_id}${q}`, { done: true }));
    },
    async delete(op) {
      if (!snap.has(op.task_id)) return;
      await api.req('DELETE', `/api/tasks/${op.task_id}`);
      snap.delete(op.task_id);
    },
  };

  for (;;) {
    const op = store.ops().find(o => o.task_id > 0 || o.kind === 'create');
    if (!op) break;
    store.claim(op.seq);
    try {
      await handlers[op.kind](op);
    } catch (e) {
      if (retryable(e)) { store.release(op.seq); throw e; }
      const title = op.payload.fields?.title ?? store.get(op.task_id)?.title ?? `task ${op.task_id}`;
      store.log(`Server rejected ${op.kind} of "${title}": ${e.message}. The change was dropped.`);
      if (op.kind === 'create') store.dropTask(op.task_id); // later edits to it can't be sent either
    }
    store.drop(op.seq);
    pushed++;
  }

  store.replaceAll([...snap.values()]);
  if (views) store.setMeta('views', views);
  store.setMeta('last_sync', new Date().toISOString());
  return { pushed, tasks: snap.size };
}

// Runs sync() in the background: on start, every `interval`, and shortly after local edits.
class SyncEngine extends EventEmitter {
  constructor(store, api, { interval = 60e3 } = {}) {
    super();
    this.store = store; this.api = api; this.interval = interval;
    this.state = api ? 'idle' : 'local';
    this.error = null; this.running = null; this.again = false;
  }
  start() { if (this.api) { this.run(); this.timer = setInterval(() => this.run(), this.interval); } }
  stop() { clearInterval(this.timer); clearTimeout(this.debounce); }
  soon(ms = 1500) { if (!this.api) return; clearTimeout(this.debounce); this.debounce = setTimeout(() => this.run(), ms); }
  run() {
    if (!this.api) return Promise.resolve();
    if (this.running) { this.again = true; return this.running; }
    this.state = 'syncing'; this.emit('change');
    this.running = (async () => {
      try {
        do { this.again = false; await sync(this.store, this.api); } while (this.again);
        this.state = 'ok'; this.error = null;
      } catch (e) {
        this.state = e.status === 401 ? 'auth' : 'offline';
        this.error = e.status ? e.message : (e.cause?.code || e.name === 'TimeoutError' ? (e.cause?.code || 'timeout') : e.message);
      } finally {
        this.running = null; this.emit('change');
      }
    })();
    return this.running;
  }
}

module.exports = { Api, sync, SyncEngine };
