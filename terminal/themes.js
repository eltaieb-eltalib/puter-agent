import { color, orange, teal, violet } from '../utils/logger.js';

// build/plan = accent colour of the prompt box (bar + mode label) in each mode.
export const THEMES = {
  opencode: {
    assistant: violet,
    user: color.cyan,
    build: teal,
    plan: orange,
    meta: color.gray,
    ok: color.green,
    warn: color.yellow,
    err: color.red,
  },
};
THEMES.default = THEMES.opencode;

export function resolveTheme(tui = {}) {
  const name = tui.theme || 'default';
  return THEMES[name] ?? THEMES.default;
}
