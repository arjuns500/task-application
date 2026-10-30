// The full-screen terminal UI. Everything reads and writes the local store; the sync engine runs behind it.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const S = require('../../public/shared.js');
const M = require('./model.js');
const { ST, line, keys, printable, width } = require('./term.js');

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayName = d => { const [y, m, dd] = d.split('-').map(Number); return `${DOW[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]} ${dd} ${MON[m - 1]} ${y}`; };
const short = (d, today) => d.slice(0, 4) === today.slice(0, 4) ? d.slice(5) : d;
const ago = iso => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };

const HELP = [
  ['Views', ''], ['tab  1  2', 'agenda / all tasks'], ['v  V', 'next / previous saved view'], ['/', 'search (esc clears)'],
  ['h  l  t', 'agenda: previous / next week, back to today'], ['H', 'all tasks: show or hide done'],
  ['Move', ''], ['j k  ↓ ↑', 'down / up'], ['g G  PgUp PgDn', 'top / bottom / page'], ['enter', 'details'],
  ['Change', ''], ['a', 'quick add (same syntax as the web app: @fri ^11-05 9am +1w !high #tag)'],
  ['e', 'edit every field as quick-add text'], ['x  space', 'done / not done (repeating tasks move to the next date)'],
  ['s  d', 'set scheduled date / deadline (blank clears)'], ['>  <', 'reschedule one day later / earlier'],
  ['p', 'cycle priority'], ['n', 'edit notes in $EDITOR'], ['D', 'delete'],
  ['Sync', ''], ['r', 'sync now'], ['L', 'sync log (conflicts, rejected changes)'], ['q', 'quit'],
];

class App {
  constructor(store, engine, { stdin = process.stdin, stdout = process.stdout, warningDays = 14 } = {}) {
    Object.assign(this, { store, engine, stdin, stdout, warningDays });
    this.view = 'agenda'; this.viewIdx = -1; this.search = ''; this.showDone = false;
    this.from = null; this.selId = null; this.selKey = null; this.cursor = 0; this.scroll = 0;
    this.mode = null; this.flash = '';
    store.onRemap = (a, b) => { if (this.selId === a) { this.selId = b; this.selKey = null; } if (this.mode?.id === a) this.mode.id = b; };
  }

  get today() { return S.localToday(); }
  get savedViews() { return this.store.getMeta('views', []); }
  get filter() {
    const v = this.savedViews[this.viewIdx];
    return { ...(v?.filters || {}), ...(this.search ? { q: this.search } : {}) };
  }

  // ---- lifecycle ----
  start() {
    this.stdout.write('\x1b[?1049h\x1b[?25l');
    this.stdin.setRawMode(true); this.stdin.resume();
    this.onData = b => { for (const k of keys(b)) this.key(k); this.render(); };
    this.stdin.on('data', this.onData);
    this.onResize = () => this.render();
    this.stdout.on('resize', this.onResize);
    this.engine.on('change', this.onResize);
    this.clock = setInterval(() => this.render(), 30e3); // midnight rollover, "synced 3m ago"
    this.engine.start();
    this.render();
    return new Promise(resolve => { this.done = resolve; });
  }
  suspend() { this.stdin.setRawMode(false); this.stdout.write('\x1b[?25h\x1b[?1049l'); }
  resume() { this.stdout.write('\x1b[?1049h\x1b[?25l'); this.stdin.setRawMode(true); this.stdin.resume(); }
  quit() {
    clearInterval(this.clock); this.engine.stop();
    this.stdin.off('data', this.onData); this.stdout.off('resize', this.onResize); this.engine.off('change', this.onResize);
    this.suspend(); this.stdin.pause();
    this.done();
  }
  changed(msg) { if (msg) this.flash = msg; this.engine.soon(); }

