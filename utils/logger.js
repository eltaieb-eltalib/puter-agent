// Tiny ANSI colour helper (no dependencies). Respects NO_COLOR and non-TTY output.

const enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (code) => (text) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : String(text));

export const color = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
};

export const log = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.log(color.yellow(msg)),
  error: (msg) => console.error(color.red(msg)),
  dim: (msg) => console.log(color.dim(msg)),
};

// ---------------------------------------------------------------- modern CLI helpers

const unicode =
  process.platform !== 'win32' || Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.ConEmuANSI) || process.env.TERM === 'xterm-256color';

export const sym = unicode
  ? { top: '╭─', mid: '│', bot: '╰─', dot: '●', ok: '✔', fail: '✖', arrow: '❯', ai: '◆', warn: '▲', sep: '·', frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] }
  : { top: '+-', mid: '|', bot: '+-', dot: '*', ok: 'v', fail: 'x', arrow: '>', ai: '#', warn: '!', sep: '-', frames: ['|', '/', '-', '\\'] };

export const gray = wrap(90);
export const teal = (t) => (enabled ? `\x1b[38;5;43m${t}\x1b[0m` : String(t));
export const violet = (t) => (enabled ? `\x1b[38;5;141m${t}\x1b[0m` : String(t));
export const orange = (t) => (enabled ? `\x1b[38;5;215m${t}\x1b[0m` : String(t));

/** Left-bordered card (no right border, so Arabic/wide text never breaks the layout). */
export function card(title, lines = [], footer = '', paint = teal) {
  const out = [`${paint(sym.top)} ${color.bold(title)}`];
  for (const l of lines) out.push(`${paint(sym.mid)} ${l}`);
  if (footer) out.push(`${paint(sym.bot)} ${footer}`);
  return out.join('\n');
}

/** Animated one-line spinner with elapsed time. No-op when stdout is not a terminal. */
export class Spinner {
  constructor(stream = process.stdout) {
    this.stream = stream;
    this.timer = null;
    this.label = '';
    this.startedAt = 0;
    this.frame = 0;
  }

  get active() {
    return this.timer !== null;
  }

  start(label) {
    this.label = label;
    if (!enabled) return;
    if (this.timer) return;
    this.startedAt = Date.now();
    this.stream.write('\x1b[?25l'); // hide cursor
    this.#draw();
    this.timer = setInterval(() => this.#draw(), 90);
  }

  update(label) {
    this.label = label;
  }

  #draw() {
    const secs = ((Date.now() - this.startedAt) / 1000).toFixed(0);
    const f = sym.frames[this.frame++ % sym.frames.length];
    this.stream.write(`\r\x1b[2K  ${violet(f)} ${this.label} ${gray(`${secs}s`)}`);
  }

  /** Stop and erase the line. Returns elapsed milliseconds. */
  stop() {
    const elapsed = this.startedAt ? Date.now() - this.startedAt : 0;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.stream.write('\r\x1b[2K\x1b[?25h');
    }
    return elapsed;
  }
}
