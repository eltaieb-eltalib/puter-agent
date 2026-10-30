// Interactive input for the terminal UI (no dependencies).
//
//  * opencode-style prompt box: dark panel + coloured accent bar, placeholder, mode/model line
//  * PASTE is safe: bracketed-paste support (and a fallback for terminals without it), so a
//    multi-line paste lands in the box as text and is NOT executed line by line. You press Enter.
//    Long pastes collapse to a chip like "[Pasted text #1 +12 lines]" and are expanded on send.
//  * multi-line editing (Ctrl+J / Alt+Enter / Shift+Enter, or end a line with "\"), history (↑/↓),
//    word/line editing keys, slash-command menu (type "/", ↑/↓, Tab/Enter), Shift+Tab = plan/build
//  * non-TTY stdin (pipes, CI) falls back to plain readline automatically.

import readline from 'node:readline/promises';

const ESC = '\x1b';
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

const NO_COLOR = Boolean(process.env.NO_COLOR);
const unicode =
  process.platform !== 'win32' || Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.ConEmuANSI) || process.env.TERM === 'xterm-256color';

const BAR = unicode ? '┃' : '|';
const BG = NO_COLOR ? '' : `${ESC}[48;5;236m`;
const RESET = `${ESC}[0m`;
const fg = (n) => (s) => (NO_COLOR ? String(s) : `${ESC}[38;5;${n}m${s}${RESET}`);
const dim = fg(244);
const faint = fg(240);
const bold = (s) => (NO_COLOR ? String(s) : `${ESC}[1m${s}${RESET}`);

// ------------------------------------------------------------------ text helpers

/** Terminal cell width of one code point (0 for combining marks / Arabic harakat, 2 for CJK/emoji). */
export function charWidth(cp) {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x483 && cp <= 0x489) ||
    (cp >= 0x591 && cp <= 0x5bd) ||
    (cp >= 0x610 && cp <= 0x61a) ||
    (cp >= 0x64b && cp <= 0x65f) ||
    cp === 0x670 ||
    (cp >= 0x6d6 && cp <= 0x6dc) ||
    (cp >= 0x6df && cp <= 0x6e4) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    (cp >= 0xfe00 && cp <= 0xfe0f)
  ) {
    return 0;
  }
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s) => String(s).replace(ANSI_RE, '');
export function stringWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0));
  return w;
}