  // ---- rows ----
  rows() {
    const today = this.today, f = this.filter, pending = this.store.pendingIds();
    const tasks = this.store.all().filter(t => M.matches(t, f));
    const mark = t => pending.has(t.id) ? [ST.magenta, ' ↑'] : null;
    const tagSegs = t => (t.tags || []).length ? [ST.blue, ' ' + t.tags.map(x => '#' + x).join(' ')] : null;
    const box = t => t.done ? [ST.green, '✓ '] : [ST.gray, '○ '];
    const prio = t => t.priority === 'high' ? [ST.red + ST.bold, '! '] : t.priority === 'low' ? [ST.gray, '↓ '] : ['', '  '];
    const title = t => [t.done ? ST.dim + ST.strike : t.priority === 'high' ? ST.bold : '', t.title];
    const rows = [];

    if (this.view === 'agenda') {
      const from = this.from || today;
      for (const day of M.agenda(tasks, from, S.addDays(from, 6), today, this.warningDays)) {
        const isToday = day.date === today;
        rows.push({ head: [[isToday ? ST.bold + ST.cyan : ST.bold, dayName(day.date)], isToday ? [ST.cyan, '  today'] : null] });
        for (const e of day.items) {
          const t = e.task;
          let label, st = ST.gray;
          if (e.kind === 'scheduled') {
            if (e.carried) { label = `Sched.${e.days}x:`; st = ST.yellow; }
            else if (t.scheduled_time) { label = t.scheduled_time; st = ST.cyan; }
            else label = 'Scheduled:';
          } else if (e.carried) {
            label = e.days < 0 ? `${-e.days} d. ago:` : `In ${e.days} d.:`; st = e.days < 0 ? ST.red + ST.bold : ST.yellow;
          } else { label = 'Deadline:'; st = day.date <= today && !t.done ? ST.red : ST.yellow; }
          rows.push({ id: t.id, key: `${day.date}:${e.kind}:${t.id}`, left: [['', '  '], [st, label.padEnd(11)], box(t), prio(t), title(t), tagSegs(t), mark(t)],
            right: [t.repeat ? [ST.gray, t.repeat] : null] });
        }
        if (!day.items.length && isToday) rows.push({ left: [[ST.gray, '  nothing today']] });
      }
      const inbox = M.sortTasks(tasks.filter(t => !t.done && !t.scheduled_date && !t.deadline_date));
      if (inbox.length) {
        rows.push({ left: [] }, { head: [[ST.bold, 'Inbox'], [ST.gray, `  ${inbox.length}`]] });
        for (const t of inbox) rows.push({ id: t.id, left: [['', '  '], box(t), prio(t), title(t), tagSegs(t), mark(t)] });
      }
    } else {
      for (const t of M.sortTasks(tasks.filter(t => this.showDone || !t.done))) {
        const right = [];
        if (t.scheduled_date) right.push([t.scheduled_date < today && !t.done ? ST.yellow : ST.cyan, `@${short(t.scheduled_date, today)}${t.scheduled_time ? ' ' + t.scheduled_time : ''}`]);
        if (t.deadline_date) right.push([t.deadline_date < today && !t.done ? ST.red : ST.yellow, `${right.length ? '  ' : ''}^${short(t.deadline_date, today)}`]);
        if (t.repeat) right.push([ST.gray, `  ${t.repeat}`]);
        rows.push({ id: t.id, left: [box(t), prio(t), title(t), tagSegs(t), mark(t)], right });
      }
      if (!rows.length) rows.push({ left: [[ST.gray, this.search || this.viewIdx >= 0 ? 'No matching tasks.' : 'No tasks yet. Press a to add one.']] });
    }
    return rows;
  }

