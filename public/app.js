'use strict';
const $ = s => document.querySelector(s);
const S = window.Shared;
const today = () => S.localToday();
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const now = new Date();
const state = { tasks: [], agenda: null, cal: null, view: 'agenda', month: new Date(now.getFullYear(), now.getMonth(), 1),
                selected: today(), editing: null, query: '' };

// ---- API ----
function token() { try { return localStorage.getItem('token') || ''; } catch { return ''; } }
async function api(method, path, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token()) headers.Authorization = 'Bearer ' + token();
  // The server computes "today" (agenda, repeats) from the browser's date, not its own time zone
  path += (path.includes('?') ? '&' : '?') + 'today=' + today();
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) {
    const t = prompt('API token required:');
    if (t != null) { try { localStorage.setItem('token', t); } catch {} return api(method, path, body); }
    throw new Error('unauthorized');
  }
  if (!res.ok) { const e = await res.json().catch(() => ({})); alert(e.error || res.statusText); throw new Error(e.error); }
  return res.status === 204 ? null : res.json();
}

function calRange() {
  const m = state.month;
  const start = new Date(m.getFullYear(), m.getMonth(), 1);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // weeks start on Monday
  const end = new Date(m.getFullYear(), m.getMonth() + 1, 0);
  end.setDate(end.getDate() + ((7 - end.getDay()) % 7));
  return [S.localToday(start), S.localToday(end)];
}

async function load() {
  const t = today();
  const [from, to] = calRange();
  const [tasks, agenda, cal] = await Promise.all([
    api('GET', '/api/tasks'),
    api('GET', `/api/agenda?from=${t}&to=${S.addDays(t, 6)}`),
    state.view === 'calendar' ? api('GET', `/api/agenda?from=${from}&to=${to}`) : null,
  ]);
  Object.assign(state, { tasks, agenda, cal });
  render();
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

// ---- Formatting ----
function fmtDate(s) {
  const t = today();
  if (s === t) return 'Today';
  if (s === S.addDays(t, 1)) return 'Tomorrow';
  if (s === S.addDays(t, -1)) return 'Yesterday';
  const d = parseYmd(s);
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}
function fmtTime(t) {
  const [h, m] = t.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// Tags describing a task. `entry` is an agenda entry when rendered in the agenda.
function tags(t, entry) {
  const out = [];
  const tag = (text, cls = '') => out.push(`<span class="tag ${cls}">${esc(text)}</span>`);
  if (entry) {
    if (entry.kind === 'scheduled' && t.scheduled_time && !entry.carried) tag(fmtTime(t.scheduled_time));
    if (entry.kind === 'scheduled' && entry.carried) tag(`Scheduled ${plural(entry.days, 'day')} ago`, 'late');
    if (entry.kind === 'deadline' && !entry.carried) tag('Deadline', 'deadline');
    if (entry.kind === 'deadline' && entry.carried) tag(entry.days < 0 ? `Overdue ${plural(-entry.days, 'day')}` : `Due in ${plural(entry.days, 'day')}`, 'deadline');
    if (entry.kind === 'scheduled' && t.deadline_date && t.deadline_date !== entry.date) tag(`Due ${fmtDate(t.deadline_date)}`);
  } else {
    const t0 = today();
    if (t.scheduled_date) tag(`${fmtDate(t.scheduled_date)}${t.scheduled_time ? ' ' + fmtTime(t.scheduled_time) : ''}`, !t.done && t.scheduled_date < t0 ? 'late' : '');
    if (t.deadline_date) tag(`Due ${fmtDate(t.deadline_date)}`, !t.done && t.deadline_date <= S.addDays(t0, t.warning_days ?? 14) ? 'deadline' : '');
  }
  if (t.repeat) tag('↻ ' + S.describeRepeat(t.repeat));
  if (t.notes) out.push('<span>📝</span>');
  return out;
}

function taskRow(t, entry) {
  const meta = tags(t, entry);
  return `<div class="task ${t.done ? 'done' : ''}" data-id="${t.id}">
    <input type="checkbox" ${t.done ? 'checked' : ''} aria-label="Mark done">
    <div class="body"><div class="title">${esc(t.title)}</div>${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}</div>
    <span class="prio ${t.priority}" title="${t.priority} priority"></span>
  </div>`;
}
const card = rows => `<div class="card">${rows.join('')}</div>`;

// ---- Views ----
function renderAgenda() {
  const a = state.agenda;
  if (!a) return;
  let html = '';
  for (const day of a.days) {
    const isToday = day.date === a.today;
    const label = isToday ? 'Today' : day.date === S.addDays(a.today, 1) ? 'Tomorrow' : parseYmd(day.date).toLocaleDateString(undefined, { weekday: 'long' });
    const sub = parseYmd(day.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    html += `<div class="agenda-day ${isToday ? 'today' : ''}"><h2>${esc(label)} <small>${esc(sub)}</small></h2>
      ${day.items.length ? card(day.items.map(e => taskRow(e.task, { ...e, date: day.date }))) : `<p class="none">Nothing scheduled.</p>`}</div>`;
  }
  const inbox = state.tasks.filter(t => !t.done && !t.scheduled_date && !t.deadline_date);
  if (inbox.length) html += `<div class="agenda-day"><h2>Inbox <small>${plural(inbox.length, 'unscheduled task')}</small></h2>${card(inbox.map(t => taskRow(t)))}</div>`;
  $('#agenda').innerHTML = html;
}

function renderList() {
  const q = state.query.toLowerCase();
  const tasks = state.tasks.filter(t => !q || t.title.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q));
  const groups = [
    ['Inbox', t => !t.done && !t.scheduled_date && !t.deadline_date],
    ['Scheduled', t => !t.done && (t.scheduled_date || t.deadline_date)],
  ];
  let html = '';
  for (const [name, fn] of groups) {
    const items = tasks.filter(fn);
    if (items.length) html += `<div class="group"><h2>${name} · ${items.length}</h2>${card(items.map(t => taskRow(t)))}</div>`;
  }
  const done = tasks.filter(t => t.done).sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''));
  if (done.length) html += `<details class="group"><summary><h2>Done · ${done.length}</h2></summary>${card(done.map(t => taskRow(t)))}</details>`;
  $('#list').innerHTML = html || `<p class="empty">${q ? 'No matching tasks.' : 'Nothing here yet. Type in the box above to add a task.'}</p>`;
}

