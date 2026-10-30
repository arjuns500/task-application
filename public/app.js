'use strict';
const $ = s => document.querySelector(s);
const S = window.Shared;
const today = () => S.localToday();
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const now = new Date();
const state = { tasks: [], agenda: null, cal: null, view: 'agenda', month: new Date(now.getFullYear(), now.getMonth(), 1),
                selected: today(), editing: null, query: '', views: [], tags: [], activeView: null, editingView: null };

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

const activeView = () => state.views.find(v => v.id === state.activeView) || null;

async function load() {
  const t = today();
  const [from, to] = calRange();
  state.views = await api('GET', '/api/views');
  if (state.activeView && !activeView()) state.activeView = null;
  const vq = state.activeView ? `view=${state.activeView}` : '';
  const [tasks, agenda, cal, tags] = await Promise.all([
    api('GET', `/api/tasks?${vq}`),
    api('GET', `/api/agenda?from=${t}&to=${S.addDays(t, 6)}&${vq}`),
    state.view === 'calendar' ? api('GET', `/api/agenda?from=${from}&to=${to}&${vq}`) : null,
    api('GET', '/api/tags'),
  ]);
  Object.assign(state, { tasks, agenda, cal, tags });
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
  for (const g of t.tags) out.push(tagChip(g));
  if (t.notes) out.push('<span>📝</span>');
  return out;
}

// Each tag gets a stable color from its name
function tagHue(name) { let h = 0; for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360; return h; }
const tagChip = g => `<span class="tagchip" style="--h:${tagHue(g)}">#${esc(g)}</span>`;

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
  $('#list').innerHTML = html || `<p class="empty">${q ? 'No matching tasks.' : activeView() ? 'No tasks match this view.' : 'Nothing here yet. Type in the box above to add a task.'}</p>`;
}

function renderCalendar() {
  const m = state.month;
  $('#cal-title').textContent = m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  if (!state.cal) return;
  const byDate = Object.fromEntries(state.cal.days.map(d => [d.date, d.items]));
  const t = today();
  const limit = window.innerWidth >= 900 ? 6 : 3; // how many tasks fit in a day cell
  let html = '';
  for (const { date } of state.cal.days) {
    const items = (byDate[date] || []).filter(e => !e.carried); // carry-overs and warnings belong to the agenda, not the grid
    const pills = items.slice(0, limit).map(e => {
      const time = e.kind === 'scheduled' && e.task.scheduled_time ? `<span class="t">${esc(fmtTime(e.task.scheduled_time))}</span>` : '';
      const title = `${e.kind === 'deadline' ? 'Deadline: ' : ''}${e.task.title}`;
      return `<span class="pill ${e.task.done ? 'done' : ''} ${e.task.priority === 'high' ? 'high' : ''} ${e.kind === 'deadline' ? 'deadline' : ''}" data-id="${e.task.id}" title="${esc(title)}">${time}${esc(e.task.title)}</span>`;
    }).join('');
    const more = items.length > limit ? `<span class="more">+${items.length - limit} more</span>` : '';
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

function renderViews() {
  const chips = [`<button data-vid="" class="${state.activeView ? '' : 'active'}">All</button>`]
    .concat(state.views.map(v => `<button data-vid="${v.id}" class="${v.id === state.activeView ? 'active' : ''}">${esc(v.name)}</button>`));
  if (state.activeView) chips.push(`<button class="edit" data-edit-view aria-label="Edit view">Edit</button>`);
  chips.push(`<button class="add" data-new-view>+ View</button>`);
  $('#views').innerHTML = chips.join('');
}

function render() {
  document.body.classList.toggle('wide', state.view === 'calendar');
  renderViews();
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
  // In a view that's about one tag, new tasks get that tag
  const vt = activeView()?.filters.tags;
  if (!p.tags && vt?.length === 1) p.tags = [...vt];
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
  for (const g of p.tags || []) bits.push('#' + g);
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
  form.tags.value = task ? task.tags.join(' ') : (activeView()?.filters.tags?.length === 1 ? activeView().filters.tags[0] : '');
  renderTagSuggest();
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
    tags: editorTags(),
  };
  if (body.repeat && !body.scheduled_date && !body.deadline_date) body.scheduled_date = today();
  const t = state.editing ? await api('PATCH', `/api/tasks/${state.editing.id}`, body) : await api('POST', '/api/tasks', body);
  $('#editor').close();
  if (body.done && t.repeat) toast(`Done. Next: ${fmtDate(t.scheduled_date || t.deadline_date)}`);
  await load();
});
$('#cancel').onclick = () => $('#editor').close();

