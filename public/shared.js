// Date helpers, org-mode style repeaters, and the quick-add parser.
// Shared by the server (require) and the browser (window.Shared).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  // Org repeaters: "+1w" (shift once), "++1w" (shift until in the future), ".+1w" (from completion date)
  const REPEAT_RE = /^(\+|\+\+|\.\+)(\d{1,3})([dwmy])$/;

  const pad = n => String(n).padStart(2, '0');

  // Dates are plain "YYYY-MM-DD" strings; arithmetic is done in UTC to avoid DST surprises.
  function toUtc(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
  function fromUtc(d) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
  function localToday(now = new Date()) { return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`; }
  function isValidDate(s) { return typeof s === 'string' && DATE_RE.test(s) && fromUtc(toUtc(s)) === s; }

  function addDays(s, n) { const d = toUtc(s); d.setUTCDate(d.getUTCDate() + n); return fromUtc(d); }
  function addMonths(s, n) {
    const [y, m, d] = s.split('-').map(Number);
    const target = new Date(Date.UTC(y, m - 1 + n, 1));
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(d, last)); // Jan 31 + 1m = Feb 28/29
    return fromUtc(target);
  }
  function addInterval(s, n, unit) {
    if (unit === 'd') return addDays(s, n);
    if (unit === 'w') return addDays(s, 7 * n);
    if (unit === 'm') return addMonths(s, n);
    return addMonths(s, 12 * n);
  }
  function diffDays(a, b) { return Math.round((toUtc(b) - toUtc(a)) / 864e5); } // b - a

  function parseRepeat(r) {
    const m = typeof r === 'string' && r.match(REPEAT_RE);
    return m ? { mode: m[1], n: Number(m[2]), unit: m[3] } : null;
  }

  // Next date for a repeating timestamp once the task is marked done on `today`.
  function nextRepeat(date, repeat, today) {
    const r = parseRepeat(repeat);
    if (!r || !date) return date;
    if (r.mode === '.+') return addInterval(today, r.n, r.unit);
    if (r.mode === '+') return addInterval(date, r.n, r.unit);
    // "++": keep adding until strictly after today, preserving the cadence
    let k = 1, next = addInterval(date, r.n, r.unit);
    while (next <= today && k < 10000) next = addInterval(date, r.n * ++k, r.unit);
    return next;
  }

  // Projected future occurrences of `date` (excluding `date` itself) within [from, to].
  function occurrences(date, repeat, from, to, max = 400) {
    const r = parseRepeat(repeat);
    const out = [];
    if (!r || !date) return out;
    for (let k = 1; k <= max; k++) {
      const d = addInterval(date, r.n * k, r.unit);
      if (d > to) break;
      if (d >= from) out.push(d);
    }
    return out;
  }

  function describeRepeat(repeat) {
    const r = parseRepeat(repeat);
    if (!r) return '';
    const unit = { d: 'day', w: 'week', m: 'month', y: 'year' }[r.unit];
    const every = r.n === 1 ? `every ${unit}` : `every ${r.n} ${unit}s`;
    return r.mode === '.+' ? `${every} after done` : every;
  }

  // ---- Quick-add ----
  // "Pay rent @fri 9:00 ^2026-11-05 -3d +1m !high"
  //   @date  scheduled      ^date  deadline      9:00 / 2pm  scheduled time
  //   +1w ++1w .+1d  repeat -3d / -1w  deadline warning period
  //   !high !! !low  priority
  // Dates: today, tom(orrow), mon..sun, YYYY-MM-DD, MM-DD, +3d/+2w/+1m/+1y.
  const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  function parseDateWord(w, today) {
    w = w.toLowerCase();
    if (w === 'today' || w === 'tod') return today;
    if (w === 'tomorrow' || w === 'tom' || w === 'tmr') return addDays(today, 1);
    if (w === 'yesterday') return addDays(today, -1);
    const wd = WEEKDAYS.indexOf(w.slice(0, 3));
    if (wd >= 0 && w.length >= 3 && 'sunday monday tuesday wednesday thursday friday saturday'.split(' ')[wd].startsWith(w)) {
      const cur = toUtc(today).getUTCDay();
      return addDays(today, (wd - cur + 7) % 7 || 7); // next such weekday, never today
    }
    let m = w.match(/^\+(\d{1,3})([dwmy])$/);
    if (m) return addInterval(today, Number(m[1]), m[2]);
    if (isValidDate(w)) return w;
    m = w.match(/^(\d{1,2})[-/](\d{1,2})$/);
    if (m) {
      let s = `${today.slice(0, 4)}-${pad(m[1])}-${pad(m[2])}`;
      if (!isValidDate(s)) return null;
      if (s < today) s = `${Number(today.slice(0, 4)) + 1}-${pad(m[1])}-${pad(m[2])}`;
      return isValidDate(s) ? s : null;
    }
    return null;
  }

  function parseTimeWord(w) {
    const m = w.toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
    if (!m || (!m[2] && !m[3])) return null; // a bare number isn't a time
    let h = Number(m[1]);
    const min = Number(m[2] || 0);
    if (m[3]) { if (h < 1 || h > 12) return null; h = (h % 12) + (m[3] === 'pm' ? 12 : 0); }
    const t = `${pad(h)}:${pad(min)}`;
    return TIME_RE.test(t) ? t : null;
  }

  function parseQuickAdd(text, today) {
    const out = {};
    const rest = [];
    for (const tok of String(text).trim().split(/\s+/).filter(Boolean)) {
      let v;
      if (tok[0] === '@' && (v = parseDateWord(tok.slice(1), today))) out.scheduled_date = v;
      else if (tok[0] === '^' && (v = parseDateWord(tok.slice(1), today))) out.deadline_date = v;
      else if (REPEAT_RE.test(tok)) out.repeat = tok;
      else if (/^-\d{1,3}[dw]$/.test(tok)) out.warning_days = Number(tok.slice(1, -1)) * (tok.endsWith('w') ? 7 : 1);
      else if (/^(!high|!!|!h)$/i.test(tok)) out.priority = 'high';
      else if (/^(!low|!l)$/i.test(tok)) out.priority = 'low';
      else if ((v = parseTimeWord(tok))) out.scheduled_time = v;
      else rest.push(tok);
    }
    out.title = rest.join(' ');
    if ((out.scheduled_time || out.repeat) && !out.scheduled_date && !out.deadline_date) out.scheduled_date = today;
    if (out.scheduled_time && !out.scheduled_date) out.scheduled_date = today;
    return out;
  }

  return { DATE_RE, TIME_RE, REPEAT_RE, localToday, isValidDate, addDays, addMonths, addInterval, diffDays,
           parseRepeat, nextRepeat, occurrences, describeRepeat, parseQuickAdd };
});
