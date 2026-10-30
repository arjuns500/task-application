// Pure task logic for the TUI: local edits, sorting, view filters and the agenda.
// Mirrors server.js so the client shows the same thing offline.
'use strict';
const S = require('../../public/shared.js');

const EDITABLE = ['title', 'notes', 'scheduled_date', 'scheduled_time', 'deadline_date', 'warning_days', 'repeat', 'priority', 'tags', 'done'];
const DEFAULTS = { notes: '', scheduled_date: null, scheduled_time: null, deadline_date: null, warning_days: null, repeat: null,
  priority: 'normal', tags: [], done: false, repeat_count: 0, completed_at: null };
const RANK = { high: 0, normal: 1, low: 2 };

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function newTask(id, fields) {
  const now = new Date().toISOString();
  return applyFields({ ...DEFAULTS, id, title: '', created_at: now, updated_at: now }, fields);
}

// Like the server's apply(), minus completion (see complete()).
function applyFields(task, fields) {
  const next = { ...task, ...fields, updated_at: new Date().toISOString() };
  if (next.scheduled_date == null) next.scheduled_time = null;
  if ('done' in fields && !fields.done) next.completed_at = null;
  return next;
}

// Marking done: a repeating task moves to its next occurrence instead (same rule as the server).
function complete(task, today) {
  const now = new Date().toISOString();
  if (!task.repeat) return { ...task, done: true, completed_at: now, updated_at: now };
  return { ...task, completed_at: now, updated_at: now, repeat_count: (task.repeat_count || 0) + 1,
    scheduled_date: task.scheduled_date && S.nextRepeat(task.scheduled_date, task.repeat, today),
    deadline_date: task.deadline_date && S.nextRepeat(task.deadline_date, task.repeat, today) };
}

// Task -> quick-add text, so one prompt edits every field. parseEdit() is the inverse.
function toQuickAdd(t) {
  const parts = [t.title];
  if (t.scheduled_date) parts.push('@' + t.scheduled_date);
  if (t.scheduled_time) parts.push(t.scheduled_time);
  if (t.deadline_date) parts.push('^' + t.deadline_date);
  if (t.warning_days != null) parts.push(`-${t.warning_days}d`);
  if (t.repeat) parts.push(t.repeat);
  if (t.priority !== 'normal') parts.push('!' + t.priority);
  for (const tag of t.tags || []) parts.push('#' + tag);
  return parts.join(' ');
}

// Returns only the fields that changed (title kept if the text was all tokens).
function parseEdit(task, text, today) {
  const p = S.parseQuickAdd(text, today);
  const want = { title: p.title || task.title, scheduled_date: p.scheduled_date ?? null, scheduled_time: p.scheduled_time ?? null,
    deadline_date: p.deadline_date ?? null, warning_days: p.warning_days ?? null, repeat: p.repeat ?? null,
    priority: p.priority ?? 'normal', tags: p.tags ?? [] };
  const out = {};
  for (const [k, v] of Object.entries(want)) if (!same(task[k], v)) out[k] = v;
  return out;
}

// Same order as the server's task list: open first, then by earliest date, time, priority.
function sortTasks(tasks) {
  const key = t => {
    const d = [t.scheduled_date, t.deadline_date].filter(Boolean).sort()[0];
    return [t.done ? 1 : 0, d ? 0 : 1, d || '', t.scheduled_time ? 0 : 1, t.scheduled_time || '', RANK[t.priority] ?? 1, t.id < 0 ? 1e12 - t.id : t.id];
  };
  return tasks.map(t => [key(t), t]).sort(([a], [b]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
  }).map(([, t]) => t);
}

// Saved-view filters, evaluated locally (same meaning as the server's filterSql).
function matches(t, f = {}) {
  const tags = t.tags || [];
  if (f.tags?.length && !f.tags.some(x => tags.includes(x))) return false;
  if (f.exclude_tags?.length && f.exclude_tags.some(x => tags.includes(x))) return false;
  if (f.priority?.length && !f.priority.includes(t.priority)) return false;
  if (f.q) { const q = f.q.toLowerCase(); if (!t.title.toLowerCase().includes(q) && !(t.notes || '').toLowerCase().includes(q)) return false; }
  const dated = !!(t.scheduled_date || t.deadline_date);
  if (f.scope === 'inbox' && dated) return false;
  if (f.scope === 'dated' && !dated) return false;
  return true;
}

// Org-style agenda, the same code the server's /api/agenda runs.
const agenda = S.agenda;

module.exports = { EDITABLE, DEFAULTS, same, newTask, applyFields, complete, toQuickAdd, parseEdit, sortTasks, matches, agenda };
