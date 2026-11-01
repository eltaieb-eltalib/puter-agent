// Puter Agent signature terminal identity: luminous wordmark + compact command cockpit.
const ESC = '\x1b[';
const NO_COLOR = Boolean(process.env.NO_COLOR);
const unicode = process.platform !== 'win32' || Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.ConEmuANSI) || process.env.TERM === 'xterm-256color';
const paint = (code, value) => NO_COLOR ? String(value) : `${ESC}38;5;${code}m${value}${ESC}0m`;
const dim = (value) => paint(244, value);
const bold = (value) => NO_COLOR ? String(value) : `${ESC}1m${value}${ESC}22m`;

const GLYPHS = {
  p: ['████ ', '█   █', '████ ', '█    ', '█    '],
  u: ['█   █', '█   █', '█   █', '█   █', ' ███ '],
  t: ['  █  ', '█████', '  █  ', '  █  ', '   ██'],
  e: [' ███ ', '█   █', '█████', '█    ', ' ████'],
  r: ['████ ', '█   █', '████ ', '█ █  ', '█  ██'],
  a: [' ███ ', '█   █', '█████', '█   █', '█   █'],
  g: [' ████', '█    ', '█ ███', '█   █', ' ████'],
  n: ['████ ', '█   █', '█   █', '█   █', '█   █'],
};

function wordRows(word) {
  const rows = Array.from({ length: 5 }, () => '');
  for (const ch of word) for (let i = 0; i < 5; i++) rows[i] += `${GLYPHS[ch][i]} `;
  return rows;
}

export function logoLines(cols) {
  const left = wordRows('puter');
  const right = wordRows('agent');
  const lines = left.map((row, i) => `${paint(45, row)}  ${paint(213, right[i])}`);
  const width = 5 * 6 + 2 + 5 * 6;
  if (cols < width + 4) return { lines: [bold(paint(45, 'PUTER')) + ' ' + bold(paint(213, 'AGENT'))], width: 11 };
  return { lines, width };
}

export function centre(text, visibleWidth, cols) {
  return `${' '.repeat(Math.max(0, Math.floor((cols - visibleWidth) / 2)))}${text}`;
}

export function homePanel({ cols = 80, version, model, provider, mode, folder }) {
  const width = Math.max(34, Math.min(76, cols - 8));
  const line = (s = '') => `  ${paint(238, '│')} ${s}`;
  const top = `  ${paint(45, '╭')}${paint(45, '─'.repeat(width))}${paint(45, '╮')}`;
  const bottom = `  ${paint(45, '╰')}${paint(45, '─'.repeat(width))}${paint(45, '╯')}`;
  const pad = line('');
  const content = [
    top,
    line(`${bold(paint(255, 'YOUR AI WORKSPACE'))}  ${dim(`v${version}`)}`),
    pad,
    line(`${paint(45, '◆')}  ${bold('Ready when you are.')}`),
    line(dim('Describe a task, explore a codebase, or ask for a plan.')),
    pad,
    line(`${paint(213, 'MODEL')}   ${bold(model || 'not selected')}`),
    line(`${paint(213, 'ENGINE')}  ${provider || 'Puter'}   ${paint(213, 'MODE')}  ${mode || 'build'}`),
    line(`${paint(213, 'ROOT')}   ${dim(folder || '.')}`),
    pad,
    line(`${paint(45, ' /menu')}  ${dim('all pages')}   ${dim(' /connect')}  ${dim('provider')}   ${dim(' /model')}  ${dim('model')}   ${dim(' /help')}  ${dim('keys')}`),
    bottom,
  ];
  return content.join('\n');
}
