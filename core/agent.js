import { buildSystemPrompt } from './context.js';
import { runAgentLoop } from './agent-loop.js';
import { routeRequest } from './router.js';
import { formatResult } from '../tools/registry.js';
import { loadSession, saveSession } from './session.js';
import { expandMentions } from './mentions.js';
import { Hooks } from './hooks.js';
import { Checkpoint, listCheckpoints, pruneCheckpoints, rewindTo, undoLast } from './checkpoint.js';
import { compactHistory } from './compact.js';
import { CacheManager } from './cache.js';
import { Ledger } from './ledger.js';
import { analyzeRequest, taskFrame } from './planner.js';
import { AuditLog } from './audit.js';
import { compressToolResults, contextReport } from './context-manager.js';
import { createProtocol } from './tool-protocol.js';

const KEEP_FULL_TOOL_RESULTS = 6;
const OLD_RESULT_LIMIT = 500;

const TOOL_GROUPS = {
  files: ['read_file', 'list_files', 'search_files', 'create_file', 'edit_file', 'delete_file', 'move_file', 'create_directory', 'list_drives', 'glob', 'multi_edit'],
  terminal: ['run_command', 'run_node', 'run_python'],
  system: ['open_path'],
  delegate: ['task'],
  web: ['web_search', 'web_fetch'],
  memory: ['memory_read', 'memory_write', 'memory_forget'],
  task: ['todo_read', 'todo_write', 'ask_user'],
  image: ['image_describe'],
  project: ['project_overview', 'find_symbol', 'changed_files', 'read_zip'],
};

