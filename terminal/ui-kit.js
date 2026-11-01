// High-level TUI helpers used by every command and page. Each helper uses the interactive widget when the
// terminal is a TTY and falls back to plain text (numbered list + readline question) otherwise, so scripts,
// pipes and tests keep working.

import { color } from '../utils/logger.js';
import { clip, stringWidth, stripAnsi } from './input.js';
import { ACCENT, GLYPHS as G, bold, confirmWidget, dim, fg, pagerWidget, selectWidget, textWidget } from './widgets.js';

export { ACCENT, G, bold, dim, fg };

export const hasTui = (ui) => Boolean(ui?.input?.isTTY && typeof ui.input.widget === 'function');

const green = fg(78);
const yellow = fg(221);
const red = fg(203);

export const ok = (msg) => console.log(`  ${green(G.ok)} ${msg}`);
export const warn = (msg) => console.log(`  ${yellow('!')} ${msg}`);
export const fail = (msg) => console.log(`  ${red('✗')} ${msg}`);
export const info = (msg) => console.log(`  ${dim('·')} ${dim(msg)}`);

/** Pick one item from a list. Resolves the item's value, { custom } (allowCustom), or null when cancelled. */
export async function pick(ui, { title, subtitle, items, current = null, filter, allowCustom = false, query = '', plainPrompt = 'Number or name (Enter to cancel): ' }) {
  const list = items.map((i) => ({ ...i, current: i.current ?? (current !== null && i.value === current) }));
  if (hasTui(ui)) {
    return ui.input.widget(selectWidget({ title, subtitle, items: list, current, filter: filter ?? list.length > 7, allowCustom, query }));
  }
  console.log(`\n${title}${subtitle ? ` (${subtitle})` : ''}`);
  list.forEach((i, n) => console.log(`  ${n + 1}. ${String(i.label).padEnd(10)} ${color.dim(i.description ?? '')}`));
  const answer = String(await ui.rl.question(plainPrompt)).trim();
  if (!answer) return null;
  return list[Number(answer) - 1]?.value ?? list.find((i) => String(i.value).toLowerCase() === answer.toLowerCase())?.value ?? (allowCustom ? { custom: answer } : null);
}

/** One line of text. Resolves the string, or null when cancelled. mask hides it (API keys). */
export async function ask(ui, { title, subtitle, label, initial = '', placeholder, mask = false, validate, help, plainPrompt }) {
  if (hasTui(ui)) return ui.input.widget(textWidget({ title, subtitle, label, initial, placeholder, mask, validate, help }));
  const answer = String(await ui.rl.question(plainPrompt ?? `${title}: `)).trim();
  if (!answer) return null;
  const err = validate?.(answer);
  if (err) {
    warn(err);
    return null;
  }
  return answer;
}

/** Yes / No dialog. Plain mode asks to type "yes". */
export async function yesNo(ui, { title, lines = [], danger = false, yesLabel = 'Yes', noLabel = 'No' }) {
  if (hasTui(ui)) return ui.input.widget(confirmWidget({ title, lines, danger, yesLabel, noLabel }));
  const answer = await ui.rl.question(`${title}${lines.length ? ` - ${lines.join(' ')}` : ''} Type "yes" to confirm: `);
  return String(answer).trim().toLowerCase() === 'yes';
}

/** Scrollable page for long content; plain mode just prints it. */
export async function page(ui, title, lines, subtitle) {
  if (hasTui(ui)) return ui.input.widget(pagerWidget({ title, subtitle, lines }));
  console.log(`\n${title}\n${lines.map((l) => stripAnsi(l)).join('\n')}\n`);
  return true;
}

export function meter(percent, width = 24) {
  const pct = Math.max(0, Math.min(100, percent));
  const filled = Math.round((pct / 100) * width);
  const paint = pct >= 90 ? red : pct >= 60 ? yellow : green;
  return `${paint('█'.repeat(filled))}${fg(238)('░'.repeat(width - filled))}`;
}

/**
 * Static framed panel. sections: [{ heading?, rows: [string | [label, value]] }]. Returns lines.
 */
export function panel(title, sections, { subtitle, hint, accent = ACCENT, cols = process.stdout.columns || 80 } = {}) {
  const inner = Math.max(30, Math.min(100, cols - 6));
  const bar = accent(G.bar);
  const out = [`  ${accent(`${G.tl}─`)} ${bold(title)}${subtitle ? `  ${dim(subtitle)}` : ''}`];
  sections.forEach((sec, i) => {
    if (i) out.push(`  ${bar}`);
    if (sec.heading) out.push(`  ${bar} ${dim(sec.heading.toUpperCase())}`);
    const rows = sec.rows ?? [];
    const labelW = Math.min(22, Math.max(0, ...rows.filter(Array.isArray).map((r) => stringWidth(r[0]))));
    for (const r of rows) {
      const text = Array.isArray(r) ? `  ${dim(String(r[0]).padEnd(labelW + (String(r[0]).length - stringWidth(r[0]))))}  ${r[1]}` : `  ${r}`;
      out.push(`  ${bar} ${clip(text, inner)}`);
    }
  });
  out.push(`  ${accent(`${G.bl}─`)}${hint ? ` ${dim(hint)}` : ''}`);
  return out;
}

export const printPanel = (...args) => console.log(`\n${panel(...args).join('\n')}\n`);
