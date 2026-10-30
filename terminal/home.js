// The start screen: a big pixel logo (like opencode's), centred, with the prompt box under it.

const unicode =
  process.platform !== 'win32' || Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.ConEmuANSI) || process.env.TERM === 'xterm-256color';
const NO_COLOR = Boolean(process.env.NO_COLOR);
const paint = (n, s) => (NO_COLOR ? s : `\x1b[38;5;${n}m${s}\x1b[0m`);

// 4x5 pixel font for the letters we need.
const GLYPHS = {
  p: ['███.', '█..█', '███.', '█...', '█...'],
  u: ['█..█', '█..█', '█..█', '█..█', '.██.'],
  t: ['.█..', '████', '.█..', '.█..', '..██'],
  e: ['.██.', '█..█', '████', '█...', '.███'],
  r: ['███.', '█..█', '███.', '█.█.', '█..█'],
  a: ['.██.', '█..█', '████', '█..█', '█..█'],
  g: ['.███', '█...', '█.██', '█..█', '.███'],
  n: ['███.', '█..█', '█..█', '█..█', '█..█'],
};

function renderWord(word, shade) {
  const rows = ['', '', '', '', ''];
  for (const ch of word) {
    const g = GLYPHS[ch];
    for (let y = 0; y < 5; y++) rows[y] += `${g[y].replace(/█/g, unicode ? '█' : '#').replace(/\./g, ' ')} `;
  }
  return rows.map((r) => paint(shade, r));
}

/** Logo lines (no margin) and their visible width, or null when the terminal is too narrow. */
export function logoLines(cols) {
  const a = renderWord('puter', 245);
  const b = renderWord('agent', 255);
  const width = 5 * 5 + 5 * 5 - 1;
  if (cols < width + 2) return { lines: [paint(255, 'puter ') + paint(245, 'agent')], width: 12 };
  return { lines: a.map((row, i) => row + ' ' + b[i]), width };
}

export const centre = (text, visibleWidth, cols) => `${' '.repeat(Math.max(0, Math.floor((cols - visibleWidth) / 2)))}${text}`;
