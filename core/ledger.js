// Working memory built from TOOL RESULTS ONLY (evidence, not model claims).
// It records what was read, changed, run and what failed, so that:
//   * old context can be summarised locally, without spending a model call (see compactHistory)
//   * the UI can show the current phase of the task
//   * repeated work is visible ("this file was already read, unchanged")

const WRITE_TOOLS = new Set(['create_file', 'edit_file', 'multi_edit', 'delete_file', 'move_file', 'create_directory']);
const RUN_TOOLS = new Set(['run_command', 'run_node', 'run_python']);
const READ_TOOLS = new Set(['read_file', 'list_files', 'search_files', 'glob', 'find_symbol', 'project_overview', 'changed_files', 'read_zip']);
const WEB_TOOLS = new Set(['web_search', 'web_fetch']);

const MAX_ITEMS = 40;
const cap = (arr) => {
  if (arr.length > MAX_ITEMS) arr.splice(0, arr.length - MAX_ITEMS);
};

/** Which phase a tool call belongs to. */
export function phaseOf(name) {
  if (name === 'todo_write' || name === 'todo_read') return 'plan';
  if (WRITE_TOOLS.has(name)) return 'edit';
  if (RUN_TOOLS.has(name)) return 'verify';
  if (WEB_TOOLS.has(name)) return 'research';
  if (READ_TOOLS.has(name) || name === 'task') return 'explore';
  return 'act';
}

export class Ledger {
  constructor() {
    this.reset();
  }

  reset() {
    this.goals = []; // user requests (short)
    this.reads = new Map(); // path -> { hash, lines, at }
    this.changes = new Map(); // path -> last action
    this.commands = []; // { cmd, exit, timedOut }
    this.errors = []; // { tool, error }
    this.sources = []; // urls read
    this.answers = []; // final replies (short)
  }

  addGoal(text) {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    this.goals.push(t.length > 240 ? `${t.slice(0, 239)}…` : t);
    cap(this.goals);
  }

  addAnswer(text) {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    this.answers.push(t.length > 300 ? `${t.slice(0, 299)}…` : t);
    cap(this.answers);
  }

  observe(name, args = {}, result = {}) {
    if (!result?.ok) {
      this.errors.push({ tool: name, error: String(result?.error ?? 'failed').slice(0, 200) });
      cap(this.errors);
      return;
    }
    const r = result.result ?? {};
    if (name === 'read_file' && r.path) this.reads.set(r.path, { hash: r.hash, lines: r.total_lines });
    else if (WRITE_TOOLS.has(name)) {
      const p = args.path ?? args.to ?? args.from;
      if (p) {
        this.changes.set(String(p), name);
        this.reads.delete(String(p)); // content changed: an earlier read is stale
      }
    } else if (RUN_TOOLS.has(name)) {
      this.commands.push({ cmd: String(args.command ?? `${name} ${args.file ?? ''}`).slice(0, 160), exit: r.exit_code, timedOut: Boolean(r.timed_out) });
      cap(this.commands);
    } else if (name === 'web_fetch' && (r.url || args.url)) {
      this.sources.push(String(r.url ?? args.url));
      cap(this.sources);
    }
  }

  get empty() {
    return !this.goals.length && !this.reads.size && !this.changes.size && !this.commands.length && !this.errors.length;
  }

  /** Compact factual summary (no model call). */
  summary({ maxChars = 3000 } = {}) {
    const out = [];
    if (this.goals.length) out.push(`User requests so far:\n${this.goals.slice(-8).map((g) => `- ${g}`).join('\n')}`);
    if (this.changes.size) out.push(`Files changed: ${[...this.changes].slice(-25).map(([p, a]) => `${p} (${a})`).join(', ')}`);
    if (this.reads.size) out.push(`Files read: ${[...this.reads.keys()].slice(-25).join(', ')}`);
    if (this.commands.length) out.push(`Commands run:\n${this.commands.slice(-10).map((c) => `- ${c.cmd} -> exit ${c.exit}${c.timedOut ? ' (timed out)' : ''}`).join('\n')}`);
    if (this.errors.length) out.push(`Recent errors:\n${this.errors.slice(-6).map((e) => `- ${e.tool}: ${e.error}`).join('\n')}`);
    if (this.sources.length) out.push(`Web sources read: ${this.sources.slice(-8).join(' , ')}`);
    if (this.answers.length) out.push(`Your earlier answers (short):\n${this.answers.slice(-4).map((a) => `- ${a}`).join('\n')}`);
    const text = out.join('\n');
    return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
  }

  toJSON() {
    return { goals: this.goals, reads: [...this.reads], changes: [...this.changes], commands: this.commands, errors: this.errors, sources: this.sources, answers: this.answers };
  }

  static fromJSON(data = {}) {
    const l = new Ledger();
    l.goals = data.goals ?? [];
    l.reads = new Map(data.reads ?? []);
    l.changes = new Map(data.changes ?? []);
    l.commands = data.commands ?? [];
    l.errors = data.errors ?? [];
    l.sources = data.sources ?? [];
    l.answers = data.answers ?? [];
    return l;
  }
}
