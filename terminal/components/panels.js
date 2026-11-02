// Stateless view components. Each returns string(s); the interface decides when to print them.

import { bold, cols, icons, paint } from './style.js';
import { clipCells, oneLine, stringWidth } from './text.js';
import { phaseOf } from '../../core/ledger.js';

export const fmtMs = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`);
export const fmtNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
export const fmtBytes = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)}MB` : b >= 1024 ? `${Math.round(b / 1024)}KB` : `${b}B`);

/** Small horizontal meter: ▰▰▰▱▱ coloured by level. */
export function meter(percent, width = 10) {
  const p = Math.max(0, Math.min(100, percent));
  const filled = Math.round((p / 100) * width);
  const c = p >= 85 ? paint.err : p >= 60 ? paint.warn : paint.ok;
  const on = icons.corner.tl === '+' ? '#' : '▰';
  const off = icons.corner.tl === '+' ? '.' : '▱';
  return c(on.repeat(filled)) + paint.faint(off.repeat(width - filled));
}

// ------------------------------------------------------------------ header

/**
 * Compact header box: name + version, status dot, model, provider, mode, workspace.
 * status: 'ready' | 'working' | 'waiting' | 'error'
 */
export function header({ version, model, provider, mode, folder, status = 'ready', thinking = '', access = '', width = cols() }) {
  const c = icons.corner;
  const inner = Math.max(30, Math.min(96, width - 4));
  const dot = { ready: paint.ok(icons.dot), working: paint.accent(icons.dot), waiting: paint.warn(icons.dot), error: paint.err(icons.dot) }[status] ?? paint.muted(icons.dot);
  const modeTag = mode === 'plan' ? paint.warm(bold(' PLAN ')) + paint.muted(' read-only') : paint.accent2(bold(' BUILD ')) + paint.muted(' full tools');
  const row = (text) => `${paint.accent(c.v)} ${clipCells(text, inner - 1)}`;
  const title = `${paint.accent(icons.ai)} ${bold('PUTER AGENT')} ${paint.muted(`v${version}`)}   ${dot} ${paint.muted(status)}`;
  return [
    paint.accent(`${c.tl}${c.h.repeat(inner)}`),
    row(title),
    row(`${paint.muted('model')}  ${bold(model)}${thinking ? paint.muted(thinking) : ''}   ${paint.muted('via')} ${provider}`),
    row(`${paint.muted('mode')}  ${modeTag}${access ? `   ${paint.muted('access')} ${access}` : ''}`),
    row(`${paint.muted('dir')}   ${folder}`),
    paint.accent(`${c.bl}${c.h.repeat(inner)}`),
  ].join('\n');
}

// ------------------------------------------------------------------ phases

export const PHASES = [
  ['analyze', 'Analyze'],
  ['plan', 'Plan'],
  ['explore', 'Explore'],
  ['edit', 'Edit'],
  ['verify', 'Verify'],
  ['done', 'Done'],
];

/** Tracks which phases a task went through (driven by tool events). */
export class PhaseTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.current = 'analyze';
    this.visited = new Set(['analyze']);
  }

  enter(phase) {
    const p = phase === 'research' ? 'explore' : phase === 'act' ? this.current : phase;
    if (!PHASES.some(([k]) => k === p)) return false;
    const changed = p !== this.current;
    this.current = p;
    this.visited.add(p);
    return changed;
  }

  fromTool(name) {
    return this.enter(phaseOf(name));
  }

  render() {
    const parts = PHASES.map(([k, label]) => {
      if (k === this.current) return paint.accent(bold(`${icons.dot} ${label}`));
      if (this.visited.has(k)) return paint.ok(`${icons.ok} ${label}`);
      return paint.faint(`${icons.ring} ${label}`);
    });
    return `  ${parts.join(paint.faint(` ${icons.thin} `))}`;
  }
}

// ------------------------------------------------------------------ tools

const CATEGORY = {
  read: { icon: icons.read, color: paint.info },
  write: { icon: icons.write, color: paint.warm },
  run: { icon: icons.run, color: paint.accent2 },
  web: { icon: icons.web, color: paint.accent },
  plan: { icon: icons.plan, color: paint.muted },
  other: { icon: icons.dot, color: paint.muted },
};

export function toolCategory(name) {
  const phase = phaseOf(name);
  if (phase === 'edit') return 'write';
  if (phase === 'verify' || name === 'open_path') return 'run';
  if (phase === 'research') return 'web';
  if (phase === 'plan') return 'plan';
  if (phase === 'explore') return 'read';
  return 'other';
}

/** Main argument of a call, shown next to the tool name. */
export function argSummary(args = {}, max = 90) {
  const key = ['command', 'path', 'file', 'query', 'url', 'name', 'pattern', 'question', 'from', 'description', 'entry'].find((k) => args[k] !== undefined);
  if (!key) return '';
  const extra = args.to ? `  ${icons.arrow}  ${args.to}` : args.entry && key !== 'entry' ? ` ${icons.arrow} ${args.entry}` : '';
  return oneLine(`${args[key]}${extra}`, max);
}

