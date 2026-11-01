// Modern TUI widgets (no dependencies). Each widget is a plain object:
//   { render({cols, rows}) -> string[], onKey(key, api), cancelValue }
// InputBox.widget() draws it, redraws after every key and resolves with api.done(value).
// Keys come from input.js: up/down/left/right/home/end/pageup/pagedown/enter/escape/tab/backspace/delete/
// ctrl-c/ctrl-l/kill-start/paste/text(+text).

import { clip, stringWidth, wrapCells } from './input.js';

const ESC = '\x1b';
const NO_COLOR = Boolean(process.env.NO_COLOR);
const RESET = `${ESC}[0m`;
export const fg = (n) => (s) => (NO_COLOR ? String(s) : `${ESC}[38;5;${n}m${s}${RESET}`);
export const bold = (s) => (NO_COLOR ? String(s) : `${ESC}[1m${s}${RESET}`);
export const inverse = (s) => (NO_COLOR ? `[${s}]` : `${ESC}[7m${s}${RESET}`);
export const dim = fg(244);
export const faint = fg(240);
export const ACCENT = fg(141);

const unicode = process.platform !== 'win32' || Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.ConEmuANSI) || process.env.TERM === 'xterm-256color';
const G = unicode ? { tl: '╭', bl: '╰', bar: '│', sel: '❯', dot: '●', off: '○', up: '▲', down: '▼', ok: '✓' } : { tl: '+', bl: '+', bar: '|', sel: '>', dot: '*', off: 'o', up: '^', down: 'v', ok: 'v' };
export { G as GLYPHS };

const width = (cols) => Math.max(34, Math.min(100, cols - 6));
const pad = (s, w) => s + ' '.repeat(Math.max(0, w - stringWidth(s)));

function frame({ title, subtitle, body, hint, accent = ACCENT, inner }) {
  const bar = accent(G.bar);
  const out = [`  ${accent(G.tl + '─')} ${bold(title)}${subtitle ? `  ${dim(subtitle)}` : ''}`];
  for (const l of body) out.push(`  ${bar} ${l}`);
  out.push(`  ${accent(G.bl + '─')} ${dim(clip(hint, inner))}`);
  return out;
}

/**
 * Searchable list. items: [{ value, label, description?, hint?, group?, disabled?, current? }]
 * Type to filter, ↑/↓ move, PgUp/PgDn jump, Enter select, Esc cancel.
 * opts: { title, subtitle, items, filter=true, placeholder, current, emptyText, allowCustom }
 * allowCustom: Enter on a query with no match returns { custom: query }.
 */
