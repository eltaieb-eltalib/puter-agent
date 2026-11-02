// Smart previews of what the agent is writing, in the style of a code review:
//
//   ← Edit .env  +2 -1
//    1 - DJANGO_DEBUG=FlTrue                (red background)
//    1 + DJANGO_DEBUG=True                  (green background)
//    2 + DJANGO_SECRET_KEY=dev-only…
//    3   DJANGO_VITE_DEV_MODE=True          (context)
//
// "Smart" = the user always sees WHERE and WHAT changed, but never a wall of text: long unchanged
// runs collapse to "⋯", lines are clipped (not wrapped) to the terminal width, and the number of
// lines adapts to the terminal height (a phone screen gets fewer lines than a desktop).

import { highlight } from './highlight.js';
import { bold, colorEnabled, icons, paint } from './style.js';
import { clipCells, stringWidth } from './text.js';

const enabled = colorEnabled();
const bg = (n) => (s) => (enabled ? `\x1b[48;5;${n}m${s}\x1b[49m` : String(s));
const delBg = bg(52);
const addBg = bg(22);

const EXT_LANG = { js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'ts', tsx: 'ts', py: 'py', go: 'go', rs: 'rs', java: 'java', kt: 'java', cs: 'java', c: 'c', h: 'c', cpp: 'c', php: 'php', rb: 'rb', sh: 'sh', bash: 'sh', json: 'json', html: 'html', htm: 'html', vue: 'html', css: 'css', scss: 'css', sql: 'sql', yml: 'yaml', yaml: 'yaml', env: 'sh', toml: 'sh', ini: 'sh' };
export const langOfPath = (p) => {
  const base = String(p ?? '').split(/[\\/]/).pop().toLowerCase();
  if (base.startsWith('.env')) return 'sh';
  return EXT_LANG[base.split('.').pop()] ?? '';
};

/** How many body lines a preview may use: settings value, reduced on short terminals. */
export function previewBudget({ max = 14, rows = process.stdout.rows || 40 } = {}) {
  return Math.max(4, Math.min(max, Math.floor(rows * 0.3)));
}

/**
 * Line diff. Exact LCS for normal sizes; for huge inputs it falls back to trimming the common
 * start/end (cheap, still correct, just less minimal).
 * Returns [{ op: ' ' | '-' | '+', text, a?, b? }] with 1-based line numbers in old (a) / new (b).
 */
export function lineDiff(before, after) {
  const a = String(before ?? '').replace(/\r\n/g, '\n').split('\n');
  const b = String(after ?? '').replace(/\r\n/g, '\n').split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out = [];
  for (let i = 0; i < start; i++) out.push({ op: ' ', text: a[i], a: i + 1, b: i + 1 });
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length <= 250000) {
    // LCS table on the changed middle only
    const n = midA.length;
    const m = midB.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        out.push({ op: ' ', text: midA[i], a: start + i + 1, b: start + j + 1 });
        i++;
        j++;
      } else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) {
        out.push({ op: '-', text: midA[i], a: start + i + 1 }); // removals before additions
        i++;
      } else {
        out.push({ op: '+', text: midB[j], b: start + j + 1 });
        j++;
      }
    }
  } else {
    midA.forEach((t, k) => out.push({ op: '-', text: t, a: start + k + 1 }));
    midB.forEach((t, k) => out.push({ op: '+', text: t, b: start + k + 1 }));
  }
  for (let k = 0; endA + k < a.length; k++) out.push({ op: ' ', text: a[endA + k], a: endA + k + 1, b: endB + k + 1 });
  return out;
}

/** Keep changed lines plus `context` lines around them; longer unchanged runs become a gap marker. */
function focus(diff, context) {
  const keep = new Uint8Array(diff.length);
  diff.forEach((d, i) => {
    if (d.op === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(diff.length - 1, i + context); k++) keep[k] = 1;
  });
  const out = [];
  let gap = 0;
  diff.forEach((d, i) => {
    if (keep[i]) {
      if (gap) out.push({ gap });
      gap = 0;
      out.push(d);
    } else gap++;
  });
  return out;
}

const header = (verb, path, extra = '', ok = true) => `  ${ok ? paint.warm(icons.write) : paint.err(icons.fail)} ${bold(verb)} ${path}${extra ? `  ${extra}` : ''}`;

function stats(diff) {
  const add = diff.filter((d) => d.op === '+').length;
  const del = diff.filter((d) => d.op === '-').length;
  return `${add ? paint.ok(`+${add}`) : ''}${add && del ? ' ' : ''}${del ? paint.err(`-${del}`) : ''}`;
}