/** Cut a (possibly coloured) string to `max` cells, adding "…". */
function clip(s, max) {
  if (stringWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  const parts = String(s).split(/(\x1b\[[0-9;?]*[ -/]*[@-~])/);
  for (const part of parts) {
    if (/^\x1b\[/.test(part)) {
      out += part;
      continue;
    }
    for (const ch of part) {
      const cw = charWidth(ch.codePointAt(0));
      if (w + cw > max - 1) return `${out}…${RESET}`;
      out += ch;
      w += cw;
    }
  }
  return out;
}

/** Split a char array into visual rows: [{start, end}] (end exclusive, newline excluded). */
function layoutRows(chars, width) {
  const rows = [];
  let start = 0;
  let col = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '\n') {
      rows.push({ start, end: i });
      start = i + 1;
      col = 0;
      continue;
    }
    const w = charWidth(ch.codePointAt(0));
    if (col + w > width && i > start) {
      rows.push({ start, end: i });
      start = i;
      col = 0;
    }
    col += w;
  }
  rows.push({ start, end: chars.length });
  return rows;
}

const rowWidth = (chars, row) => {
  let w = 0;
  for (let i = row.start; i < row.end; i++) w += charWidth(chars[i].codePointAt(0));
  return w;
};

function sanitizePaste(text) {
  return String(text)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

// ------------------------------------------------------------------ plain fallback (no TTY)

class PlainInput {
  constructor({ stdin, stdout }) {
    this.isTTY = false;
    this.onExit = () => process.exit(0);
    this.onAbort = () => {};
    this.rl = readline.createInterface({ input: stdin, output: stdout, terminal: false });
    this.rl.on('close', () => this.onExit());
  }
  attach() {}
  detach() {}
  async prompt() {
    try {
      return await this.rl.question('> ');
    } catch {
      return null;
    }
  }
  echo(text) {
    return `> ${text}`;
  }
  async question(text, opts = {}) {
    try {
      return await this.rl.question(`${text} `, opts.signal ? { signal: opts.signal } : undefined);
    } catch {
      return '';
    }
  }
  async choose(_title, choices) {
    const answer = (await this.question(`${choices.map((c) => `[${c.key}] ${c.label}`).join('  ')} >`)).trim().toLowerCase();
    return choices.find((c) => c.key === answer || c.aliases?.includes(answer))?.value ?? choices[choices.length - 1].value;
  }
  close() {
    this.rl.close();
  }
}

// ------------------------------------------------------------------ the real editor

export class InputBox {
  constructor({ stdin, stdout }) {
    this.stdin = stdin;
    this.stdout = stdout;
    this.isTTY = true;
    this.attached = false;
    this.session = null; // the prompt currently on screen (or null while the agent works)
    this.pasting = null; // text collected between paste markers
    this.history = [];
    this.lastCtrlC = 0;
    this.onAbort = () => {}; // Ctrl+C while the agent is working
    this.onExit = () => process.exit(0); // Ctrl+C twice / Ctrl+D / close()
    this.onToggleMode = null; // Shift+Tab
    this.handleData = (chunk) => this.#onData(chunk);
    this.handleResize = () => this.session && this.#draw();
  }

  get cols() {
    return this.stdout.columns || 80;
  }
  get rows() {
    return this.stdout.rows || 24;
  }

  attach() {
    if (this.attached) return;
    this.attached = true;
    this.stdin.setRawMode(true);
    this.stdin.setEncoding('utf8');
    this.stdin.resume();
    this.stdin.on('data', this.handleData);
    this.stdout.on('resize', this.handleResize);
    this.stdout.write(`${ESC}[?2004h`); // bracketed paste on
    process.once('exit', () => this.detach());
  }

  detach() {
    if (!this.attached) return;
    this.attached = false;
    this.stdin.off('data', this.handleData);
    this.stdout.off('resize', this.handleResize);
    try {
      this.stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
    this.stdin.pause();
    this.stdout.write(`${ESC}[?2004l${ESC}[?25h`);
  }

  close() {
    this.detach();
    this.onExit();
  }

  clearScreen() {
    this.stdout.write(`${ESC}[2J${ESC}[3J${ESC}[H`);
  }

  // ---------------------------------------------------------------- public prompts

  /**
   * The main prompt box. Resolves with the text (pastes expanded) or null when closed.
   * opts: { state(): {accent, info, footerLeft, footerRight}, commands, margin, maxWidth, placeholder, title, echo }
   */
  prompt(opts = {}) {
    this.attach();
    return new Promise((resolve) => {
      this.session = {
        kind: 'prompt',
        opts,
        chars: [],
        cursor: 0,
        wantCol: null,
        scrollTop: 0,
        pastes: [],
        histIdx: -1,
        draft: '',
        menuIdx: 0,
        notice: '',
        drawn: false,
        cursorRow: 0,
        resolve,
      };
      this.#draw();
    });
  }

  /** One-line question in a small box (used by /model, ask_user ...). Resolves '' when cancelled. */
  async question(text, { signal } = {}) {
    const title = stripAnsi(String(text)).replace(/[:>❯\s]+$/, '');
    const answer = await this.prompt({
      title,
      placeholder: '',
      margin: 2,
      maxWidth: 90,
      simple: true,
      echo: false,
      accentColor: 214,
      signal,
    });
    return answer ?? '';
  }

  /** Inline choice row (←/→, Enter, or a hotkey). choices: [{key,label,value,aliases?}] */
  choose(title, choices, { signal } = {}) {
    this.attach();
    return new Promise((resolve) => {
      this.session = { kind: 'choose', title, choices, idx: 0, resolve, signal };
      this.#drawChoose();
    });
  }

  // ---------------------------------------------------------------- input parsing

  #onData(chunk) {
    let s = String(chunk);
    while (s.length) {
      if (this.pasting !== null) {
        const end = s.indexOf(PASTE_END);
        if (end === -1) {
          this.pasting += s;
          return;
        }
        const text = this.pasting + s.slice(0, end);
        this.pasting = null;
        this.#key({ name: 'paste', text });
        s = s.slice(end + PASTE_END.length);
        continue;
      }
      if (s.startsWith(PASTE_START)) {
        this.pasting = '';
        s = s.slice(PASTE_START.length);
        continue;
      }
      if (s[0] === ESC) {
        const m = s.match(/^\x1b(?:\[([0-9;?]*)([ -/]*)([@-~])|O([@-~]))/);
        if (m) {
          this.#key(this.#csiKey(m));
          s = s.slice(m[0].length);
        } else if (s.length > 1 && s[1] !== ESC) {
          const cp = String.fromCodePoint(s.codePointAt(1));
          this.#key({ name: cp === '\r' || cp === '\n' ? 'alt-enter' : `alt-${cp}` });
          s = s.slice(1 + cp.length);
        } else {
          this.#key({ name: 'escape' });
          s = s.slice(1);
        }
        continue;
      }
      let end = s.indexOf(ESC);
      if (end === -1) end = s.length;
      const run = s.slice(0, end);
      s = s.slice(end);
      // Terminal without bracketed paste: a big chunk with line breaks is a paste, not typing.
      if (run.length > 2 && /[\r\n]/.test(run) && !/^[\r\n]+$/.test(run)) {
        this.#key({ name: 'paste', text: run.replace(/[\r\n]+$/, '') });
        continue;
      }
      let text = '';
      const flush = () => {
        if (text) this.#key({ name: 'text', text });
        text = '';
      };
      for (const ch of run) {
        const code = ch.codePointAt(0);
        if (code >= 32 && code !== 127) {
          text += ch;
          continue;
        }
        flush();
        this.#key(this.#ctrlKey(ch));
      }
      flush();
    }
  }

  #ctrlKey(ch) {
    switch (ch) {
      case '\r':
        return { name: 'enter' };
      case '\n':
        return { name: 'newline' }; // Ctrl+J
      case '\t':
        return { name: 'tab' };
      case '\x7f':
      case '\b':
        return { name: 'backspace' };
      case '\x03':
        return { name: 'ctrl-c' };
      case '\x04':
        return { name: 'ctrl-d' };
      case '\x01':
        return { name: 'home' };
      case '\x05':
        return { name: 'end' };
      case '\x0b':
        return { name: 'kill-line' };
      case '\x15':
        return { name: 'kill-start' };
      case '\x17':
        return { name: 'kill-word' };
      case '\x0c':
        return { name: 'ctrl-l' };
      case '\x10':
        return { name: 'ctrl-p' };
      case '\x02':
        return { name: 'left' };
      case '\x06':
        return { name: 'right' };
      default:
        return { name: 'ignore' };
    }
  }

  #csiKey(m) {
    const params = m[1] ?? '';
    const final = m[3] ?? m[4];
    const nums = params.split(';').map((n) => Number(n) || 0);
    const ctrl = (nums[1] ?? 0) >= 5;
    const shift = (nums[1] ?? 0) === 2;
    // Shift+Enter as sent by kitty / modifyOtherKeys terminals
    if (final === 'u' && nums[0] === 13) return { name: shift || (nums[1] ?? 1) > 1 ? 'newline' : 'enter' };
    if (final === '~' && nums[0] === 27 && nums[2] === 13) return { name: (nums[1] ?? 1) > 1 ? 'newline' : 'enter' };
    if (final === 'u') return { name: 'ignore' };
    switch (final) {
      case 'A':
        return { name: 'up' };
      case 'B':
        return { name: 'down' };
      case 'C':
        return { name: ctrl ? 'word-right' : 'right' };
      case 'D':
        return { name: ctrl ? 'word-left' : 'left' };
      case 'H':
        return { name: 'home' };
      case 'F':
        return { name: 'end' };
      case 'Z':
        return { name: 'shift-tab' };
      case '~':
        return { name: { 1: 'home', 7: 'home', 4: 'end', 8: 'end', 3: 'delete', 5: 'pageup', 6: 'pagedown' }[nums[0]] ?? 'ignore' };
      default:
        return { name: 'ignore' };
    }
  }

  #key(key) {
    const s = this.session;
    if (!s) {
      if (key.name === 'ctrl-c') this.onAbort();
      return;
    }
    if (s.kind === 'choose') return this.#chooseKey(s, key);
    return this.#promptKey(s, key);
  }

  // ---------------------------------------------------------------- choose

  #chooseKey(s, key) {
    const finish = (value) => {
      this.session = null;
      this.stdout.write(`\r${ESC}[2K${ESC}[?25h`);
      s.resolve(value);
    };
    const last = s.choices[s.choices.length - 1];
    switch (key.name) {
      case 'left':
      case 'up':
      case 'shift-tab':
        s.idx = (s.idx + s.choices.length - 1) % s.choices.length;
        return this.#drawChoose();
      case 'right':
      case 'down':
      case 'tab':
        s.idx = (s.idx + 1) % s.choices.length;
        return this.#drawChoose();
      case 'enter':
        return finish(s.choices[s.idx].value);
      case 'escape':
        return finish(last.value);
      case 'ctrl-c':
        finish(last.value);
        return this.onAbort();
      case 'text': {
        const k = key.text.toLowerCase();
        const hit = s.choices.find((c) => c.key === k || c.aliases?.includes(k));
        if (hit) finish(hit.value);
        return;
      }
      default:
    }
  }

  #drawChoose() {
    const s = this.session;
    if (!s || s.kind !== 'choose') return;
    const items = s.choices.map((c, i) => {
      const label = ` ${c.label} `;
      return i === s.idx ? `${ESC}[48;5;215m${ESC}[38;5;234m${ESC}[1m${label}${RESET}` : dim(label);
    });
    this.stdout.write(`\r${ESC}[2K${ESC}[?25l  ${items.join('  ')}  ${faint('←/→ choose · Enter confirm')}`);
  }

  // ---------------------------------------------------------------- prompt editing

  #text(s) {
    return s.chars.join('');
  }

  #setText(s, text, cursor = null) {
    s.chars = Array.from(text);
    s.cursor = cursor ?? s.chars.length;
    s.wantCol = null;
  }

  #insert(s, text) {
    const add = Array.from(text);
    s.chars.splice(s.cursor, 0, ...add);
    s.cursor += add.length;
    s.wantCol = null;
    s.menuIdx = 0;
  }

  #menuItems(s) {
    const commands = s.opts.commands;
    if (!commands?.length) return [];
    const text = this.#text(s);
    if (!text.startsWith('/') || /\s/.test(text)) return [];
    const q = text.slice(1).toLowerCase();
    return commands.filter((c) => c.name.startsWith(q)).concat(commands.filter((c) => !c.name.startsWith(q) && c.name.includes(q) && q));
  }

  #wordLeft(s) {
    let i = s.cursor;
    while (i > 0 && /\s/.test(s.chars[i - 1])) i--;
    while (i > 0 && !/\s/.test(s.chars[i - 1])) i--;
    return i;
  }
  #wordRight(s) {
    let i = s.cursor;
    while (i < s.chars.length && /\s/.test(s.chars[i])) i++;
    while (i < s.chars.length && !/\s/.test(s.chars[i])) i++;
    return i;
  }

  #geometry(s) {
    const width = this.#innerWidth(s);
    const rows = layoutRows(s.chars, width);
    let row = 0;
    for (let i = 0; i < rows.length; i++) if (rows[i].start <= s.cursor) row = i;
    let col = 0;
    for (let i = rows[row].start; i < s.cursor; i++) col += charWidth(s.chars[i].codePointAt(0));
    return { width, rows, row, col };
  }

  #moveVertical(s, dir) {
    const g = this.#geometry(s);
    const target = g.row + dir;
    if (target < 0 || target >= g.rows.length) return false;
    const want = s.wantCol ?? g.col;
    const r = g.rows[target];
    let col = 0;
    let i = r.start;
    while (i < r.end && col + charWidth(s.chars[i].codePointAt(0)) <= want) {
      col += charWidth(s.chars[i].codePointAt(0));
      i++;
    }
    s.cursor = i;
    s.wantCol = want;
    return true;
  }

  #submit(s) {
    let text = this.#text(s);
    // A trailing backslash continues on the next line instead of sending.
    if (text.endsWith('\\') && !text.endsWith('\\\\')) {
      s.chars.pop();
      s.chars.push('\n');
      s.cursor = s.chars.length;
      return this.#draw();
    }
    for (const p of s.pastes) text = text.split(p.chip).join(p.text);
    text = text.replace(/\s+$/, '');
    this.#finish(s, text);
  }

  #finish(s, value) {
    this.session = null;
    const shown = this.#text(s);
    if (s.drawn) this.stdout.write(`${s.cursorRow ? `${ESC}[${s.cursorRow}A` : ''}\r${ESC}[J`);
    if (s.opts.echo !== false && value) this.stdout.write(`${this.#echoPanel(s, shown)}\n`);
    if (value && s.opts.history !== false && this.history[0] !== value) this.history.unshift(value);
    s.resolve(value);
  }

  /** How a sent message stays on screen: a dark panel with the accent bar. */
  echo(text, opts = {}) {
    return this.#echoPanel({ opts }, text);
  }

  #echoPanel(s, text) {
    const st = s.opts.state?.() ?? {};
    const accent = st.accent ?? fg(215);
    const margin = ' '.repeat(s.opts.margin ?? 2);
    const width = this.#innerWidth(s);
    const chars = Array.from(text);
    const all = layoutRows(chars, width);
    const rows = all.length > 14 ? all.slice(0, 12) : all;
    const pad = this.#boxLine(accent, '', width, margin);
    const body = rows.map((r) => this.#boxLine(accent, chars.slice(r.start, r.end).join(''), width, margin));
    if (rows.length < all.length) body.push(this.#boxLine(accent, dim(`… ${all.length - rows.length} more lines`), width, margin));
    return [pad, ...body, pad].join('\n');
  }

  #promptKey(s, key) {
    const menu = this.#menuItems(s);
    const menuOpen = menu.length > 0;
    s.notice = key.name === 'ctrl-c' ? s.notice : '';
    switch (key.name) {
      case 'text':
        this.#insert(s, key.text);
        break;
      case 'paste': {
        const text = sanitizePaste(key.text).replace(/\n+$/, '');
        if (!text) break;
        const lines = text.split('\n').length;
        if (s.opts.simple) {
          this.#insert(s, text.replace(/\n+/g, ' '));
        } else if (lines > 3 || text.length > 400) {
          const chip = `[Pasted text #${s.pastes.length + 1} +${lines} line${lines === 1 ? '' : 's'}]`;
          s.pastes.push({ chip, text });
          this.#insert(s, chip);
        } else {
          this.#insert(s, text);
        }
        break;
      }
      case 'enter':
        if (menuOpen) {
          const text = this.#text(s);
          const pick = menu[Math.min(s.menuIdx, menu.length - 1)];
          if (text.slice(1).toLowerCase() !== pick.name) {
            this.#setText(s, `/${pick.name}${pick.takesArg ? ' ' : ''}`);
            if (pick.takesArg) break;
          }
        }
        return this.#submit(s);
      case 'newline':
      case 'alt-enter':
        if (!s.opts.simple) this.#insert(s, '\n');
        break;
      case 'tab':
        if (menuOpen) {
          const pick = menu[Math.min(s.menuIdx, menu.length - 1)];
          this.#setText(s, `/${pick.name}${pick.takesArg ? ' ' : ''}`);
        }
        break;
      case 'shift-tab':
        this.onToggleMode?.();
        break;
      case 'backspace':
        if (s.cursor > 0) {
          s.chars.splice(s.cursor - 1, 1);
          s.cursor--;
          s.wantCol = null;
          s.menuIdx = 0;
        }
        break;
      case 'delete':
        if (s.cursor < s.chars.length) s.chars.splice(s.cursor, 1);
        break;
      case 'left':
        s.cursor = Math.max(0, s.cursor - 1);
        s.wantCol = null;
        break;
      case 'right':
        s.cursor = Math.min(s.chars.length, s.cursor + 1);
        s.wantCol = null;
        break;
      case 'word-left':
        s.cursor = this.#wordLeft(s);
        s.wantCol = null;
        break;
      case 'word-right':
        s.cursor = this.#wordRight(s);
        s.wantCol = null;
        break;
      case 'home': {
        const g = this.#geometry(s);
        s.cursor = g.rows[g.row].start;
        s.wantCol = null;
        break;
      }
      case 'end': {
        const g = this.#geometry(s);
        s.cursor = g.rows[g.row].end;
        s.wantCol = null;
        break;
      }
      case 'kill-line': {
        const g = this.#geometry(s);
        s.chars.splice(s.cursor, g.rows[g.row].end - s.cursor || (s.chars[s.cursor] === '\n' ? 1 : 0));
        break;
      }
      case 'kill-start': {
        const g = this.#geometry(s);
        const start = g.rows[g.row].start;
        s.chars.splice(start, s.cursor - start);
        s.cursor = start;
        break;
      }
      case 'kill-word': {
        const to = this.#wordLeft(s);
        s.chars.splice(to, s.cursor - to);
        s.cursor = to;
        break;
      }
      case 'up':
        if (menuOpen) {
          s.menuIdx = (s.menuIdx + menu.length - 1) % menu.length;
        } else if (!this.#moveVertical(s, -1)) {
          this.#history(s, 1);
        }
        break;
      case 'down':
        if (menuOpen) {
          s.menuIdx = (s.menuIdx + 1) % menu.length;
        } else if (!this.#moveVertical(s, 1)) {
          this.#history(s, -1);
        }
        break;
      case 'pageup':
        for (let i = 0; i < 5; i++) this.#moveVertical(s, -1);
        break;
      case 'pagedown':
        for (let i = 0; i < 5; i++) this.#moveVertical(s, 1);
        break;
      case 'ctrl-p':
        if (!s.chars.length && s.opts.commands?.length) this.#setText(s, '/');
        break;
      case 'ctrl-l':
        this.clearScreen();
        s.drawn = false;
        break;
      case 'escape':
        if (menuOpen || s.chars.length) {
          this.#setText(s, '');
          s.pastes = [];
        }
        break;
      case 'ctrl-d':
        if (!s.chars.length) {
          this.#finish(s, null);
          this.onExit();
          return;
        }
        if (s.cursor < s.chars.length) s.chars.splice(s.cursor, 1);
        break;
      case 'ctrl-c': {
        if (s.chars.length) {
          this.#setText(s, '');
          s.pastes = [];
          break;
        }
        if (s.opts.simple) {
          this.#finish(s, '');
          this.onAbort();
          return;
        }
        const now = Date.now();
        if (now - this.lastCtrlC < 2000) {
          this.#finish(s, null);
          this.onExit();
          return;
        }
        this.lastCtrlC = now;
        s.notice = 'Press Ctrl+C again to exit';
        break;
      }
      default:
    }
    if (this.session === s) this.#draw();
  }

  #history(s, dir) {
    if (!this.history.length || s.opts.history === false) return;
    if (s.histIdx === -1 && dir > 0) s.draft = this.#text(s);
    const next = s.histIdx + dir;
    if (next < -1 || next >= this.history.length) return;
    s.histIdx = next;
    this.#setText(s, next === -1 ? s.draft : this.history[next]);
  }

  // ---------------------------------------------------------------- drawing

  #innerWidth(s) {
    const margin = s.opts.margin ?? 2;
    const boxW = Math.max(24, Math.min(s.opts.maxWidth ?? 100, this.cols - margin * 2 - 1));
    return boxW - 5; // bar + 2 spaces each side
  }

  #boxLine(accent, content, innerWidth, margin) {
    const padding = ' '.repeat(Math.max(0, innerWidth - stringWidth(content)));
    const body = `${content}${padding}`.split(RESET).join(`${RESET}${BG}`);
    return `${margin}${accent(BAR)}${BG}  ${body}  ${RESET}`;
  }

  #draw() {
    const s = this.session;
    if (!s || s.kind !== 'prompt') return;
    const st = s.opts.state?.() ?? {};
    const accent = st.accent ?? fg(s.opts.accentColor ?? 215);
    const margin = ' '.repeat(s.opts.margin ?? 2);
    const g = this.#geometry(s);
    const { width } = g;
    const maxRows = Math.max(3, Math.min(10, this.rows - 8));

    if (g.row < s.scrollTop) s.scrollTop = g.row;
    if (g.row >= s.scrollTop + maxRows) s.scrollTop = g.row - maxRows + 1;
    s.scrollTop = Math.max(0, Math.min(s.scrollTop, Math.max(0, g.rows.length - maxRows)));
    const visible = g.rows.slice(s.scrollTop, s.scrollTop + maxRows);

    const lines = [];
    const boxLine = (content) => this.#boxLine(accent, content, width, margin);
    lines.push(boxLine(''));
    if (s.opts.title) lines.push(boxLine(accent(bold(clip(s.opts.title, width)))));
    const firstTextLine = lines.length;
    const placeholder = s.opts.placeholder ?? 'Ask anything… "Fix broken tests"';
    visible.forEach((r, i) => {
      const text = s.chars.slice(r.start, r.end).join('');
      if (!s.chars.length && i === 0 && placeholder) lines.push(boxLine(dim(clip(placeholder, width))));
      else lines.push(boxLine(text));
    });
    if (st.info) {
      lines.push(boxLine(''));
      lines.push(boxLine(clip(st.info, width)));
    }
    lines.push(boxLine(''));

    // footer: left (folder) ... right (key hints) or the transient notice
    const boxW = width + 5;
    const left = st.footerLeft ?? '';
    const right = s.notice ? fg(215)(s.notice) : (st.footerRight ?? '');
    if (left || right) {
      const lw = stringWidth(left);
      const rw = stringWidth(right);
      const room = boxW - lw - rw;
      const l = room >= 2 ? left : clip(left, Math.max(8, boxW - rw - 2));
      const gap = Math.max(2, boxW - stringWidth(l) - rw);
      lines.push(`${margin}${l}${' '.repeat(gap)}${right}`);
    }

    // slash-command menu
    const menu = this.#menuItems(s);
    if (menu.length) {
      const sel = Math.min(s.menuIdx, menu.length - 1);
      const size = 7;
      const from = Math.max(0, Math.min(sel - Math.floor(size / 2), menu.length - size));
      const slice = menu.slice(from, from + size);
      const nameW = Math.min(24, Math.max(...menu.map((c) => c.usage.length)) + 2);
      lines.push('');
      slice.forEach((c, i) => {
        const on = from + i === sel;
        const label = (c.usage.length > nameW - 1 ? `${c.usage.slice(0, nameW - 2)}…` : c.usage).padEnd(nameW);
        const text = clip(`${label}${c.description}`, boxW - 2);
        lines.push(`${margin}${on ? accent(`▸ ${bold(text)}`) : dim(`  ${text}`)}`);
      });
      if (menu.length > from + size) lines.push(`${margin}${faint(`  … ${menu.length - from - size} more`)}`);
    }

    // cursor placement
    const cursorLine = firstTextLine + (g.row - s.scrollTop);
    const cursorCol = margin.length + 3 + g.col;

    let out = '';
    if (s.drawn && s.cursorRow > 0) out += `${ESC}[${s.cursorRow}A`;
    out += `\r${ESC}[J${lines.join('\n')}`;
    const up = lines.length - 1 - cursorLine;
    if (up > 0) out += `${ESC}[${up}A`;
    out += `${ESC}[${cursorCol + 1}G${ESC}[?25h`;
    this.stdout.write(out);
    s.drawn = true;
    s.cursorRow = cursorLine;
  }
}

export function createInput({ stdin, stdout }) {
  return stdin.isTTY && typeof stdin.setRawMode === 'function' ? new InputBox({ stdin, stdout }) : new PlainInput({ stdin, stdout });
}