const editorTags = () => [...new Set(form.tags.value.split(/[\s,]+/).map(S.normalizeTag).filter(Boolean))];
function renderTagSuggest() {
  const cur = editorTags();
  $('#tag-suggest').innerHTML = state.tags.slice(0, 20).map(({ tag }) =>
    `<button type="button" data-tag="${esc(tag)}" class="${cur.includes(tag) ? 'on' : ''}">#${esc(tag)}</button>`).join('');
}
form.tags.addEventListener('input', renderTagSuggest);
$('#tag-suggest').onclick = e => {
  const b = e.target.closest('[data-tag]'); if (!b) return;
  const cur = editorTags(), g = b.dataset.tag;
  form.tags.value = (cur.includes(g) ? cur.filter(x => x !== g) : [...cur, g]).join(' ');
  renderTagSuggest();
};

// ---- Saved views ----
const vform = $('#view-form');
let viewTagState = {}; // tag -> 'on' (include) | 'off' (exclude)
function renderViewTags() {
  const names = [...new Set([...state.tags.map(t => t.tag), ...Object.keys(viewTagState)])];
  $('#view-tags').innerHTML = names.map(g => `<button type="button" data-tag="${esc(g)}" class="${viewTagState[g] || ''}">#${esc(g)}</button>`).join('')
    || '<small>No tags yet. Add tags to tasks, or type one below.</small>';
}
function openViewEditor(view) {
  state.editingView = view || null;
  $('#view-form-title').textContent = view ? 'Edit view' : 'New view';
  const f = view?.filters || {};
  vform.name.value = view?.name || '';
  viewTagState = {};
  for (const g of f.tags || []) viewTagState[g] = 'on';
  for (const g of f.exclude_tags || []) viewTagState[g] = 'off';
  for (const p of ['high', 'normal', 'low']) vform['p_' + p].checked = !!f.priority?.includes(p);
  vform.scope.value = f.scope || 'all';
  vform.q.value = f.q || '';
  vform.new_tag.value = '';
  $('#view-delete').hidden = !view;
  renderViewTags();
  $('#view-editor').showModal();
}
$('#view-tags').onclick = e => {
  const b = e.target.closest('[data-tag]'); if (!b) return;
  const g = b.dataset.tag;
  viewTagState[g] = { undefined: 'on', on: 'off', off: undefined }[viewTagState[g]];
  if (!viewTagState[g]) delete viewTagState[g];
  renderViewTags();
};
vform.new_tag.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const g = S.normalizeTag(vform.new_tag.value);
  if (g) { viewTagState[g] = 'on'; vform.new_tag.value = ''; renderViewTags(); }
});
vform.addEventListener('submit', async e => {
  e.preventDefault();
  const pending = S.normalizeTag(vform.new_tag.value);
  if (pending) viewTagState[pending] = 'on';
  const filters = {
    tags: Object.keys(viewTagState).filter(g => viewTagState[g] === 'on'),
    exclude_tags: Object.keys(viewTagState).filter(g => viewTagState[g] === 'off'),
    priority: ['high', 'normal', 'low'].filter(p => vform['p_' + p].checked),
    scope: vform.scope.value, q: vform.q.value.trim(),
  };
  const body = { name: vform.name.value, filters };
  const v = state.editingView ? await api('PATCH', `/api/views/${state.editingView.id}`, body) : await api('POST', '/api/views', body);
  $('#view-editor').close();
  setActiveView(v.id);
});
$('#view-cancel').onclick = () => $('#view-editor').close();
$('#view-delete').onclick = async () => {
  if (!state.editingView || !confirm(`Delete the view "${state.editingView.name}"? Tasks are not affected.`)) return;
  await api('DELETE', `/api/views/${state.editingView.id}`);
  $('#view-editor').close();
  setActiveView(null);
};
function setActiveView(id) {
  state.activeView = id;
  try { localStorage.setItem('activeView', id ?? ''); } catch {}
  renderPreview();
  load();
}
$('#views').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  if ('newView' in b.dataset) return openViewEditor();
  if ('editView' in b.dataset) return openViewEditor(activeView());
  setActiveView(b.dataset.vid ? Number(b.dataset.vid) : null);
};
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
  const pill = e.target.closest('.pill');
  if (pill && window.innerWidth >= 900) { const t = state.tasks.find(x => x.id === Number(pill.dataset.id)); if (t) return openEditor(t); }
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
try { const a = Number(localStorage.getItem('activeView')); if (a) state.activeView = a; } catch {}
let lastWide = window.innerWidth >= 900;
window.addEventListener('resize', () => { const w = window.innerWidth >= 900; if (w !== lastWide) { lastWide = w; if (state.view === 'calendar') renderCalendar(); } });
load();
