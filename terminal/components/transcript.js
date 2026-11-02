// Scrollback store: every user message, answer and tool step of the session is kept (bounded) so
// /history can reopen it in a scrollable pager, independent of the terminal's own scrollback size.

import { renderMarkdown } from './markdown.js';
import { bold, icons, paint } from './style.js';

const MAX_ENTRIES = 400;

export class Transcript {
  constructor({ maxEntries = MAX_ENTRIES } = {}) {
    this.maxEntries = maxEntries;
    this.entries = [];
  }

  add(role, text, meta = {}) {
    this.entries.push({ role, text: String(text ?? ''), at: Date.now(), ...meta });
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
  }

  clear() {
    this.entries = [];
  }

  get size() {
    return this.entries.length;
  }

  /** Render for the pager at the current width (re-rendered each time, so it follows resizes). */
  lines({ width = (process.stdout.columns || 80) - 6, rtl = 'auto' } = {}) {
    const out = [];
    for (const e of this.entries) {
      const time = paint.faint(new Date(e.at).toLocaleTimeString());
      if (e.role === 'user') {
        out.push('', `${paint.user(bold(`${icons.user} You`))} ${time}`, ...renderMarkdown(e.text, { width, rtl }).split('\n').map((l) => `  ${l}`));
      } else if (e.role === 'assistant') {
        out.push('', `${paint.accent(bold(`${icons.ai} Agent`))} ${time}`, ...renderMarkdown(e.text, { width, rtl }).split('\n').map((l) => `  ${l}`));
      } else if (e.role === 'tool') {
        out.push(`  ${paint.muted(e.text)}`);
      } else {
        out.push(`  ${paint.faint(e.text)}`);
      }
    }
    return out.length ? out : [paint.muted('Nothing yet.')];
  }
}
