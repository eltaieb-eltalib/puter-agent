import { codeBlockRegex, inlineCodeRegex, headingRegex } from './regex.js';

// Minimal markdown rendering for terminal output.
// Goal: make markdown look formatted, not raw.

function stripAnsi(s){ return s.replace(/\x1b\[[0-9;]*m/g,''); }

function renderInline(text, { inlineCodeColor = '' } = {}) {
  // inline code: `code`
  return text.replace(inlineCodeRegex, (_, code) => {
    const c = code.trim();
    // Use backticks around code so it stays readable in plain terminal.
    return `[36m${c}[0m`;
  });
}

export function renderMarkdownToTerminal(markdown = '', colors = {}) {
  const input = String(markdown);
  const out = [];

  const lines = input.replace(/\r\n/g,'\n').split('\n');

  for (let i=0; i<lines.length; i++) {
    const line = lines[i];

    // headings
    const h = line.match(headingRegex);
    if (h) {
      const level = h[1].length;
      const text = renderInline(h[2].trim(), colors);
      const prefix = level === 1 ? '❖' : level === 2 ? '•' : '◦';
      out.push(`${prefix} ${text}`);
      continue;
    }

    // list bullets
    if (/^\s*[-*+]\s+/.test(line)) {
      out.push(`• ${renderInline(line.replace(/^\s*[-*+]\s+/, ''), colors)}`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const m = line.match(/^\s*(\d+)\.\s+(.*)$/);
      out.push(`${m[1]}. ${renderInline(m[2], colors)}`);
      continue;
    }

    // blockquote
    if (/^\s*>\s+/.test(line)) {
      out.push(`┃ ${renderInline(line.replace(/^\s*>\s+/, ''), colors)}`);
      continue;
    }

    out.push(renderInline(line, colors));
  }

  // code fences: handle separately to preserve blocks
  // We'll do a pass that replaces fenced blocks.
  const rendered = out.join('\n');

  // If there are fenced blocks, re-render them in one go (simple):
  // Replace ```lang\n...\n``` with a bordered code block.
  return rendered.replace(codeBlockRegex, (m, lang, code) => {
    const l = (lang || '').trim();
    const body = code.replace(/\n$/, '');
    const header = l ? ` [${l}] ` : ' code ';
    const top = '─'.repeat(Math.max(10, header.length + 2));
    return `\n${top}\n${header}\n${top}\n\u001b[33m${body}\u001b[0m\n${top}\n`;
  });
}