function renderCalendar() {
  const m = state.month;
  $('#cal-title').textContent = m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  if (!state.cal) return;
  const byDate = Object.fromEntries(state.cal.days.map(d => [d.date, d.items]));
  const t = today();
  let html = '';
  for (const { date } of state.cal.days) {
    const items = (byDate[date] || []).filter(e => !e.carried); // carry-overs and warnings belong to the agenda, not the grid
    const pills = items.slice(0, 3).map(e => `<span class="pill ${e.task.done ? 'done' : ''} ${e.task.priority === 'high' ? 'high' : ''} ${e.kind === 'deadline' ? 'deadline' : ''}">${esc(e.task.title)}</span>`).join('');
    const more = items.length > 3 ? `<span class="more">+${items.length - 3} more</span>` : '';
    const dots = `<span class="dots">${items.slice(0, 4).map(e => `<i class="${e.task.done ? 'done' : ''} ${e.kind === 'deadline' ? 'deadline' : ''}"></i>`).join('')}</span>`;
    const other = parseYmd(date).getMonth() !== m.getMonth();
    const cls = ['day', other && 'other', date === t && 'today', date === state.selected && 'selected'].filter(Boolean).join(' ');
    html += `<button class="${cls}" data-date="${date}"><span class="num">${parseYmd(date).getDate()}</span>${pills}${more}${dots}</button>`;
  }
  $('#cal').innerHTML = html;

  const sel = (byDate[state.selected] || []).filter(e => !e.carried || state.selected === t);
  $('#day-title').textContent = fmtDate(state.selected);
  $('#day-list').innerHTML = sel.length
    ? card(sel.map(e => taskRow(e.task, { ...e, date: state.selected })))
    : `<p class="empty">No tasks. Type in the box above to add one on this day.</p>`;
}

function render() {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.view === state.view);
  for (const v of ['agenda', 'list', 'calendar']) $('#view-' + v).hidden = state.view !== v;
  ({ agenda: renderAgenda, list: renderList, calendar: renderCalendar })[state.view]();
}

// ---- Quick add ----
function quickParse() {
  const text = $('#quick-input').value;
  const p = S.parseQuickAdd(text, today());
  // In the calendar, an undated capture lands on the selected day
  if (state.view === 'calendar' && !p.scheduled_date && !p.deadline_date) p.scheduled_date = state.selected;
  return p;
}
function renderPreview() {
  const text = $('#quick-input').value.trim();
  const el = $('#quick-preview');
  if (!text) { el.hidden = true; return; }
  const p = quickParse();
  const bits = [];
  if (p.scheduled_date) bits.push(`Scheduled ${fmtDate(p.scheduled_date)}${p.scheduled_time ? ' ' + fmtTime(p.scheduled_time) : ''}`);
  if (p.deadline_date) bits.push(`Deadline ${fmtDate(p.deadline_date)}`);
  if (p.warning_days != null) bits.push(`Warn ${plural(p.warning_days, 'day')} before`);
  if (p.repeat) bits.push('↻ ' + S.describeRepeat(p.repeat));
  if (p.priority) bits.push(p.priority === 'high' ? 'High priority' : 'Low priority');
  if (!bits.length) bits.push('Inbox');
  el.innerHTML = bits.map(b => `<span>${esc(b)}</span>`).join('');
  el.hidden = false;
}
$('#quick-input').addEventListener('input', renderPreview);
$('#quick').addEventListener('submit', async e => {
  e.preventDefault();
  const p = quickParse();
  if (!p.title) return;
  const t = await api('POST', '/api/tasks', p);
  $('#quick-input').value = '';
  renderPreview();
  toast(t.scheduled_date || t.deadline_date ? `Added for ${fmtDate(t.scheduled_date || t.deadline_date)}` : 'Added to Inbox');
  await load();
});
$('#quick-help').onclick = () => { $('#help').hidden = !$('#help').hidden; };

