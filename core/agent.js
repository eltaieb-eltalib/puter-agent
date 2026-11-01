import { buildSystemPrompt } from './context.js';
import { runAgentLoop } from './agent-loop.js';
import { routeRequest } from './router.js';
import { formatResult } from '../tools/registry.js';
import { loadSession, saveSession } from './session.js';
import { expandMentions } from './mentions.js';
import { Hooks } from './hooks.js';
import { Checkpoint, listCheckpoints, pruneCheckpoints, rewindTo, undoLast } from './checkpoint.js';
import { compactHistory } from './compact.js';

const KEEP_FULL_TOOL_RESULTS = 6;
const OLD_RESULT_LIMIT = 900;

const TOOL_GROUPS = {
  files: ['read_file', 'list_files', 'search_files', 'create_file', 'edit_file', 'delete_file', 'move_file', 'create_directory', 'list_drives', 'glob', 'multi_edit'],
  terminal: ['run_command', 'run_node', 'run_python'],
  system: ['open_path'],
  delegate: ['task'],
  web: ['web_search', 'web_fetch'],
  memory: ['memory_read', 'memory_write', 'memory_forget'],
  task: ['todo_read', 'todo_write', 'ask_user'],
  image: ['image_describe'],
};

function selectTools(text, mode, settings) {
  if (settings.optimization?.dynamicTools === false) return null;
  const value = String(text ?? '').toLowerCase();
  const names = new Set([...TOOL_GROUPS.files, ...TOOL_GROUPS.memory, ...TOOL_GROUPS.task]);
  const research = /\b(search|research|latest|news|weather|price|online|internet|web)\b|ابحث|بحث|الانترنت|الويب|احدث|آخر|اخبار|سعر|طقس/.test(value);
  const needsTerminal = /\b(run|execute|install|test|build|compile|terminal|command|npm|node|python|git|fix|edit|implement|refactor|debug|change|update|create|write)\b|شغل|نفذ|اختبر|ثبت|ابن|بناء|امر|طرفية|عدل|تعديل|اصلح|أصلح|نفذ|برمج|حدث|تحديث|اكتب|انشئ|أنشئ/.test(value);
  const needsOpen = /\b(open|launch|start|show|desktop|downloads|documents|drive|folder|system)\b|افتح|فتح|شغل|سطح المكتب|التنزيلات|المستندات|قرص|درايف|مجلد|النظام/.test(value);
  const needsImage = /\b(image|picture|photo|screenshot)\b|صورة|صوره|لقطة/.test(value);
  if (research) for (const name of TOOL_GROUPS.web) names.add(name);
  if (mode !== 'plan' && needsTerminal) for (const name of TOOL_GROUPS.terminal) names.add(name);
  if (mode !== 'plan' && (needsOpen || needsTerminal)) for (const name of TOOL_GROUPS.system) names.add(name);
  if (mode !== 'plan' || research) for (const name of TOOL_GROUPS.delegate) names.add(name);
  if (needsImage) for (const name of TOOL_GROUPS.image) names.add(name);
  return [...names];
}
export const MODES = ['build', 'plan'];

/**
 * Holds the conversation and runs one user request at a time through the agent loop.
 * Modes (like opencode): "build" = every tool, "plan" = read-only (explore, research, plan).
 */
export class Agent {
  constructor({ provider, registry, settings, guard, permissions, model, mode = 'build' }) {
    this.provider = provider;
    this.registry = registry;
    this.settings = settings;
    this.guard = guard;
    this.permissions = permissions;
    this.model = model;
    this.mode = MODES.includes(mode) ? mode : 'build';
    this.asker = null; // set by the terminal UI: (question, options) => Promise<string|null>
    this.state = { todos: [] };
    this.messages = [];
    this.hooks = new Hooks(settings.hooks, { cwd: guard.root });
    this.sessionUsage = { totalTokens: 0, cachedTokens: 0, modelCalls: 0, toolCalls: 0, tasks: 0 };
    this.reset();
  }

