// Markdown -> terminal. Block-level parser (fences first, so nothing inside code is reinterpreted),
// inline styles, tables, nested/task lists, quotes, rules, and highlighted code blocks.
// Paragraphs are wrapped by cell width and right-aligned when they are Arabic/Hebrew (see text.js).

import { bold, icons, italic, paint } from './style.js';
import { highlight, normalizeLang } from './highlight.js';
import { clipCells, isRtl, layout, stringWidth, stripAnsi, wrapAnsi, alignRight } from './text.js';

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s*(?:[-*_]\s*){3,}$/;
const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Inline markdown: code spans are protected first, then links, bold, italic, strike. */
export function renderInline(text) {
  const codes = [];
  let s = String(text).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(paint.code(c));
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s
    .replace(/!?\[([^\]]+)\]\((\S+?)(?:\s+"[^"]*")?\)/g, (_, label, url) => (label === url ? paint.link(url) : `${label} ${paint.muted(`(${paint.link(url)})`)}`))
    .replace(/(^|[\s(])(https?:\/\/[^\s)]+)/g, (_, pre, url) => `${pre}${paint.link(url)}`)
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => bold(a ?? b))
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, (_, pre, t) => `${pre}${italic(t)}`)
    .replace(/(^|[^\w_])_([^_\s][^_]*?)_(?!\w)/g, (_, pre, t) => `${pre}${italic(t)}`)
    .replace(/~~([^~]+)~~/g, (_, t) => paint.faint(t));
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

function codeBlock(lines, lang, width, { highlightCode = true } = {}) {
  const c = icons.corner;
  const l = normalizeLang(lang);
  const label = l ? ` ${lang} ` : ' code ';
  const inner = Math.max(10, width - 4);
  const body = highlightCode ? highlight(lines.join('\n'), l) : lines;
  const numbered = lines.length > 3;
  const gutterW = numbered ? String(lines.length).length : 0;
  const out = [paint.faint(`${c.tl}${c.h}`) + paint.muted(label) + paint.faint(c.h.repeat(Math.max(2, Math.min(inner, 40) - stringWidth(label))))];
  body.forEach((line, i) => {
    const gutter = numbered ? paint.faint(`${String(i + 1).padStart(gutterW)} `) : '';
    const parts = wrapAnsi(line, inner - (numbered ? gutterW + 1 : 0));
    parts.forEach((p, j) => out.push(`${paint.faint(c.v)} ${j === 0 ? gutter : numbered ? ' '.repeat(gutterW + 1) : ''}${p}`));
  });
  out.push(paint.faint(`${c.bl}${c.h.repeat(Math.max(2, Math.min(inner, 40)))}`));
  return out;
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
}

function table(rows, width) {
  const header = splitRow(rows[0]);
  const body = rows.slice(2).map(splitRow);
  const n = header.length;
  const cells = [header, ...body].map((r) => Array.from({ length: n }, (_, i) => renderInline(r[i] ?? '')));
  const widths = Array.from({ length: n }, (_, i) => Math.max(3, ...cells.map((r) => stringWidth(r[i]))));
  const total = widths.reduce((a, b) => a + b, 0) + 3 * n + 1;
  if (total > width) {
    // Too wide for the terminal: one "header: value" block per row.
    const out = [];
    for (const r of cells.slice(1)) {
      r.forEach((v, i) => out.push(...wrapAnsi(`${paint.muted(`${stripAnsi(cells[0][i])}:`)} ${v}`, width)));
      out.push(paint.faint(icons.thin.repeat(Math.min(width, 20))));
    }
    return out;
  }
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - stringWidth(s)));
  const v = paint.faint(icons.corner.v);
  const line = (l, m, r) => paint.faint(`${l}${widths.map((w) => icons.corner.h.repeat(w + 2)).join(m)}${r}`);
  const row = (r, head) => `${v} ${r.map((c, i) => pad(head ? bold(c) : c, widths[i])).join(` ${v} `)} ${v}`;
  const unicode = icons.corner.tl !== '+';
  return [
    line(icons.corner.tl, unicode ? '┬' : '+', icons.corner.tr),
    row(cells[0], true),
    line(unicode ? '├' : '+', unicode ? '┼' : '+', unicode ? '┤' : '+'),
    ...cells.slice(1).map((r) => row(r, false)),
    line(icons.corner.bl, unicode ? '┴' : '+', icons.corner.br),
  ];
}