// ---- Editor ----
const form = $('#form');
function openEditor(task) {
  state.editing = task || null;
  $('#form-title').textContent = task ? 'Edit task' : 'New task';
  form.title.value = task?.title || '';
  form.scheduled_date.value = task ? task.scheduled_date || '' : (state.view === 'calendar' ? state.selected : '');
  form.scheduled_time.value = task?.scheduled_time || '';
  form.deadline_date.value = task?.deadline_date || '';
  form.warning_days.value = task?.warning_days ?? '';
  const r = S.parseRepeat(task?.repeat);
  form.repeat_mode.value = r ? r.mode : '';
  form.repeat_n.value = r ? r.n : 1;
  form.repeat_unit.value = r ? r.unit : 'w';
  form.priority.value = task?.priority || 'normal';
  form.notes.value = task?.notes || '';
  form.done.checked = !!task?.done;
  $('#delete').hidden = !task;
  const h = $('#history');
  h.hidden = !task?.repeat_count;
  if (task?.repeat_count) h.textContent = `Completed ${plural(task.repeat_count, 'time')}, last on ${new Date(task.completed_at).toLocaleDateString()}.`;
  $('#editor').showModal();
  if (!task) form.title.focus();
}
form.addEventListener('submit', async e => {
  e.preventDefault();
  const n = Math.max(1, parseInt(form.repeat_n.value, 10) || 1);
  const body = {
    title: form.title.value,
    scheduled_date: form.scheduled_date.value || null,
    scheduled_time: form.scheduled_date.value ? form.scheduled_time.value || null : null,
    deadline_date: form.deadline_date.value || null,
    warning_days: form.warning_days.value === '' ? null : parseInt(form.warning_days.value, 10),
    repeat: form.repeat_mode.value ? `${form.repeat_mode.value}${n}${form.repeat_unit.value}` : null,
    priority: form.priority.value, notes: form.notes.value, done: form.done.checked,
  };
  if (body.repeat && !body.scheduled_date && !body.deadline_date) body.scheduled_date = today();
  const t = state.editing ? await api('PATCH', `/api/tasks/${state.editing.id}`, body) : await api('POST', '/api/tasks', body);
  $('#editor').close();
  if (body.done && t.repeat) toast(`Done. Next: ${fmtDate(t.scheduled_date || t.deadline_date)}`);
  await load();
});
$('#cancel').onclick = () => $('#editor').close();
$('#delete').onclick = async () => {
  if (!state.editing || !confirm('Delete this task?')) return;
  await api('DELETE', `/api/tasks/${state.editing.id}`);
  $('#editor').close();
  await load();
};

// ---- Events ----
$('#add').onclick = () => openEditor();
$('#search').oninput = e => { state.query = e.target.value; renderList(); };
for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => {
  state.view = b.dataset.view;
  try { localStorage.setItem('view', state.view); } catch {}
  render(); renderPreview();
  if (state.view === 'calendar') load();
};
const goMonth = d => { state.month = d; state.cal = null; renderCalendar(); load(); };
$('#cal-prev').onclick = () => goMonth(new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1));
$('#cal-next').onclick = () => goMonth(new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1));
$('#cal-today').onclick = () => { const n = new Date(); state.selected = today(); goMonth(new Date(n.getFullYear(), n.getMonth(), 1)); };
$('#cal').onclick = e => {
  const day = e.target.closest('.day'); if (!day) return;
  state.selected = day.dataset.date;
  const d = parseYmd(state.selected);
  renderPreview();
  if (d.getMonth() !== state.month.getMonth()) goMonth(new Date(d.getFullYear(), d.getMonth(), 1));
  else renderCalendar();
};
document.addEventListener('click', async e => {
  const row = e.target.closest('.task'); if (!row) return;
  const id = Number(row.dataset.id);
  const task = state.tasks.find(t => t.id === id); if (!task) return;
  if (e.target.matches('input[type=checkbox]')) {
    const t = await api('PATCH', `/api/tasks/${id}`, { done: e.target.checked });
    if (e.target.checked && t.repeat) toast(`Done. Next: ${fmtDate(t.scheduled_date || t.deadline_date)}`);
    await load();
  } else openEditor(task);
});
document.querySelector('.cal-dow').innerHTML = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div>${d}</div>`).join('');
window.addEventListener('focus', load); // refresh when returning to the tab/app

try { const v = localStorage.getItem('view'); if (['agenda', 'list', 'calendar'].includes(v)) state.view = v; } catch {}
load();