export function selectWidget({ title, subtitle, items, filter = true, placeholder = 'type to filter', current = null, emptyText = 'Nothing matches.', allowCustom = false, query = '', accent = ACCENT }) {
  const st = { query, idx: Math.max(0, items.findIndex((i) => i.value === current)), top: 0 };
  const visible = () => {
    const q = st.query.trim().toLowerCase();
    return q ? items.filter((i) => `${i.label} ${i.description ?? ''} ${i.group ?? ''} ${i.value ?? ''}`.toLowerCase().includes(q)) : items;
  };
  const move = (list, dir) => {
    if (!list.length) return;
    let n = st.idx;
    for (let k = 0; k < list.length; k++) {
      n = (n + dir + list.length) % list.length;
      if (!list[n].disabled) break;
    }
    st.idx = n;
  };
  return {
    cancelValue: null,
    render({ cols, rows }) {
      const inner = width(cols) - 2;
      const list = visible();
      if (st.idx >= list.length) st.idx = Math.max(0, list.length - 1);
      const room = Math.max(3, Math.min(14, rows - 9));
      if (st.idx < st.top) st.top = st.idx;
      if (st.idx >= st.top + room) st.top = st.idx - room + 1;
      st.top = Math.max(0, Math.min(st.top, Math.max(0, list.length - room)));
      const body = [];
      if (filter) body.push(`${accent('›')} ${st.query ? bold(st.query) : dim(placeholder)}${inverse(' ')}${dim(list.length === items.length ? `  ${items.length}` : `  ${list.length}/${items.length}`)}`);
      if (filter) body.push('');
      if (st.top > 0) body.push(dim(`  ${G.up} ${st.top} more`));
      let lastGroup = null;
      const labelW = Math.min(34, Math.max(...list.map((i) => stringWidth(i.label)), 8));
      list.slice(st.top, st.top + room).forEach((item, k) => {
        if (item.group && item.group !== lastGroup && !st.query) {
          lastGroup = item.group;
          body.push(dim(`  ${item.group}`));
        }
        const selected = st.top + k === st.idx;
        const mark = item.current ? G.dot : ' ';
        const label = pad(clip(item.label, labelW), labelW);
        const desc = item.description ? `  ${clip(item.description, Math.max(8, inner - labelW - 8))}` : '';
        const text = `${selected ? G.sel : ' '} ${mark} ${label}${desc}`;
        body.push(item.disabled ? faint(text) : selected ? accent(bold(clip(text, inner))) : fg(250)(clip(text, inner)));
      });
      if (st.top + room < list.length) body.push(dim(`  ${G.down} ${list.length - st.top - room} more`));
      if (!list.length) body.push(dim(`  ${allowCustom && st.query ? `Enter = use "${st.query}" as typed` : emptyText}`));
      return frame({ title, subtitle, body, accent, inner, hint: `${filter ? 'type filter · ' : ''}↑/↓ move · Enter select · Esc back` });
    },
    onKey(key, api) {
      const list = visible();
      switch (key.name) {
        case 'up': return move(list, -1);
        case 'down': case 'tab': return move(list, 1);
        case 'pageup': st.idx = Math.max(0, st.idx - 8); return;
        case 'pagedown': st.idx = Math.min(Math.max(0, list.length - 1), st.idx + 8); return;
        case 'home': st.idx = 0; return;
        case 'end': st.idx = Math.max(0, list.length - 1); return;
        case 'enter': {
          const item = list[st.idx];
          if (item && !item.disabled) return api.done(item.value);
          if (allowCustom && st.query.trim()) return api.done({ custom: st.query.trim() });
          return;
        }
        case 'backspace': st.query = st.query.slice(0, -1); st.idx = 0; st.top = 0; return;
        case 'kill-start': st.query = ''; st.idx = 0; st.top = 0; return;
        case 'text': case 'paste':
          if (filter) {
            st.query += key.text.replace(/\s+/g, ' ');
            st.idx = 0;
            st.top = 0;
          }
          return;
        default:
      }
    },
  };
}

/**
 * Single-line text field. opts: { title, subtitle, label, initial, placeholder, mask, validate(value)->error|null, help }
 * Resolves with the string, or null when cancelled. mask hides secrets (API keys).
 */
export function textWidget({ title, subtitle, label = '', initial = '', placeholder = '', mask = false, validate = null, help = [], accent = ACCENT }) {
  const st = { chars: [...initial], cur: [...initial].length, error: '', reveal: false };
  return {
    cancelValue: null,
    render({ cols }) {
      const inner = width(cols) - 2;
      const shown = st.chars.map((c) => (mask && !st.reveal ? '•' : c));
      const before = shown.slice(0, st.cur).join('');
      const at = shown[st.cur] ?? ' ';
      const after = shown.slice(st.cur + 1).join('');
      const field = st.chars.length || st.cur ? `${before}${inverse(at)}${after}` : `${placeholder ? dim(placeholder) : ''}${inverse(' ')}`;
      const body = [...help.flatMap((h) => wrapCells(h, inner).map((p) => dim(p))), ...(help.length ? [''] : []), `${label ? `${dim(label)} ` : ''}${accent('›')} ${field}`];
      if (st.error) body.push(fg(203)(`  ${st.error}`));
      return frame({ title, subtitle, body, accent, inner, hint: `Enter confirm · Esc cancel${mask ? ' · Ctrl+R show/hide' : ''}` });
    },
    onKey(key, api) {
      switch (key.name) {
        case 'enter': {
          const value = st.chars.join('').trim();
          const err = validate?.(value);
          if (err) { st.error = err; return; }
          return api.done(value);
        }
        case 'left': st.cur = Math.max(0, st.cur - 1); return;
        case 'right': st.cur = Math.min(st.chars.length, st.cur + 1); return;
        case 'home': st.cur = 0; return;
        case 'end': st.cur = st.chars.length; return;
        case 'backspace': if (st.cur) { st.chars.splice(st.cur - 1, 1); st.cur--; } st.error = ''; return;
        case 'delete': st.chars.splice(st.cur, 1); st.error = ''; return;
        case 'kill-start': st.chars.splice(0, st.cur); st.cur = 0; return;
        case 'kill-line': st.chars.splice(st.cur); return;
        case 'alt-r': case 'ctrl-r': st.reveal = !st.reveal; return;
        case 'text': case 'paste': {
          const add = [...key.text.replace(/[\r\n]+/g, ' ')];
          st.chars.splice(st.cur, 0, ...add);
          st.cur += add.length;
          st.error = '';
          return;
        }
        default:
      }
    },
  };
}

