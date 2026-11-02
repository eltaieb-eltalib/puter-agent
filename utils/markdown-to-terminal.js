// Kept for compatibility: the terminal markdown renderer now lives in terminal/components/markdown.js
// (fence-aware parsing, tables, task lists, syntax highlighting, RTL alignment).
import { renderMarkdown } from '../terminal/components/markdown.js';

export function renderMarkdownToTerminal(markdown = '', options = {}) {
  return renderMarkdown(markdown, options);
}
