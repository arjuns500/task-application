// Local copy of the tasks plus an outbox of changes not yet sent to the server.
// Tasks created offline get negative ids until the server assigns a real one.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const M = require('./model.js');

class Store {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks  (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (
        seq      INTEGER PRIMARY KEY AUTOINCREMENT,
        kind     TEXT NOT NULL,              -- create | update | complete | delete
        task_id  INTEGER NOT NULL,
        payload  TEXT NOT NULL,              -- JSON, see the methods below
        at       TEXT NOT NULL,              -- time of the latest local edit folded into this op
        sent_at  TEXT,                       -- create only: when a POST was first attempted
        inflight INTEGER NOT NULL DEFAULT 0  -- being sent right now; don't merge more edits into it
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS log  (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, message TEXT NOT NULL);
      UPDATE outbox SET inflight = 0;`);
    this.onRemap = null; // (oldId, newId) => void
  }

  // ---- reads ----
  all() { return this.db.prepare('SELECT data FROM tasks').all().map(r => JSON.parse(r.data)); }
  get(id) { const r = this.db.prepare('SELECT data FROM tasks WHERE id = ?').get(id); return r ? JSON.parse(r.data) : null; }
  ops() { return this.db.prepare('SELECT * FROM outbox ORDER BY seq').all().map(o => ({ ...o, payload: JSON.parse(o.payload) })); }
  pendingIds() { return new Set(this.db.prepare('SELECT DISTINCT task_id FROM outbox').all().map(r => r.task_id)); }
  pendingCount() { return this.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n; }
  getMeta(k, dflt = null) { const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(k); return r ? JSON.parse(r.value) : dflt; }
  logs(n = 100) { return this.db.prepare('SELECT * FROM log ORDER BY id DESC LIMIT ?').all(n); }

  // ---- low-level writes ----
  setMeta(k, v) { this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(k, JSON.stringify(v)); }
  log(message) { this.db.prepare('INSERT INTO log (at, message) VALUES (?, ?)').run(new Date().toISOString(), message); }
  put(t) { this.db.prepare('INSERT OR REPLACE INTO tasks (id, data) VALUES (?, ?)').run(t.id, JSON.stringify(t)); }
  tx(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  lastOp(id) {
    const o = this.db.prepare('SELECT * FROM outbox WHERE task_id = ? ORDER BY seq DESC LIMIT 1').get(id);
    return o && { ...o, payload: JSON.parse(o.payload) };
  }
  enqueue(kind, id, payload) {
    this.db.prepare('INSERT INTO outbox (kind, task_id, payload, at) VALUES (?, ?, ?, ?)').run(kind, id, JSON.stringify(payload), new Date().toISOString());
  }
  rewriteOp(seq, payload) {
    this.db.prepare('UPDATE outbox SET payload = ?, at = ? WHERE seq = ?').run(JSON.stringify(payload), new Date().toISOString(), seq);
  }

  // ---- local edits (each updates the local copy and queues the change) ----
  create(fields) {
    return this.tx(() => {
      const id = Math.min(0, this.getMeta('min_local_id', 0)) - 1;
      this.setMeta('min_local_id', id);
      const t = M.newTask(id, fields);
      this.put(t);
      this.enqueue('create', id, { fields });
      return t;
    });
  }

  // Each update op remembers the value every field had before the first local edit ("base"),
  // so the sync can tell "server changed it too" (a conflict) from "only I changed it".
  update(id, fields) {
    return this.tx(() => {
      const t = this.get(id);
      if (!t) return null;
      const changed = Object.fromEntries(Object.entries(fields).filter(([k, v]) => !M.same(t[k], v)));
      if (!Object.keys(changed).length) return t;
      const next = M.applyFields(t, changed);
      this.put(next);
      const last = this.lastOp(id);
      if (last && !last.inflight && last.kind === 'create') {
        this.rewriteOp(last.seq, { fields: { ...last.payload.fields, ...changed } });
      } else if (last && !last.inflight && last.kind === 'update') {
        const base = { ...last.payload.base };
        for (const k of Object.keys(changed)) if (!(k in base)) base[k] = t[k] ?? null;
        this.rewriteOp(last.seq, { fields: { ...last.payload.fields, ...changed }, base });
      } else {
        this.enqueue('update', id, { fields: changed, base: Object.fromEntries(Object.keys(changed).map(k => [k, t[k] ?? null])) });
      }
      return next;
    });
  }

  // Completing is not idempotent for repeating tasks (each one advances the dates), so it is its own op,
  // guarded by the repeat_count it was made against.
  complete(id, today) {
    const t = this.get(id);
    if (!t) return null;
    if (t.done) return this.update(id, { done: false });
    const next = M.complete(t, today);
    return this.tx(() => {
      this.put(next);
      const last = this.lastOp(id);
      if (last && !last.inflight && last.kind === 'create') {
        const f = { ...last.payload.fields };
        for (const k of ['scheduled_date', 'deadline_date', 'done']) if (next[k] != null || k in f) f[k] = next[k];
        this.rewriteOp(last.seq, { fields: f });
      } else {
        this.enqueue('complete', id, { repeat_count: t.repeat_count || 0 });
      }
      return next;
    });
  }

  remove(id) {
    return this.tx(() => {
      const t = this.get(id);
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      const first = this.db.prepare('SELECT kind, inflight FROM outbox WHERE task_id = ? ORDER BY seq LIMIT 1').get(id);
      if (first?.kind === 'create' && !first.inflight) { // never reached the server: just forget it
        this.db.prepare('DELETE FROM outbox WHERE task_id = ?').run(id);
        return t;
      }
      this.db.prepare('DELETE FROM outbox WHERE task_id = ? AND inflight = 0').run(id);
      this.enqueue('delete', id, { title: t?.title });
      return t;
    });
  }

  // ---- used by the sync ----
  claim(seq) { this.db.prepare('UPDATE outbox SET inflight = 1 WHERE seq = ?').run(seq); }
  release(seq) { this.db.prepare('UPDATE outbox SET inflight = 0 WHERE seq = ?').run(seq); }
  markSent(seq) { this.db.prepare('UPDATE outbox SET sent_at = ? WHERE seq = ?').run(new Date().toISOString(), seq); }
  drop(seq) { this.db.prepare('DELETE FROM outbox WHERE seq = ?').run(seq); }
  dropTask(id) { this.db.prepare('DELETE FROM outbox WHERE task_id = ?').run(id); }

  remap(oldId, newId) {
    this.tx(() => {
      const t = this.get(oldId);
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(oldId);
      if (t) this.put({ ...t, id: newId });
      this.db.prepare('UPDATE outbox SET task_id = ? WHERE task_id = ?').run(newId, oldId);
    });
    this.onRemap?.(oldId, newId);
  }

  // Replace the local copy with the server's, except tasks that still have unsent changes.
  replaceAll(serverTasks) {
    this.tx(() => {
      const pending = this.pendingIds();
      for (const { id } of this.db.prepare('SELECT id FROM tasks').all()) if (!pending.has(id)) this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      for (const t of serverTasks) if (!pending.has(t.id)) this.put(t);
    });
  }

  close() { this.db.close(); }
}

module.exports = { Store };