/** Render a focused diff block. `offset` shifts line numbers when the texts are a slice of a file. */
export function renderDiff(diff, { path = '', lang = langOfPath(path), width = process.stdout.columns || 80, maxLines = previewBudget(), context = 1, offset = 0 } = {}) {
  const body = focus(diff, context);
  const numW = String(Math.max(1, ...diff.map((d) => (d.b ?? d.a ?? 0) + offset))).length;
  const inner = Math.max(16, width - 4);
  const lines = [];
  let shown = 0;
  let hiddenChanges = 0;
  for (const d of body) {
    if (shown >= maxLines) {
      if (!d.gap && d.op !== ' ') hiddenChanges++;
      continue;
    }
    if (d.gap) {
      lines.push(paint.faint(`  ${' '.repeat(numW)}   ⋯ ${d.gap} unchanged line${d.gap === 1 ? '' : 's'}`));
      shown++;
      continue;
    }
    const num = String((d.op === '-' ? d.a : d.b) + offset).padStart(numW);
    const code = highlight(d.text, lang)[0] ?? '';
    const raw = ` ${num} ${d.op} ${code}`;
    const fitted = clipCells(raw, inner).replace(/\x1b\[0m/g, '\x1b[39m\x1b[22m\x1b[23m\x1b[24m'); // keep the background
    const padded = fitted + ' '.repeat(Math.max(0, inner - stringWidth(fitted)));
    if (d.op === '-') lines.push(`  ${delBg(paint.err(padded.slice(0, 1 + numW + 3)) + padded.slice(1 + numW + 3))}`);
    else if (d.op === '+') lines.push(`  ${addBg(paint.ok(padded.slice(0, 1 + numW + 3)) + padded.slice(1 + numW + 3))}`);
    else lines.push(`  ${paint.faint(` ${num}  `)} ${clipCells(code, inner - numW - 4)}`);
    shown++;
  }
  if (hiddenChanges) lines.push(paint.faint(`  ${' '.repeat(numW)}   … ${hiddenChanges} more changed line${hiddenChanges === 1 ? '' : 's'}  /last`));
  return lines;
}

/** edit_file: diff of old_string -> new_string, numbered at the real line in the file. */
export function editPreview({ path, oldText, newText, startLine = 1, width, maxLines }) {
  const diff = lineDiff(oldText, newText);
  return [header('Edit', path, stats(diff)), ...renderDiff(diff, { path, width, maxLines, offset: Math.max(0, startLine - 1) })];
}

/** multi_edit: one small diff per edit, sharing the line budget. */
export function multiEditPreview({ path, edits = [], width, maxLines = previewBudget() }) {
  const diffs = edits.map((e) => lineDiff(e.old_string, e.new_string));
  const all = diffs.flat();
  const out = [header('Edit', path, `${stats(all)} ${paint.faint(`(${edits.length} edits)`)}`)];
  let left = maxLines;
  diffs.forEach((d, i) => {
    if (left <= 0) return;
    const block = renderDiff(d, { path, width, maxLines: Math.max(2, Math.floor(maxLines / edits.length)) });
    if (edits.length > 1) out.push(paint.faint(`  @@ edit ${i + 1}/${edits.length}`));
    out.push(...block.slice(0, left));
    left -= block.length;
  });
  if (left <= 0 && edits.length > 1) out.push(paint.faint('  … /last'));
  return out;
}

/** create_file: header with size, then the first lines (highlighted, numbered) and a "+N lines" tail. */
export function writePreview({ path, content, overwritten = false, before = null, width = process.stdout.columns || 80, maxLines = previewBudget() }) {
  if (overwritten && before !== null) {
    const diff = lineDiff(before, content);
    return [header('Rewrite', path, stats(diff)), ...renderDiff(diff, { path, width, maxLines })];
  }
  const lines = String(content ?? '').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  if (maxLines < 1000) maxLines = Math.max(4, Math.round(maxLines * 0.6)); // new file: a glimpse is enough, /last has the rest
  const lit = highlight(lines.slice(0, maxLines).join('\n'), langOfPath(path));
  const numW = String(Math.min(lines.length, maxLines)).length;
  const inner = Math.max(16, width - 4);
  const out = [header(overwritten ? 'Rewrite' : 'Write', path, paint.faint(`${lines.length} line${lines.length === 1 ? '' : 's'}`))];
  lit.forEach((l, i) => out.push(`  ${paint.faint(` ${String(i + 1).padStart(numW)} `)}${paint.faint(icons.bar)} ${clipCells(l, inner - numW - 4)}`));
  if (lines.length > maxLines) out.push(paint.faint(`   ${' '.repeat(numW)} … +${lines.length - maxLines} more lines  /last`));
  return out;
}

/** run_command / run_node / run_python: "$ command" then the last output lines and the exit code. */
export function commandPreview({ command, stdout = '', stderr = '', exitCode, timedOut = false, width = process.stdout.columns || 80, maxLines = previewBudget() }) {
  const inner = Math.max(16, width - 6);
  const out = [`  ${paint.accent2('$')} ${bold(clipCells(command, inner))}`];
  const text = [stdout, stderr].filter((s) => s && s.trim()).join('\n').trimEnd();
  const lines = text ? text.split(/\r?\n/).filter((l) => l.trim() !== '') : [];
  const shown = lines.slice(-Math.max(2, Math.min(maxLines, 8)));
  if (lines.length > shown.length) out.push(paint.faint(`    ${icons.bar} … ${lines.length - shown.length} earlier line(s)`));
  for (const l of shown) out.push(`    ${paint.faint(icons.bar)} ${paint.muted(clipCells(l, inner - 2))}`);
  if (!lines.length) out.push(`    ${paint.faint(`${icons.bar} (no output)`)}`);
  if (timedOut) out.push(`    ${paint.warn(`${icons.warn} stopped by its time limit`)}`);
  else if (exitCode !== undefined && exitCode !== 0) out.push(`    ${paint.err(`exited with code ${exitCode}`)}`);
  return out;
}

/** Full, unclipped version for the /last pager. */
export function fullPreview(kind, data, width) {
  const huge = { width, maxLines: 100000 };
  if (kind === 'edit') return editPreview({ ...data, ...huge });
  if (kind === 'multi') return multiEditPreview({ ...data, ...huge });
  if (kind === 'write') return writePreview({ ...data, ...huge });
  if (kind === 'command') return commandPreview({ ...data, ...huge });
  return [];
}
