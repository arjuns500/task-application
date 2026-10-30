'use strict';
const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { tasks: [], view: 'list', month: new Date(), selected: ymd(new Date()), editing: null, query: '' };
state.month.setDate(1);

// ---- API ----
function token() { try { return localStorage.getItem('token') || ''; } catch { return ''; } }
async function api(method, path, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token()) headers.Authorization = 'Bearer ' + token();
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) {
    const t = prompt('API token required:');
    if (t != null) { try { localStorage.setItem('token', t); } catch {} return api(method, path, body); }
    throw new Error('unauthorized');
  }
  if (!res.ok) { const e = await res.json().catch(() => ({})); alert(e.error || res.statusText); throw new Error(e.error); }
  return res.status === 204 ? null : res.json();
}
async function load() { state.tasks = await api('GET', '/api/tasks'); render(); }

// ---- Rendering ----
function fmtDate(s) {
  const today = ymd(new Date());
  const tomorrow = ymd(new Date(Date.now() + 864e5));
  if (s === today) return 'Today';
  if (s === tomorrow) return 'Tomorrow';
  const d = parseYmd(s);
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}
function fmtTime(t) {
  const [h, m] = t.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function taskRow(t, { showDate = true } = {}) {
  const today = ymd(new Date());
  const late = !t.done && t.due_date && t.due_date < today;
  const meta = [];
  if (showDate && t.due_date) meta.push(`<span class="${late ? 'late' : ''}">${esc(fmtDate(t.due_date))}</span>`);
  if (t.due_time) meta.push(`<span>${esc(fmtTime(t.due_time))}</span>`);
  if (t.notes) meta.push(`<span>📝</span>`);
  return `<div class="task ${t.done ? 'done' : ''}" data-id="${t.id}">
    <input type="checkbox" ${t.done ? 'checked' : ''} aria-label="Mark done">
    <div class="body"><div class="title">${esc(t.title)}</div>${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}</div>
    <span class="prio ${t.priority}" title="${t.priority} priority"></span>
  </div>`;
}

function renderList() {
  const q = state.query.toLowerCase();
  const tasks = state.tasks.filter(t => !q || t.title.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q));
  const today = ymd(new Date());
  const groups = [
    ['Overdue', t => !t.done && t.due_date && t.due_date < today, 'overdue'],
    ['Today', t => !t.done && t.due_date === today],
    ['Upcoming', t => !t.done && t.due_date && t.due_date > today],
    ['No date', t => !t.done && !t.due_date],
  ];
  let html = '';
  for (const [name, fn, cls] of groups) {
    const items = tasks.filter(fn);
    if (items.length) html += `<div class="group"><h2 class="${cls || ''}">${name} · ${items.length}</h2><div class="card">${items.map(t => taskRow(t)).join('')}</div></div>`;
  }
  const done = tasks.filter(t => t.done).sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''));
  if (done.length) html += `<details class="group"><summary><h2>Done · ${done.length}</h2></summary><div class="card">${done.map(t => taskRow(t)).join('')}</div></details>`;
  $('#list').innerHTML = html || `<p class="empty">${q ? 'No matching tasks.' : 'Nothing to do. Tap + to add a task.'}</p>`;
}

function renderCalendar() {
  const m = state.month;
  $('#cal-title').textContent = m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const byDate = {};
  for (const t of state.tasks) if (t.due_date) (byDate[t.due_date] ||= []).push(t);

  // Weeks start on Monday
  const start = new Date(m.getFullYear(), m.getMonth(), 1);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const today = ymd(new Date());
  let html = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    if (i === 35 && d.getMonth() !== m.getMonth()) break; // drop a 6th row that's entirely next month
    const key = ymd(d);
    const items = byDate[key] || [];
    const pills = items.slice(0, 3).map(t => `<span class="pill ${t.done ? 'done' : ''} ${t.priority === 'high' ? 'high' : ''}">${esc(t.title)}</span>`).join('');
    const more = items.length > 3 ? `<span class="more">+${items.length - 3} more</span>` : '';
    const dots = `<span class="dots">${items.slice(0, 4).map(t => `<i class="${t.done ? 'done' : ''}"></i>`).join('')}</span>`;
    const cls = ['day', d.getMonth() !== m.getMonth() && 'other', key === today && 'today', key === state.selected && 'selected'].filter(Boolean).join(' ');
    html += `<button class="${cls}" data-date="${key}"><span class="num">${d.getDate()}</span>${pills}${more}${dots}</button>`;
  }
  $('#cal').innerHTML = html;

  const sel = byDate[state.selected] || [];
  $('#day-title').textContent = fmtDate(state.selected);
  $('#day-list').innerHTML = sel.length
    ? `<div class="card">${sel.map(t => taskRow(t, { showDate: false })).join('')}</div>`
    : `<p class="empty">No tasks. Tap + to add one on this day.</p>`;
}

function render() {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.view === state.view);
  $('#view-list').hidden = state.view !== 'list';
  $('#view-calendar').hidden = state.view !== 'calendar';
  state.view === 'list' ? renderList() : renderCalendar();
}

// ---- Editor ----
const form = $('#form');
function openEditor(task) {
  state.editing = task || null;
  $('#form-title').textContent = task ? 'Edit task' : 'New task';
  form.title.value = task?.title || '';
  form.due_date.value = task ? task.due_date || '' : (state.view === 'calendar' ? state.selected : '');
  form.due_time.value = task?.due_time || '';
  form.priority.value = task?.priority || 'normal';
  form.notes.value = task?.notes || '';
  form.done.checked = !!task?.done;
  $('#delete').hidden = !task;
  $('#editor').showModal();
  if (!task) form.title.focus();
}
form.addEventListener('submit', async e => {
  e.preventDefault();
  const body = { title: form.title.value, due_date: form.due_date.value || null, due_time: form.due_time.value || null,
                 priority: form.priority.value, notes: form.notes.value, done: form.done.checked };
  if (state.editing) await api('PATCH', `/api/tasks/${state.editing.id}`, body);
  else await api('POST', '/api/tasks', body);
  $('#editor').close();
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
for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => { state.view = b.dataset.view; try { localStorage.setItem('view', state.view); } catch {} render(); };
$('#cal-prev').onclick = () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1); renderCalendar(); };
$('#cal-next').onclick = () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1); renderCalendar(); };
$('#cal-today').onclick = () => { const n = new Date(); state.month = new Date(n.getFullYear(), n.getMonth(), 1); state.selected = ymd(n); renderCalendar(); };
$('#cal').onclick = e => {
  const day = e.target.closest('.day'); if (!day) return;
  state.selected = day.dataset.date;
  const d = parseYmd(state.selected);
  if (d.getMonth() !== state.month.getMonth()) state.month = new Date(d.getFullYear(), d.getMonth(), 1);
  renderCalendar();
};
document.addEventListener('click', async e => {
  const row = e.target.closest('.task'); if (!row) return;
  const task = state.tasks.find(t => t.id === Number(row.dataset.id)); if (!task) return;
  if (e.target.matches('input[type=checkbox]')) {
    await api('PATCH', `/api/tasks/${task.id}`, { done: e.target.checked });
    await load();
  } else openEditor(task);
});
document.querySelector('.cal-dow').innerHTML = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div>${d}</div>`).join('');
window.addEventListener('focus', load); // refresh when returning to the tab/app

try { state.view = localStorage.getItem('view') || 'list'; } catch {}
load();
