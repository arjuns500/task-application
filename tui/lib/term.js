// Minimal terminal helpers: styled segments, width-aware fitting and key decoding.
'use strict';

const ST = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', ital: '\x1b[3m', ul: '\x1b[4m', inv: '\x1b[7m', sel: '\x1b[48;5;237m', strike: '\x1b[9m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m' };

// Task text comes from the server: never let it carry escape sequences into the terminal.
const clean = s => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

function charWidth(cp) {
  if (cp >= 0x300 && cp <= 0x36f || cp === 0x200d || cp >= 0xfe00 && cp <= 0xfe0f) return 0;
  if (cp >= 0x1100 && cp <= 0x115f || cp >= 0x2e80 && cp <= 0xa4cf || cp >= 0xac00 && cp <= 0xd7a3 || cp >= 0xf900 && cp <= 0xfaff ||
      cp >= 0xfe30 && cp <= 0xfe4f || cp >= 0xff00 && cp <= 0xff60 || cp >= 0xffe0 && cp <= 0xffe6 || cp >= 0x1f300 && cp <= 0x1faff ||
      cp >= 0x20000 && cp <= 0x3fffd) return 2;
  return 1;
}
const width = s => { let w = 0; for (const ch of s) w += charWidth(ch.codePointAt(0)); return w; };

// Takes up to `max` columns of `s`; returns [text, columns used].
function take(s, max) {
  let out = '', w = 0;
  for (const ch of s) { const cw = charWidth(ch.codePointAt(0)); if (w + cw > max) break; out += ch; w += cw; }
  return [out, w];
}

// segs: [[style, text], ...]. Renders exactly `cols` columns: left segments, then right segments flush right.
function line(left, right, cols, base = '') {
  left = left.filter(Boolean).map(([st, t]) => [st, clean(t)]);
  right = (right || []).filter(Boolean).map(([st, t]) => [st, clean(t)]);
  let rw = right.reduce((n, [, t]) => n + width(t), 0);
  if (rw > cols / 2) { right = []; rw = 0; }
  const room = cols - (rw ? rw + 1 : 0);
  let out = base, used = 0;
  const lw = left.reduce((n, [, t]) => n + width(t), 0);
  for (const [st, t] of left) {
    const limit = lw > room ? room - 1 : room; // leave a column for the ellipsis
    const [txt, w] = take(t, limit - used);
    out += st + txt + ST.reset + base; used += w;
    if (txt.length < t.length) { out += '…'; used++; break; }
  }
  out += ' '.repeat(Math.max(0, cols - used - rw));
  for (const [st, t] of right) out += st + t + ST.reset + base;
  return out + ST.reset;
}

const SEQ = { '[A': 'up', '[B': 'down', '[C': 'right', '[D': 'left', '[H': 'home', '[F': 'end', 'OH': 'home', 'OF': 'end',
  '[1~': 'home', '[4~': 'end', '[7~': 'home', '[8~': 'end', '[3~': 'delete', '[5~': 'pageup', '[6~': 'pagedown', '[Z': 'S-tab',
  'OA': 'up', 'OB': 'down', 'OC': 'right', 'OD': 'left' };

// Decodes a chunk of raw input into key names: "a", "enter", "up", "C-u", "M-b", ...
function keys(buf) {
  const s = buf.toString('utf8'), out = [];
  for (let i = 0; i < s.length;) {
    if (s[i] === '\x1b') {
      if (s[i + 1] === '[' || s[i + 1] === 'O') {
        let j = i + 2;
        while (j < s.length && !/[A-Za-z~]/.test(s[j])) j++;
        const seq = s.slice(i + 1, j + 1);
        if (seq !== '[200~' && seq !== '[201~') out.push(SEQ[seq] || 'unknown'); // ignore bracketed-paste markers
        i = j + 1;
      } else if (s[i + 1] === '\x7f') { out.push('M-backspace'); i += 2; } else { out.push('escape'); i++; } // esc + key typed fast = both keys
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i)); i += ch.length;
    const cp = ch.codePointAt(0);
    if (ch === '\r' || ch === '\n') out.push('enter');
    else if (ch === '\x7f' || ch === '\b') out.push('backspace');
    else if (ch === '\t') out.push('tab');
    else if (cp < 32) out.push('C-' + String.fromCharCode(cp + 96));
    else out.push(ch);
  }
  return out;
}
const printable = k => [...k].length === 1 && k >= ' ';

module.exports = { ST, clean, width, take, line, keys, printable };