  #systemMessage() {
    return { role: 'system', content: buildSystemPrompt({ workspace: this.guard.root, mode: this.mode }) };
  }

  reset() {
    this.state = { todos: [] };
    this.messages = [this.#systemMessage()];
  }

  setModel(model) {
    this.model = model;
  }

  /** Switch mode without losing the conversation (the system prompt is refreshed in place). */
  setMode(mode) {
    if (!MODES.includes(mode)) throw new Error(`Unknown mode "${mode}". Use: ${MODES.join(', ')}`);
    this.mode = mode;
    this.messages[0] = this.#systemMessage();
  }

  setAsker(fn) {
    this.asker = fn;
  }

  /** Switch workspace; the conversation restarts because the system prompt names the folder. */
  setWorkspace(dir) {
    this.guard.setWorkspace(dir);
    this.hooks.setCwd(this.guard.root);
    this.reset();
  }

  async save() {
    return saveSession(this.guard.root, { model: this.model, mode: this.mode, todos: this.state.todos, messages: this.messages.slice(1) });
  }

  /** Put back the files changed by the most recent task(s). */
  undo() {
    return undoLast(this.guard.root);
  }

  /** Summarise the old part of a very long conversation (keeps the system prompt and the latest turns). */
  async #compact(signal, emit = () => {}) {
    const { compactAtChars = 120000, keepTurns = 2 } = this.settings.context ?? {};
    try {
      const done = await compactHistory({ messages: this.messages, provider: this.provider, model: this.model, limit: compactAtChars, keepTurns, signal });
      if (done) emit({ type: 'compacted' });
    } catch {
      /* compaction is best effort */
    }
  }

  checkpoints() {
    return listCheckpoints(this.guard.root);
  }

  rewind(id) {
    return rewindTo(this.guard.root, id);
  }

  /** Numbers for /context: how big the conversation is and how close it is to automatic compaction. */
  contextInfo() {
    const byRole = { system: 0, user: 0, assistant: 0, tool: 0 };
    for (const m of this.messages) {
      const n = (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
      byRole[m.role] = (byRole[m.role] ?? 0) + n;
    }
    const chars = Object.values(byRole).reduce((a, b) => a + b, 0);
    const limit = this.settings.context?.compactAtChars ?? 120000;
    return { messages: this.messages.length, chars, approxTokens: Math.round(chars / 4), byRole, limit, percent: Math.min(999, Math.round((chars / limit) * 100)), tools: this.registry.list().length, session: { ...this.sessionUsage } };
  }

  /** MCP tools are always offered (outside plan mode, where only read-only tools exist anyway). */
  #withMcp(names) {
    if (!names) return names;
    const mcp = this.registry.list().filter((t) => t.name.startsWith('mcp__')).map((t) => t.name);
    return [...names, ...mcp];
  }

  /** Force-summarise the old part of the conversation now (/compact). Returns false if too short. */
  async compactNow(signal) {
    return compactHistory({ messages: this.messages, provider: this.provider, model: this.model, limit: 0, keepTurns: 1, signal });
  }

  /** Restore the last saved conversation of this workspace. Returns false if there is none. */
  async resume() {
    const data = await loadSession(this.guard.root);
    if (!data) return false;
    this.state = { todos: data.todos ?? [] };
    this.messages = [this.#systemMessage(), ...data.messages];
    return true;
  }

  /** Run one user request to completion. Returns the loop result plus the files touched. */
  async run(userText, { signal, emit } = {}) {
    this.messages[0] = this.#systemMessage(); // picks up new memory / AGENTS.md changes
    await this.#compact(signal, emit);
    const { text: expanded, attached } = expandMentions(userText, this.guard);
    if (attached.length) emit?.({ type: 'mentions', files: attached });
    this.messages.push({ role: 'user', content: expanded });
    const changes = [];
    const checkpoint = new Checkpoint(this.guard.root);
    const ctx = {
      guard: this.guard,
      permissions: this.permissions,
      settings: this.settings,
      changes,
      checkpoint,
      signal,
      mode: this.mode,
      hooks: this.hooks,
      provider: this.provider,
      model: this.model,
      registry: this.registry,
      depth: 0,
      state: this.state,
      ask: this.asker ? (q, opts) => this.asker(q, opts) : undefined,
    };
    try {
      await this.#autoSearch(userText, ctx, emit);
      const result = await runAgentLoop({
        provider: this.provider,
        model: this.model,
        messages: this.messages,
        registry: this.registry,
        ctx,
        maxSteps: this.settings.maxSteps,
        retry: this.settings.retry,
        maxResultChars: this.settings.limits.maxToolResultChars,
        toolNames: this.#withMcp(selectTools(userText, this.mode, this.settings)),
        context: this.settings.optimization ?? {},
        verify: this.settings.verify?.enabled !== false,
        verifyNudges: this.settings.verify?.nudges ?? 2,
        signal,
        emit,
      });
      this.lastCheckpoint = checkpoint.size;
      const u = result.usage ?? {};
      this.sessionUsage.totalTokens += Number(u.totalTokens) || 0;
      this.sessionUsage.cachedTokens += Number(u.cachedTokens) || 0;
      this.sessionUsage.modelCalls += Number(u.modelCalls) || 0;
      this.sessionUsage.toolCalls += Number(u.toolCalls) || 0;
      this.sessionUsage.tasks += 1;
      return { ...result, changes };
    } catch (err) {
      // The loop keeps history valid (see runAgentLoop). The only unsafe leftover is a user
      // message that never got an answer - drop it so "continue" or a retry starts clean.
      if (this.messages.at(-1)?.role === 'user') this.messages.pop();
      throw err;
    } finally {
      this.#shrinkOldToolResults();
      pruneCheckpoints(this.guard.root).catch(() => {});
      this.save().catch(() => {}); // best effort: lets /resume restore the conversation
    }
  }

  /**
   * Clear "search the web" requests: run web_search here, in code, and record it in the history as a
   * normal tool call + result (so the history stays valid for every provider). The model then answers
   * from real results instead of deciding on its own whether to search.
   */
  async #autoSearch(userText, ctx, emit = () => {}) {
    if (this.settings.routing?.forceSearch === false || !this.registry.has('web_search')) return;
    const route = routeRequest(userText);
    if (!route.research) return;

    const args = { query: route.query };
    const id = `auto_search_${Date.now()}`;
    this.messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id, type: 'function', function: { name: 'web_search', arguments: JSON.stringify(args) } }],
    });
    emit({ type: 'tool_call', name: 'web_search', args });
    const result = await this.registry.execute('web_search', args, ctx);
    emit({ type: 'tool_result', name: 'web_search', args, result });
    this.messages.push({
      role: 'tool',
      tool_call_id: id,
      content: formatResult(result, this.settings.limits.maxToolResultChars),
    });
  }

  // Old tool outputs (file contents, command logs, web pages) are the main source of context bloat.
  #shrinkOldToolResults() {
    const toolIdx = [];
    this.messages.forEach((m, i) => m.role === 'tool' && toolIdx.push(i));
    for (const i of toolIdx.slice(0, -KEEP_FULL_TOOL_RESULTS)) {
      const m = this.messages[i];
      if (typeof m.content === 'string' && m.content.length > OLD_RESULT_LIMIT) {
        const cut = m.content.length - OLD_RESULT_LIMIT;
        m.content = `${m.content.slice(0, OLD_RESULT_LIMIT)}...[older tool output shortened, ${cut} characters omitted]`;
      }
    }
  }
}
