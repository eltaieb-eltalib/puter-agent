import { color, orange, teal, violet } from '../utils/logger.js';

// Puter Agent keeps its own visual identity; OpenCode-inspired interaction patterns
// are implemented in the terminal UI without adopting OpenCode branding.
export const THEMES = {
  puter: {
    assistant: violet,
    user: color.cyan,
    build: teal,
    plan: orange,
    meta: color.gray,
    ok: color.green,
    warn: color.yellow,
    err: color.red,
    accent: violet,
  },
};
THEMES.default = THEMES.puter;

export function resolveTheme(tui = {}) {
  const name = tui.theme || 'puter';
  return THEMES[name] ?? THEMES.puter;
}