  // ---- drawing ----
  render() {
    if (!this.stdout.isTTY && !this.forceRender) return;
    const cols = this.stdout.columns || 80, height = this.stdout.rows || 24;
    const out = [];
    const tab = (name, on) => [on ? ST.inv + ST.bold : ST.dim, ` ${name} `];
    const v = this.savedViews[this.viewIdx];
    out.push(line([[ST.bold, ' Tasks '], tab('1 Agenda', this.view === 'agenda'), ['', ' '], tab('2 All', this.view === 'tasks'),
      v ? [ST.blue, `  view: ${v.name}`] : null, this.search ? [ST.yellow, `  /${this.search}`] : null,
      this.view === 'tasks' && this.showDone ? [ST.gray, '  +done'] : null],
      [[ST.gray, dayName(this.today) + ' ']], cols));

    const bodyH = Math.max(1, height - 3);
    let body;
    if (this.mode?.type === 'help') body = HELP.map(([k, d]) => d ? line([['', '  '], [ST.cyan, k.padEnd(16)], ['', d]], [], cols) : line([[ST.bold, ' ' + k]], [], cols));
    else if (this.mode?.type === 'log') {
      const logs = this.store.logs(bodyH - 1);
      body = [line([[ST.bold, ' Sync log'], [ST.gray, '  (newest first, any key to close)']], [], cols),
        ...(logs.length ? logs.map(l => line([[ST.gray, ' ' + l.at.slice(0, 16).replace('T', ' ') + '  '], ['', l.message]], [], cols)) : [line([[ST.gray, '  nothing yet']], [], cols)])];
    } else if (this.mode?.type === 'detail') body = this.detail(cols);
    else body = this.list(cols, bodyH);
    while (body.length < bodyH) body.push(' '.repeat(cols));
    out.push(...body.slice(0, bodyH));

    out.push(this.statusLine(cols));
    let cursorAt = null;
    if (this.mode?.type === 'prompt') {
      const p = this.mode, before = p.value.slice(0, p.pos);
      const avail = cols - width(p.label) - 2;
      const skip = Math.max(0, width(before) - avail + 1);
      let shown = p.value, off = 0;
      if (skip) { let w = 0; for (const ch of shown) { if (w >= skip) break; w += width(ch); off += ch.length; } shown = shown.slice(off); }
      out.push(line([[ST.bold, ' ' + p.label + ' '], ['', shown]], [], cols));
      cursorAt = 2 + width(p.label) + width(p.value.slice(off, p.pos));
    } else if (this.mode?.type === 'confirm') out.push(line([[ST.yellow + ST.bold, ' ' + this.mode.text + ' '], [ST.gray, '(y/n)']], [], cols));
    else if (this.flash) out.push(line([['', ' ' + this.flash]], [], cols));
    else out.push(line([[ST.gray, ' a add  e edit  x done  s/d dates  >/< shift  p prio  n notes  D del  / search  v view  r sync  q quit']], [], cols));

    this.stdout.write('\x1b[H' + out.join('\r\n') + (cursorAt != null ? `\x1b[${height};${cursorAt}H\x1b[?25h` : '\x1b[?25l'));
  }

  list(cols, bodyH) {
    const rows = this.rows();
    this.selectable = rows.map((r, i) => r.id != null ? i : -1).filter(i => i >= 0);
    this.rows_ = rows;
    // Keep the selection on the same row (a repeating task can be on several days), else the same task,
    // else the same position.
    let idx = this.selKey != null ? rows.findIndex(r => r.id != null && (r.key ?? r.id) === this.selKey) : -1;
    if (idx < 0 && this.selId != null) idx = rows.findIndex(r => r.id === this.selId);
    if (idx < 0) idx = this.selectable[Math.min(this.cursor, this.selectable.length - 1)] ?? -1;
    this.cursor = Math.max(0, this.selectable.indexOf(idx));
    this.selId = idx >= 0 ? rows[idx].id : null;
    this.selKey = idx >= 0 ? rows[idx].key ?? rows[idx].id : null;
    if (idx >= 0) {
      let top = idx; // scroll the day heading above the selection into view too
      while (top > 0 && rows[top - 1].id == null && idx - top < 2) top--;
      if (top < this.scroll) this.scroll = top;
      if (idx >= this.scroll + bodyH) this.scroll = idx - bodyH + 1;
    }
    this.scroll = Math.max(0, Math.min(this.scroll, rows.length - bodyH));
    this.pageSize = bodyH;
    return rows.slice(this.scroll, this.scroll + bodyH).map((r, i) => {
      if (r.head) return line(r.head, [], cols);
      const sel = this.scroll + i === idx;
      return line(sel ? [[ST.cyan + ST.bold, '▌'], ...r.left] : [['', ' '], ...r.left], r.right, cols, sel ? ST.sel : '');
    });
  }