function selectTools(text, mode, settings) {
  if (settings.optimization?.dynamicTools === false) return null;
  const value = String(text ?? '').toLowerCase();
  const names = new Set([...TOOL_GROUPS.files, ...TOOL_GROUPS.memory, ...TOOL_GROUPS.task, ...TOOL_GROUPS.project]);
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
    this.cache = new CacheManager(settings.cache ?? {});
    this.audit = new AuditLog(guard.root, { enabled: settings.audit?.enabled !== false });
    this.ledger = new Ledger();
    this.sessionUsage = { totalTokens: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, modelCalls: 0, toolCalls: 0, cachedToolCalls: 0, dedupedResults: 0, latencyMs: 0, tasks: 0 };
    this.lastAnalysis = null;
    this.busy = false;
    this.reset();
  }

  #systemMessage() {
    return { role: 'system', content: buildSystemPrompt({ workspace: this.guard.root, mode: this.mode }) };
  }

  reset() {
    this.state = { todos: [] };
    this.messages = [this.#systemMessage()];
    this.ledger?.reset();
    // Tools offered so far in this conversation. The set only grows, so the tool list (part of the
    // provider's cached prompt prefix) stays identical between requests once it has settled.
    this.toolSet = new Set();
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
    this.audit.setWorkspace(this.guard.root);
    this.cache.clear('all');
    this.reset();
  }

  async save() {
    return saveSession(this.guard.root, { model: this.model, mode: this.mode, todos: this.state.todos, messages: this.messages.slice(1), ledger: this.ledger.toJSON() });
  }

  /** Put back the files changed by the most recent task(s). */
  undo() {
    return undoLast(this.guard.root);
  }

  /** Summarise the old part of a very long conversation (keeps the system prompt and the latest turns). */
  async #compact(signal, emit = () => {}) {
    const { compactAtChars = 120000, keepTurns = 2, summarizer = 'local' } = this.settings.context ?? {};
    try {
      const done = await compactHistory({ messages: this.messages, provider: this.provider, model: this.model, limit: compactAtChars, keepTurns, signal, summarizer, localSummary: this.ledger.summary(), cache: this.cache.model });
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

  /** Numbers for /context and the status bar: conversation size, token estimate, cache and usage. */
  contextInfo() {
    const limitTokens = this.settings.context?.maxTokens ?? 32000;
    const report = contextReport(this.messages, { limitTokens });
    const limit = this.settings.context?.compactAtChars ?? 120000;
    return {
      ...report,
      approxTokens: report.tokens,
      limit,
      percent: Math.min(999, Math.round((report.chars / limit) * 100)),
      tokenPercent: report.percent,
      tools: this.registry.list().length,
      offeredTools: this.toolSet.size,
      session: { ...this.sessionUsage },
      cache: this.cache.stats(),
    };
  }

  /** MCP tools are always offered (outside plan mode, where only read-only tools exist anyway). */
  #withMcp(names) {
    if (!names) return names;
    const mcp = this.registry.list().filter((t) => t.name.startsWith('mcp__')).map((t) => t.name);
    return [...names, ...mcp];
  }

  /** Force-summarise the old part of the conversation now (/compact). Returns false if too short. */
  async compactNow(signal) {
    return compactHistory({ messages: this.messages, provider: this.provider, model: this.model, limit: 0, keepTurns: 1, signal, summarizer: this.settings.context?.manualSummarizer ?? 'model', localSummary: this.ledger.summary(), cache: this.cache.model });
  }

  /** Restore the last saved conversation of this workspace. Returns false if there is none. */
  async resume() {
    const data = await loadSession(this.guard.root);
    if (!data) return false;
    this.state = { todos: data.todos ?? [] };
    this.messages = [this.#systemMessage(), ...data.messages];
    this.ledger = data.ledger ? Ledger.fromJSON(data.ledger) : new Ledger();
    return true;
  }

  /** Tools to offer for this request (sticky: the set never shrinks within a conversation). */
  #toolsFor(userText) {
    const picked = selectTools(userText, this.mode, this.settings);
    if (!picked) return null;
    if (this.settings.optimization?.stickyTools === false) return this.#withMcp(picked);
    for (const name of picked) this.toolSet.add(name);
    return this.#withMcp([...this.toolSet].filter((n) => this.registry.has(n)));
  }

  /** Run one user request to completion. Returns the loop result plus the files touched. */
  async run(userText, { signal, emit, onDelta } = {}) {
    if (this.busy) throw new Error('The agent is already working on a request. Wait for it to finish or cancel it first.');
    this.busy = true;
    const startedAt = Date.now();
    this.messages[0] = this.#systemMessage(); // picks up new memory / AGENTS.md changes
    this.cache.bumpGeneration(); // files may have changed outside the agent since the last request
    await this.#compact(signal, emit);
    const { text: expanded, attached } = expandMentions(userText, this.guard);
    if (attached.length) emit?.({ type: 'mentions', files: attached });

    const planning = this.settings.planning ?? {};
    const analysis = planning.enabled === false ? null : analyzeRequest(userText, { mode: this.mode, maxSteps: this.settings.maxSteps });
    this.lastAnalysis = analysis;
    if (analysis) emit?.({ type: 'analysis', ...analysis });
    const frame = analysis && planning.taskFrame !== false ? taskFrame(analysis) : '';
    this.messages.push({ role: 'user', content: `${expanded}${frame}` });
    this.ledger.addGoal(userText);

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
      cache: this.cache,
      audit: this.audit,
      onDelta,
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
        toolNames: this.#toolsFor(userText),
        context: this.settings.optimization ?? {},
        verify: this.settings.verify?.enabled !== false,
        verifyNudges: this.settings.verify?.nudges ?? 2,
        protocol: this.settings.tools?.protocol ?? 'auto',
        analysis,
        ledger: this.ledger,
        signal,
        emit,
      });
      this.lastCheckpoint = checkpoint.size;
      if (result.stopReason === 'done') this.ledger.addAnswer(result.content);
      const u = result.usage ?? {};
      for (const k of ['totalTokens', 'promptTokens', 'completionTokens', 'cachedTokens', 'modelCalls', 'toolCalls', 'cachedToolCalls', 'dedupedResults', 'latencyMs']) {
        this.sessionUsage[k] += Number(u[k]) || 0;
      }
      this.sessionUsage.tasks += 1;
      return { ...result, changes, elapsedMs: Date.now() - startedAt, analysis };
    } catch (err) {
      // The loop keeps history valid (see runAgentLoop). The only unsafe leftover is a user
      // message that never got an answer - drop it so "continue" or a retry starts clean.
      if (this.messages.at(-1)?.role === 'user') this.messages.pop();
      throw err;
    } finally {
      this.busy = false;
      // Once per request (not per step): keeps the prefix stable while the model is working.
      compressToolResults(this.messages, { keep: KEEP_FULL_TOOL_RESULTS, maxChars: OLD_RESULT_LIMIT, triggerChars: 0 });
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
    const protocol = createProtocol(this.settings.tools?.protocol === 'auto' ? 'native' : this.settings.tools?.protocol);
    if (protocol.name === 'native') {
      this.messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{ id, type: 'function', function: { name: 'web_search', arguments: JSON.stringify(args) } }],
      });
    } else this.messages.push({ role: 'assistant', content: JSON.stringify({ tool: 'web_search', args }) });
    emit({ type: 'tool_call', name: 'web_search', args, id });
    const t0 = Date.now();
    const result = await this.registry.execute('web_search', args, ctx);
    emit({ type: 'tool_result', name: 'web_search', args, result, id, ms: Date.now() - t0 });
    this.ledger.observe('web_search', args, result);
    this.messages.push(protocol.resultMessage({ id, name: 'web_search' }, formatResult(result, this.settings.limits.maxToolResultChars)));
  }
}