/** "  ✎ edit_file  src/app.js" */
export function toolCallLine(name, args, { parallel = false, width = cols() } = {}) {
  const { icon, color } = CATEGORY[toolCategory(name)];
  const tag = parallel ? paint.faint(` ${icons.par}`) : '';
  return `  ${color(icon)} ${bold(name)}${tag} ${paint.muted(argSummary(args, Math.max(20, width - stringWidth(name) - 12)))}`;
}

/** "    ✔ 120 lines · 12ms · ⚡cached" or "    ✖ error message · 3ms" */
export function toolResultLine(result, { ms = 0, deduped = false, label = '', width = cols() } = {}) {
  const who = label ? paint.muted(`${label}: `) : '';
  const time = ms ? paint.faint(` ${icons.sep} ${fmtMs(ms)}`) : '';
  const cached = result.cached ? paint.warn(` ${icons.sep} ${icons.cache}cached`) : '';
  const dedup = deduped ? paint.warn(` ${icons.sep} ${icons.cache}unchanged, not resent`) : '';
  if (!result.ok) return `    ${paint.err(icons.fail)} ${who}${paint.err(oneLine(result.error, width - 16 - stringWidth(label)))}${time}`;
  const body = result.result ?? {};
  const failed = body.success === false || (body.exit_code !== undefined && body.exit_code !== 0);
  const mark = failed ? paint.err(icons.fail) : paint.ok(icons.ok);
  const summary = oneLine(body.summary ?? (body.exit_code !== undefined ? `exit ${body.exit_code}` : 'done'), width - 30);
  return `    ${mark} ${who}${failed ? paint.err(summary) : summary}${time}${cached}${dedup}`;
}

/** Last lines of command output, dimmed, with a gutter. */
export function outputTail(text, { lines = 6, width = cols() } = {}) {
  const all = String(text ?? '').trimEnd().split(/\r?\n/).filter((l) => l.trim());
  if (!all.length) return [];
  const shown = all.slice(-lines);
  const out = [];
  if (all.length > shown.length) out.push(paint.faint(`      ${icons.bar} … ${all.length - shown.length} earlier line(s)`));
  for (const l of shown) out.push(paint.faint(`      ${icons.bar} `) + paint.muted(clipCells(l, width - 10)));
  return out;
}

// ------------------------------------------------------------------ status bar

/**
 * One-line status: tokens (in/out, cached %), context %, cache hit rate, latency, memory.
 * Only shows what is known (providers that report no usage show "usage n/a").
 */
export function statusBar({ usage = {}, context = {}, cache = null, elapsedMs = 0, steps = 0, width = cols() }) {
  const sep = paint.faint(` ${icons.sep} `);
  const parts = [];
  parts.push(`${paint.ok(icons.ok)} ${steps} step${steps === 1 ? '' : 's'} ${paint.muted(fmtMs(elapsedMs))}`);
  if (usage.totalTokens) {
    const cachedPct = usage.promptTokens ? Math.round((usage.cachedTokens / usage.promptTokens) * 100) : 0;
    parts.push(`${paint.muted('tok')} ${fmtNum(usage.promptTokens)}${paint.faint('↑')} ${fmtNum(usage.completionTokens)}${paint.faint('↓')}${usage.cachedTokens ? paint.warn(` ${cachedPct}%${icons.cache}`) : ''}`);
  } else if (usage.modelCalls) parts.push(paint.muted('usage n/a'));
  if (usage.modelCalls) parts.push(`${paint.muted('calls')} ${usage.modelCalls}${paint.faint('/')}${usage.toolCalls ?? 0}${paint.faint(' tools')}`);
  if (usage.modelCalls && usage.latencyMs) parts.push(`${paint.muted('llm')} ${fmtMs(usage.latencyMs / usage.modelCalls)}${paint.faint('/call')}`);
  if (context.tokens !== undefined) parts.push(`${paint.muted('ctx')} ${meter(context.percent ?? 0, 6)} ${fmtNum(context.tokens)}`);
  if (cache) {
    const t = cache.total;
    const saved = (usage.cachedToolCalls ?? 0) + (usage.dedupedResults ?? 0);
    parts.push(`${paint.muted('cache')} ${t.hits + t.misses ? `${Math.round(t.hitRate * 100)}%` : '–'}${saved ? paint.warn(` ${saved}${icons.cache}`) : ''}`);
  }
  parts.push(`${paint.muted('mem')} ${fmtBytes(process.memoryUsage().rss)}`);
  // drop parts from the right until it fits
  let line = `  ${parts.join(sep)}`;
  while (stringWidth(line) > width - 1 && parts.length > 2) {
    parts.splice(parts.length - 2, 1);
    line = `  ${parts.join(sep)}`;
  }
  return line;
}

/** Files touched, grouped with change markers. */
export function changesPanel(changes = []) {
  if (!changes.length) return [];
  const marks = { created: paint.ok('+'), overwritten: paint.warn('!'), edited: paint.warm('~'), deleted: paint.err('-'), moved: paint.info('>'), 'created-dir': paint.ok('+') };
  return [`  ${bold('Files touched')} ${paint.faint('(/undo restores them)')}`, ...changes.map((c) => `    ${marks[c.action] ?? '*'} ${c.path} ${paint.faint(c.action)}`)];
}