  detail(cols) {
    const t = this.store.get(this.mode.id);
    if (!t) { this.mode = null; return this.list(cols, (this.stdout.rows || 24) - 3); }
    const pending = this.store.pendingIds().has(t.id);
    const f = (k, v, st = '') => line([[ST.gray, `  ${k.padEnd(12)}`], [st, v ?? '']], [], cols);
    const out = [line([['', ' '], [ST.bold, t.title]], [], cols), ' '.repeat(cols),
      f('status', t.done ? 'done' : 'open', t.done ? ST.green : ''),
      f('scheduled', t.scheduled_date ? `${dayName(t.scheduled_date)}${t.scheduled_time ? ' at ' + t.scheduled_time : ''}` : '—'),
      f('deadline', t.deadline_date ? `${dayName(t.deadline_date)}${t.warning_days != null ? `  (warn ${t.warning_days} d. before)` : ''}` : '—'),
      f('repeat', t.repeat ? `${t.repeat}  (${S.describeRepeat(t.repeat)}${t.repeat_count ? `, done ${t.repeat_count}×` : ''})` : '—'),
      f('priority', t.priority, t.priority === 'high' ? ST.red : ''),
      f('tags', (t.tags || []).map(x => '#' + x).join(' ') || '—', ST.blue),
      f('sync', t.id < 0 ? 'not on the server yet' : pending ? `id ${t.id}, local changes waiting to sync` : `id ${t.id}, synced`, pending ? ST.magenta : ST.gray),
      f('updated', t.updated_at ? new Date(t.updated_at).toLocaleString() : ''),
      ' '.repeat(cols), line([[ST.gray, '  notes  (n to edit)']], [], cols)];
    for (const l of (t.notes || '').split('\n')) out.push(line([['', '  ' + l]], [], cols));
    return out;
  }

  statusLine(cols) {
    const e = this.engine, n = this.store.pendingCount(), last = this.store.getMeta('last_sync');
    const state = {
      local: [ST.gray, '● local only (no server configured)'],
      idle: [ST.gray, '○ not synced yet'],
      syncing: [ST.cyan, '⟳ syncing…'],
      ok: [ST.green, `● synced ${last ? ago(last) : ''}`],
      offline: [ST.yellow, `○ offline (${e.error})${last ? `, last synced ${ago(last)}` : ''}`],
      auth: [ST.red, '✗ server rejected the token (set TASKS_TOKEN or run: tasks-tui config --token ...)'],
    }[e.state];
    return line([['', ' '], state, n ? [ST.magenta, `  ${n} change${n > 1 ? 's' : ''} to send`] : null],
      [[ST.gray, '? help ']], cols);
  }

  // ---- input ----
  get sel() { const id = this.mode?.type === 'detail' ? this.mode.id : this.selId; return id != null ? this.store.get(id) : null; }

  move(n) {
    const len = this.selectable?.length || 0;
    if (!len) return;
    this.cursor = Math.max(0, Math.min(len - 1, this.cursor + n));
    const r = this.rows_[this.selectable[this.cursor]];
    this.selId = r.id; this.selKey = r.key ?? r.id;
  }

  prompt(label, value, submit, live) { this.mode = { type: 'prompt', label, value, pos: value.length, submit, live, prev: this.mode }; }