/** Read-only scrollable page (help, diff, long reports). lines: string[] (may contain colours). */
export function pagerWidget({ title, subtitle, lines, accent = ACCENT }) {
  const st = { top: 0 };
  return {
    cancelValue: null,
    render({ cols, rows }) {
      const inner = width(cols) - 2;
      const room = Math.max(4, Math.min(24, rows - 6));
      const wrapped = lines.flatMap((l) => (l === '' ? [''] : stringWidth(l) <= inner ? [l] : [clip(l, inner)]));
      st.max = Math.max(0, wrapped.length - room);
      st.top = Math.max(0, Math.min(st.top, st.max));
      const body = wrapped.slice(st.top, st.top + room);
      while (body.length < Math.min(room, wrapped.length)) body.push('');
      const pos = wrapped.length > room ? `${st.top + 1}-${Math.min(wrapped.length, st.top + room)}/${wrapped.length}` : '';
      return frame({ title, subtitle: subtitle ?? (pos ? dim(pos) : ''), body, accent, inner, hint: wrapped.length > room ? '↑/↓ scroll · PgUp/PgDn · g/G start/end · q or Enter close' : 'q, Enter or Esc to close' });
    },
    onKey(key, api) {
      const page = 10;
      switch (key.name) {
        case 'up': st.top -= 1; return;
        case 'down': st.top += 1; return;
        case 'pageup': st.top -= page; return;
        case 'pagedown': st.top += page; return;
        case 'home': st.top = 0; return;
        case 'end': st.top = st.max ?? 0; return;
        case 'enter': return api.done(true);
        case 'text':
          if (key.text === 'q') return api.done(true);
          if (key.text === 'g') st.top = 0;
          if (key.text === 'G') st.top = st.max ?? 0;
          if (key.text === 'j') st.top += 1;
          if (key.text === 'k') st.top -= 1;
          return;
        default:
      }
    },
  };
}

/** Yes/No confirmation as a small dialog. Resolves true/false. */
export function confirmWidget({ title, lines = [], yesLabel = 'Yes', noLabel = 'No', danger = false, accent = null }) {
  const paint = accent ?? (danger ? fg(203) : ACCENT);
  const st = { yes: !danger };
  return {
    cancelValue: false,
    render({ cols }) {
      const inner = width(cols) - 2;
      const body = [...lines.flatMap((l) => wrapCells(l, inner)), '', `${st.yes ? paint(bold(`${G.sel} ${yesLabel}`)) : dim(`  ${yesLabel}`)}   ${!st.yes ? paint(bold(`${G.sel} ${noLabel}`)) : dim(`  ${noLabel}`)}`];
      return frame({ title, body, accent: paint, inner, hint: 'y/n · ←/→ · Enter confirm · Esc cancel' });
    },
    onKey(key, api) {
      if (key.name === 'left' || key.name === 'right' || key.name === 'tab') st.yes = !st.yes;
      else if (key.name === 'enter') api.done(st.yes);
      else if (key.name === 'text' && /^y$/i.test(key.text)) api.done(true);
      else if (key.name === 'text' && /^n$/i.test(key.text)) api.done(false);
    },
  };
}