/**
 * Render markdown for a terminal of `width` cells.
 * options: rtl ('auto' | 'on' | 'off'), highlight (true), indent (string prefix for every line)
 */
export function renderMarkdown(markdown, { width = (process.stdout.columns || 80) - 4, rtl = 'auto', highlight: highlightCode = true } = {}) {
  const src = String(markdown ?? '').replace(/\r\n/g, '\n').replace(/\t/g, '    ');
  const lines = src.split('\n');
  const out = [];
  const w = Math.max(20, width);
  let blank = 0;
  const push = (...ls) => {
    out.push(...ls);
    blank = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[2];
      const body = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith(marker)) body.push(lines[j++].replace(new RegExp(`^${fence[1]}`), ''));
      push(...codeBlock(body, fence[3], w, { highlightCode }));
      i = j; // skip closing fence (or end of text if unclosed)
      continue;
    }

    if (!line.trim()) {
      if (blank++ === 0 && out.length) out.push('');
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      const text = renderInline(h[2]);
      const rtlLine = rtl === 'on' || (rtl === 'auto' && isRtl(h[2]));
      const styled = level === 1 ? bold(paint.accent(text)) : level === 2 ? bold(paint.accent2(text)) : bold(text);
      if (out.length && out.at(-1) !== '') out.push('');
      push(rtlLine ? alignRight(styled, w) : styled);
      if (level === 1) push(paint.faint(icons.thin.repeat(Math.min(w, Math.max(8, stringWidth(h[2]))))));
      continue;
    }

    if (HR.test(line)) {
      push(paint.faint(icons.thin.repeat(Math.min(w, 48))));
      continue;
    }

    if (line.includes('|') && TABLE_SEP.test(lines[i + 1] ?? '')) {
      const rows = [line, lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && lines[j].trim()) rows.push(lines[j++]);
      push(...table(rows, w));
      i = j - 1;
      continue;
    }

    const q = QUOTE.exec(line);
    if (q) {
      for (const l of wrapAnsi(italic(renderInline(q[1])), w - 2)) push(`${paint.accent(icons.quote)} ${paint.muted(l)}`);
      continue;
    }

    const li = LIST.exec(line);
    if (li) {
      const depth = Math.floor(li[1].length / 2);
      const ordered = /\d/.test(li[2]);
      let text = li[3];
      let marker = ordered ? paint.accent2(li[2].replace(')', '.')) : paint.accent(depth % 2 ? icons.sub : icons.bullet);
      const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
      if (task) {
        marker = task[1] === ' ' ? paint.muted('☐') : paint.ok('☑');
        text = task[1] === ' ' ? task[2] : paint.muted(task[2]);
      }
      const indent = '  '.repeat(depth);
      const prefixW = stringWidth(indent) + stringWidth(stripAnsi(marker)) + 1;
      const rtlItem = rtl === 'on' || (rtl === 'auto' && isRtl(text));
      const wrapped = wrapAnsi(renderInline(text), w - prefixW);
      if (rtlItem) wrapped.forEach((l, k) => push(alignRight(k === 0 ? `${l} ${marker}` : l, w)));
      else wrapped.forEach((l, k) => push(`${indent}${k === 0 ? `${marker} ` : ' '.repeat(prefixW - stringWidth(indent))}${l}`));
      continue;
    }

    push(...layout(renderInline(line.trimEnd()), w, { rtl }));
  }
  while (out.length && out.at(-1) === '') out.pop();
  return out.join('\n');
}

/** Short, single-line preview of markdown text (status lines, history list). */
export const previewMarkdown = (md, max = 80) => clipCells(stripAnsi(renderInline(String(md ?? '').replace(/```[\s\S]*?```/g, '[code]').replace(/\s+/g, ' ').trim())), max);