  key(k) {
    if (k === 'C-c') return this.quit();
    const m = this.mode;
    if (m?.type === 'prompt') return this.promptKey(k);
    if (m?.type === 'confirm') { this.mode = m.prev; if (k === 'y' || k === 'Y') m.yes(); return; }
    if (m?.type === 'help' || m?.type === 'log') { this.mode = null; return; }
    this.flash = '';
    if (m?.type === 'detail' && (k === 'escape' || k === 'q' || k === 'enter' || k === 'backspace')) { this.mode = null; return; }
    const today = this.today, t = this.sel;
    switch (k) {
      case 'q': return this.quit();
      case '?': this.mode = { type: 'help' }; return;
      case 'L': this.mode = { type: 'log' }; return;
      case 'tab': case 'S-tab': this.view = this.view === 'agenda' ? 'tasks' : 'agenda'; this.mode = null; return;
      case '1': this.view = 'agenda'; this.mode = null; return;
      case '2': this.view = 'tasks'; this.mode = null; return;
      case 'j': case 'down': case 'C-n': return this.move(1);
      case 'k': case 'up': case 'C-p': return this.move(-1);
      case 'g': case 'home': return this.move(-1e9);
      case 'G': case 'end': return this.move(1e9);
      case 'pagedown': case 'C-d': return this.move(Math.max(1, (this.pageSize || 20) - 2));
      case 'pageup': case 'C-u': return this.move(-Math.max(1, (this.pageSize || 20) - 2));
      case 'h': case 'left': if (this.view === 'agenda') this.from = S.addDays(this.from || today, -7); return;
      case 'l': case 'right': if (this.view === 'agenda') this.from = S.addDays(this.from || today, 7); return;
      case 't': case '.': this.from = null; return;
      case 'H': this.showDone = !this.showDone; return;
      case 'v': case 'V': {
        const n = this.savedViews.length;
        if (!n) { this.flash = 'No saved views (make them in the web app; they sync here).'; return; }
        this.viewIdx = ((this.viewIdx + 1 + (k === 'v' ? 1 : -1)) % (n + 1) + n + 1) % (n + 1) - 1;
        return;
      }
      case '/': {
        const old = this.search;
        this.prompt('Search', this.search, v => { this.search = v.trim(); }, v => { this.search = v.trim(); });
        this.mode.cancel = () => { this.search = old; };
        return;
      }
      case 'escape': if (this.search) this.search = ''; else if (this.viewIdx >= 0) this.viewIdx = -1; return;
      case 'r': this.engine.run(); return;
      case 'a': case 'c': {
        // A view with exactly one tag adds that tag, like the web app.
        const tags = this.savedViews[this.viewIdx]?.filters?.tags;
        const suffix = tags?.length === 1 ? ` #${tags[0]}` : '';
        this.prompt('Add', suffix ? ' ' + suffix.trim() : '', v => {
          const fields = S.parseQuickAdd(v, today);
          if (!fields.title) { this.flash = 'A task needs a title.'; return; }
          if (this.view === 'agenda' && this.from && !fields.scheduled_date && !fields.deadline_date) fields.scheduled_date = this.from;
          const nt = this.store.create(fields);
          this.selId = nt.id; this.selKey = null; this.changed(`Added "${nt.title}"`);
        });
        this.mode.pos = 0;
        return;
      }
    }
    if (!t) return;
    switch (k) {
      case 'enter': this.mode = { type: 'detail', id: t.id }; return;
      case 'x': case ' ': {
        const r = this.store.complete(t.id, today);
        this.changed(t.done ? `Reopened "${t.title}"` : t.repeat ? `Done; next: ${r.scheduled_date || r.deadline_date}` : `Done: "${t.title}"`);
        return;
      }
      case 'e': this.prompt('Edit', M.toQuickAdd(t), v => {
        const f = M.parseEdit(t, v, today);
        if (f.repeat && !f.scheduled_date && !f.deadline_date && !t.scheduled_date && !t.deadline_date) f.scheduled_date = today;
        if (Object.keys(f).length) { this.store.update(t.id, f); this.changed('Saved'); }
      }); return;
      case 's': case 'd': {
        const field = k === 's' ? 'scheduled_date' : 'deadline_date';
        this.prompt(k === 's' ? 'Schedule' : 'Deadline', t[field] || '', v => {
          v = v.trim().replace(/^[@^]/, '');
          let date = null, time;
          if (v) {
            const [dw, tw] = v.split(/\s+/);
            date = S.parseQuickAdd('@' + dw, today).scheduled_date;
            if (!date) { this.flash = `Didn't understand "${dw}" (try tom, fri, 11-05, +3d)`; return; }
            if (tw && k === 's') time = S.parseQuickAdd(tw, today).scheduled_time;
          }
          if (!date && t.repeat && !(k === 's' ? t.deadline_date : t.scheduled_date)) { this.flash = 'A repeating task needs a date.'; return; }
          this.store.update(t.id, { [field]: date, ...(time ? { scheduled_time: time } : {}) }); this.changed();
        }); return;
      }
      case '>': case '<': {
        const base = t.scheduled_date || today;
        this.store.update(t.id, { scheduled_date: S.addDays(base < today && k === '>' ? today : base, k === '>' ? 1 : -1) });
        return this.changed();
      }
      case 'p': this.store.update(t.id, { priority: { normal: 'high', high: 'low', low: 'normal' }[t.priority] || 'normal' }); return this.changed();
      case 'n': return this.editNotes(t);
      case 'D': this.mode = { type: 'confirm', text: `Delete "${t.title}"?`, prev: m, yes: () => { this.store.remove(t.id); this.changed('Deleted'); } }; return;
    }
  }

