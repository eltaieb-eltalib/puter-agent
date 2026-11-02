// Colour tokens for every TUI component. 256-colour ANSI, disabled by NO_COLOR or a non-TTY stdout.
// Components only use these names, so the whole look can be changed in one place.

const ESC = '\x1b[';
export const colorEnabled = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const enabled = colorEnabled();

const fg = (n) => (s) => (enabled ? `${ESC}38;5;${n}m${s}${ESC}39m` : String(s));
const sgr = (on, off) => (s) => (enabled ? `${ESC}${on}m${s}${ESC}${off}m` : String(s));

export const bold = sgr(1, 22);
export const italic = sgr(3, 23);
export const underline = sgr(4, 24);
export const dimmed = sgr(2, 22);

export const paint = {
  // brand + roles
  accent: fg(141), // violet
  accent2: fg(43), // teal
  warm: fg(215), // orange
  user: fg(117),
  muted: fg(245),
  faint: fg(240),
  ok: fg(78),
  warn: fg(221),
  err: fg(203),
  info: fg(111),
  // code
  keyword: fg(176),
  string: fg(150),
  number: fg(215),
  comment: (s) => (enabled ? `${ESC}3m${ESC}38;5;244m${s}${ESC}39m${ESC}23m` : String(s)),
  fn: fg(111),
  type: fg(180),
  prop: fg(117),
  punct: fg(248),
  add: fg(78),
  del: fg(203),
  meta: fg(141),
  code: fg(222), // inline code
  link: (s) => (enabled ? `${ESC}4m${ESC}38;5;75m${s}${ESC}39m${ESC}24m` : String(s)),
};

const unicode =
  process.platform !== 'win32' || Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.ConEmuANSI) || process.env.TERM === 'xterm-256color';

export const icons = unicode
  ? {
      ai: '◆', user: '❯', ok: '✔', fail: '✖', warn: '▲', dot: '●', ring: '○', half: '◐', bar: '│', thin: '─', arrow: '→', sep: '·', cache: '⚡', par: '⇉',
      read: '◇', write: '✎', run: '▶', web: '◎', plan: '☰', think: '◌', bullet: '•', sub: '◦', quote: '▌',
      corner: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
      spark: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
      frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    }
  : {
      ai: '#', user: '>', ok: 'v', fail: 'x', warn: '!', dot: '*', ring: 'o', half: '~', bar: '|', thin: '-', arrow: '->', sep: '-', cache: '*', par: '=',
      read: 'r', write: 'w', run: '>', web: '@', plan: '=', think: '.', bullet: '*', sub: '-', quote: '|',
      corner: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' },
      spark: ['_', '.', '-', '=', '+', '*', '#', '#'],
      frames: ['|', '/', '-', '\\'],
    };

export const cols = () => Math.max(20, process.stdout.columns || 80);