  promptKey(k) {
    const p = this.mode;
    const set = (value, pos) => { p.value = value; p.pos = pos; p.live?.(value); };
    switch (k) {
      case 'enter': this.mode = p.prev?.type === 'detail' ? p.prev : null; p.submit(p.value); return;
      case 'escape': case 'C-g': this.mode = p.prev?.type === 'detail' ? p.prev : null; p.cancel?.(); return;
      case 'left': case 'C-b': p.pos = Math.max(0, p.pos - 1); return;
      case 'right': case 'C-f': p.pos = Math.min(p.value.length, p.pos + 1); return;
      case 'home': case 'C-a': p.pos = 0; return;
      case 'end': case 'C-e': p.pos = p.value.length; return;
      case 'backspace': case 'C-h': if (p.pos) set(p.value.slice(0, p.pos - 1) + p.value.slice(p.pos), p.pos - 1); return;
      case 'delete': case 'C-d': set(p.value.slice(0, p.pos) + p.value.slice(p.pos + 1), p.pos); return;
      case 'C-u': set(p.value.slice(p.pos), 0); return;
      case 'C-k': set(p.value.slice(0, p.pos), p.pos); return;
      case 'C-w': case 'M-backspace': { const i = p.value.slice(0, p.pos).replace(/\S+\s*$/, '').length; set(p.value.slice(0, i) + p.value.slice(p.pos), i); return; }
    }
    if (printable(k)) set(p.value.slice(0, p.pos) + k + p.value.slice(p.pos), p.pos + k.length);
  }

  editNotes(t) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-')), 'notes.md');
    fs.writeFileSync(file, t.notes || '');
    this.suspend();
    const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
    const r = spawnSync(editor, [file], { stdio: 'inherit', shell: /\s/.test(editor) });
    this.resume();
    if (r.status === 0) {
      const notes = fs.readFileSync(file, 'utf8').replace(/\s+$/, '');
      if (notes !== (t.notes || '')) { this.store.update(t.id, { notes }); this.changed('Notes saved'); }
    } else this.flash = `${editor} exited with an error; notes unchanged`;
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

module.exports = { App };
