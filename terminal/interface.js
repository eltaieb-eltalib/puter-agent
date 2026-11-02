import os from 'node:os';
import { stdin, stdout } from 'node:process';
import { card, color, gray, orange, sym, teal, violet } from '../utils/logger.js';
import { renderMarkdown } from './components/markdown.js';
import { LiveLine } from './components/live.js';
import { Transcript } from './components/transcript.js';
import { PhaseTracker, argSummary, changesPanel, fmtMs, header, outputTail, statusBar, toolCallLine, toolResultLine } from './components/panels.js';
import { bold as sBold, icons, paint } from './components/style.js';
import { phaseOf } from '../core/ledger.js';
import { resolveTheme } from './themes.js';
import { classifyError, ErrorKind, explainError } from '../utils/errors.js';
import { COMMANDS, chooseModel, runCommand } from './commands.js';
import { expandCustomCommand, listCustomCommands } from '../core/custom-commands.js';
import { centre, logoLines, homePanel } from './home.js';
import { createInput, stringWidth } from './input.js';
import { redactSecrets } from '../utils/redact.js';


const PHASE_LABEL = { plan: 'Plan', explore: 'Explore', research: 'Research', edit: 'Edit', verify: 'Verify', act: 'Act' };

// What the user sees in the live line while a tool is working.
function workingLabel(name, args = {}) {
  const target = argSummary(args, 60);
  const verb = {
    create_file: 'Writing', edit_file: 'Editing', multi_edit: 'Editing', delete_file: 'Deleting', move_file: 'Moving',
    run_command: 'Running', run_node: 'Running', run_python: 'Running', web_search: 'Searching', web_fetch: 'Reading',
    read_file: 'Reading', list_files: 'Listing', search_files: 'Searching', glob: 'Finding', project_overview: 'Indexing project',
    find_symbol: 'Locating', file_relations: 'Mapping', changed_files: 'Checking changes', read_zip: 'Reading archive', task: 'Sub-agent:',
  }[name] ?? name;
  const phase = PHASE_LABEL[phaseOf(name)];
  return `${phase ? paint.faint(`[${phase}] `) : ''}${verb}${target ? ` ${target}` : ''}`;
}

// What each permission is called in the dialog, and how risky it looks.
const ACTION_TITLE = {
  runCommand: ['Run a command or script', 'warn'],
  deleteFile: ['Delete a file', 'danger'],
  overwriteFile: ['Overwrite an existing file', 'warn'],
  moveFile: ['Move / rename a file', 'warn'],
  editFile: ['Edit a file', 'info'],
  createFile: ['Create a file', 'info'],
  createDirectory: ['Create a folder', 'info'],
  outside: ['Access outside the workspace', 'danger'],
  readSecret: ['Read a file that may hold secrets', 'danger'],
  openPath: ['Open with the default app', 'warn'],
  mcp: ['Call an MCP tool (external server)', 'warn'],
};

const ACTION_LABEL = {
  runCommand: 'all commands / scripts',
  deleteFile: 'all deletes',
  overwriteFile: 'all overwrites',
  moveFile: 'all moves',
  editFile: 'all edits',
  createFile: 'all file creation',
  outside: 'outside-workspace access',
  openPath: 'opening files / links',
  mcp: 'MCP tool calls',
  readSecret: 'reading secret files',
};

/** Keep the END of a long path (the folder name matters most): "…/puter-agent/workspace". */
export function shortenPath(p, max) {
  const str = String(p);
  if (str.length <= max) return str;
  return `…${str.slice(str.length - Math.max(1, max - 1))}`;
}

export class TerminalUI {
  constructor({ agent, provider, settings, version, tui }) {
    this.agent = agent;
    this.agent.setAsker((question, options) => this.ask(question, options));
    this.provider = provider;
    this.settings = settings;
    this.version = version;
    this.tui = tui ?? {};
    this.models = [];
    this.input = createInput({ stdin, stdout });
    this.rl = this.input; // commands use ui.rl.question(...) / ui.rl.close()
    this.input.onAbort = () => this.#abortRun();
    this.input.onExit = () => this.#quit();
    this.input.onToggleMode = () => this.agent.setMode(this.agent.mode === 'plan' ? 'build' : 'plan');
    this.running = false;
    this.abort = null;
    this.spinner = new LiveLine(stdout); // name kept: commands and older code use ui.spinner
    this.toolStartedAt = 0;
    this.theme = resolveTheme(tui);
    this.ui = { rtl: 'auto', statusBar: true, showPhases: true, codeHighlight: true, ...(settings.ui ?? {}) };
    this.phases = new PhaseTracker();
    this.transcript = new Transcript();
    this.pending = 0; // tools started in parallel and not finished yet
    this.agent.permissions.onCancel = () => this.#abortRun();
  }

  /** "◆ answer…" - the icon shares the first line unless that line is right-aligned (RTL text). */
  #speak(text) {
    const body = this.md(text);
    const first = body.split('\n')[0] ?? '';
    return /^\s{6,}\S/.test(first) ? `${paint.accent(icons.ai)}\n${body}` : `${paint.accent(icons.ai)} ${body.trimStart()}`;
  }

  /** Markdown -> terminal with the user's RTL / highlight settings, indented under the speaker. */
  md(text, indent = 2) {
    const width = Math.max(20, (stdout.columns || 80) - indent - 2);
    return renderMarkdown(text, { width, rtl: this.ui.rtl, highlight: this.ui.codeHighlight })
      .split('\n')
      .map((l) => (l ? ' '.repeat(indent) + l : l))
      .join('\n');
  }

  async getModels({ refresh = false } = {}) {
    if (this.models.length && !refresh) return this.models;
    try {
      this.models = await this.provider.listModels();
    } catch (err) {
      console.log(color.yellow(`Could not load the model list: ${explainError(err)}`));
      this.models = [];
    }
    return this.models;
  }

  /** " (thinking: low)" for providers that have a thinking level, otherwise "". */
  thinkingLabel() {
    const p = this.provider;
    if (p && 'thinkingLevel' in p) return ` (thinking: ${p.thinkingLevel ?? 'off'})`;
    if (p && 'reasoningLevel' in p) return ` (reasoning: ${p.reasoningLevel}, ${p.reasoningMode})`;
    return '';
  }

  banner(status = 'ready') {
    const providerName = this.provider?.name || this.provider?.id || this.settings.provider || 'connected';
    console.log(`\n${header({
      version: this.version,
      model: this.agent.model,
      provider: providerName,
      mode: this.agent.mode,
      folder: this.#folderLabel(),
      status,
      thinking: this.thinkingLabel(),
      access: this.agent.permissions.accessLevel,
      width: stdout.columns || 80,
    })}\n  ${gray('/help')} ${gray('commands')}  ${sym.sep}  ${gray('/history')} ${gray('scroll back')}  ${sym.sep}  ${gray('Shift+Tab')} ${gray('mode')}  ${sym.sep}  ${gray('Ctrl+C')} ${gray('cancel')}\n`);
  }

  /** Non-interactive: run one request (`-p "text"`), then exit. */
  async startOnce(text) {
    // Non-interactive: do not create a readline interface.
    this.#installSignalHandlers();
    process.once('SIGINT', () => (this.running ? this.#abortRun() : this.#quit(130)));
    await this.#runTask(text);
    // Ensure the CLI exits after the single request finishes.
    // This prevents watchdog idle issues on some environments.
    process.exit(0);
  }

  #quit(code = 0) {
    this.spinner.stop();
    this.input.detach();
    stdout.write('\x1b[?25h\x1b[?2004l\n'); // cursor back, bracketed paste off
    process.exit(code);
  }

  /** SIGTERM / SIGHUP: cancel the running task, save the conversation, restore the terminal, exit. */
  #installSignalHandlers() {
    if (this.signalsInstalled) return;
    this.signalsInstalled = true;
    const shutdown = (signal) => {
      this.abort?.abort();
      this.spinner.stop();
      const code = signal === 'SIGTERM' ? 143 : 129;
      Promise.race([this.agent.save().catch(() => {}), new Promise((r) => setTimeout(r, 800))]).finally(() => this.#quit(code));
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    if (process.platform !== 'win32') process.once('SIGHUP', () => shutdown('SIGHUP'));
  }

  #abortRun() {
    if (!this.running) return;
    this.abort?.abort();
    this.spinner.stop();
    stdout.write(color.yellow('\n  Cancelling...\n'));
  }

  #folderLabel() {
    const root = String(this.agent.guard.root);
    const home = os.homedir();
    return root.startsWith(home) ? `~${root.slice(home.length)}` : root;
  }

  /** Live data for the prompt box (re-read on every redraw, so Shift+Tab updates it at once). */
  #promptState() {
    const plan = this.agent.mode === 'plan';
    const accent = plan ? this.theme.plan : this.theme.build;
    return {
      accent,
      info: `${accent(color.bold(plan ? 'Plan' : 'Build'))}  ${this.agent.model}${gray(this.thinkingLabel())}`,
      footerLeft: (max) => gray(shortenPath(this.#folderLabel(), max)),
      footerRight: [
        `${color.bold('shift+tab')} ${gray('mode')}   ${color.bold('ctrl+p')} ${gray('menu')}   ${color.bold('/')} ${gray('commands')}   ${color.bold('↑↓')} ${gray('history')}`,
        `${color.bold('shift+tab')} ${gray('mode')}   ${color.bold('ctrl+p')} ${gray('menu')}   ${color.bold('/')} ${gray('commands')}`,
        `${color.bold('shift+tab')} ${gray('mode')}   ${color.bold('/')} ${gray('commands')}`,
        `${color.bold('/')} ${gray('commands')}`,
      ],
    };
  }

  #commandList() {
    const builtin = Object.entries(COMMANDS)
      .filter(([, c]) => !c.hidden)
      .map(([name, c]) => ({ name, usage: c.usage, description: c.description, takesArg: /[[<]/.test(c.usage) }));
    const custom = listCustomCommands(this.agent.guard.root)
      .filter((c) => !COMMANDS[c.name])
      .map((c) => ({ name: c.name, usage: `/${c.name} [text]`, description: c.description, takesArg: true }));
    return [...builtin, ...custom];
  }

  /** Start screen: big logo, centred prompt box. Returns the first input (or null). */
  async #homePrompt() {
    const cols = stdout.columns || 80;
    const rows = stdout.rows || 24;
    this.input.clearScreen();
    const { lines, width } = logoLines(cols);
    stdout.write('\n'.repeat(Math.max(1, Math.floor((rows - 18) / 2))));
    for (const l of lines) stdout.write(`${centre(l, width, cols)}\n`);
    const mode = this.agent.mode === 'plan' ? 'plan' : 'build';
    const providerName = this.settings.provider || this.provider?.name || 'connected';
    const panel = homePanel({ cols, version: this.version, model: this.agent.model, provider: providerName, mode, folder: this.#folderLabel() });
    stdout.write(`\n${panel}\n\n`);
    const maxWidth = Math.min(76, cols - 5);
    return this.input.prompt({
      state: () => this.#promptState(),
      commands: this.#commandList(),
      margin: Math.max(2, Math.floor((cols - maxWidth) / 2)),
      maxWidth,
      placeholder: 'What should we build today?  ( / for commands )',
      echo: false,
    });
  }

  async start() {
    if (!this.input.isTTY) process.on('SIGINT', () => (this.running ? this.#abortRun() : this.#quit()));
    this.#installSignalHandlers();
    this.input.attach();

    await this.getModels();

    if (this.models.length && !this.models.some((m) => m.id === this.agent.model)) {
      this.banner();
      console.log(color.yellow(`Model "${this.agent.model}" is not in Puter's list. Please pick one.`));
      await chooseModel(this, '');
    }

    let first = true;
    for (;;) {
      let line;
      if (first && this.input.isTTY) {
        line = await this.#homePrompt();
        if (line !== null && line.trim()) {
          // leave the start screen: compact header, then the message as a panel
          this.input.clearScreen();
          this.banner();
          stdout.write(`${this.input.echo(line, { margin: 2, maxWidth: 100, state: () => this.#promptState() })}\n`);
        } else if (line !== null) {
          continue;
        }
      } else {
        if (first) this.banner();
        line = await this.input.prompt({
          state: () => this.#promptState(),
          commands: this.#commandList(),
          margin: 2,
          maxWidth: 100,
        });
      }
      first = false;
      if (line === null) return;
      line = line.trim();
      if (!line) continue;
      if (line.startsWith('/')) {
        const name = line.slice(1).split(/\s/)[0].toLowerCase();
        const custom = line === '/' || COMMANDS[name] ? null : expandCustomCommand(this.agent.guard.root, line);
        if (custom) await this.#runTask(custom);
        else await runCommand(this, line === '/' ? '/menu' : line);
      } else {
        await this.#runTask(line);
      }
    }
  }

  // Run `fn` with the spinner paused (prompts must not fight with the animation).
  async #paused(fn) {
    const was = this.spinner.active;
    const label = this.spinner.label;
    this.spinner.stop();
    try {
      return await fn();
    } finally {
      if (was) this.spinner.start(label);
    }
  }

  /**
   * Approval prompt used by the Permissions layer. Shows the exact operation (command line, path,
   * diff) before anything runs. Returns 'once' | 'always' | false | 'never' | 'cancel'.
   * "always"/"never" last for this session only.
   */
  async confirm(description, action) {
    return this.#paused(async () => {
      const [what, risk] = ACTION_TITLE[action] ?? ['Approval needed', 'warn'];
      const tone = risk === 'danger' ? color.red : risk === 'info' ? violet : orange;
      const scope = ACTION_LABEL[action];
      const plan = this.agent.mode === 'plan';
      const access = this.agent.permissions.accessLevel;
      const tool = this.currentTool?.name;
      const context = [
        `${color.bold(plan ? 'PLAN' : 'BUILD')} mode`,
        `access: ${access}`,
        tool ? `tool: ${tool}${this.step ? ` (step ${this.step})` : ''}` : null,
      ].filter(Boolean).join(`  ${sym.sep}  `);
      const lines = [gray(context), '', ...String(description).split('\n').map((l) => l.trimEnd())];
      const choice = await this.input.choose(
        `${what}`,
        [
          { key: 'o', aliases: ['y', '1'], label: 'Allow once (only this)', value: 'once' },
          { key: 'a', aliases: ['2'], label: scope ? `Always: ${scope} (this session)` : 'Always: this kind (this session)', value: 'always' },
          { key: 'n', aliases: ['r', '3'], label: 'Reject (agent tries another way)', value: false },
          { key: 'v', aliases: ['4'], label: scope ? `Never: ${scope} (this session)` : 'Never: this kind (this session)', value: 'never' },
          { key: 'x', aliases: ['5'], label: 'Reject and cancel the whole task', value: 'cancel' },
        ],
        { signal: this.abort?.signal, lines, accent: tone, hint: 'o once · a always · n reject · v never · x cancel task · ↑/↓ · Enter · Esc reject' },
      );
      const verdict =
        choice === 'always' ? `always allowed for this session: ${scope ?? what}  ${sym.sep}  /permissions reset to undo`
        : choice === 'once' ? `allowed once: ${what}`
        : choice === 'never' ? `denied for this session: ${scope ?? what}  ${sym.sep}  /permissions reset to undo`
        : choice === 'cancel' ? 'rejected - cancelling the task'
        : `rejected: ${what}`;
      const allowed = choice === 'once' || choice === 'always';
      stdout.write(`  ${allowed ? color.green(sym.ok) : color.red(sym.fail)} ${gray(verdict)}\n`);
      this.transcript.add('event', verdict);
      return choice;
    });
  }

  /** Used by the ask_user tool. Returns the typed answer (or null if cancelled). */
  async ask(question, options = []) {
    return this.#paused(async () => {
      const lines = [question, ...options.map((o, i) => `${gray(`${i + 1}.`)} ${o}`)];
      stdout.write(`\n${card('The agent asks', lines, '', violet)}\n`);
      const answer = (await this.input.question('Your answer', { signal: this.abort?.signal })).trim();
      if (!answer && !this.running) return null;
      const n = Number(answer);
      return options.length && Number.isInteger(n) && options[n - 1] ? options[n - 1] : answer;
    });
  }

  /** Run one request and return (used by `-p "prompt"` and by /init). */
  async runOnce(text) {
    await this.#runTask(text);
  }

  async #runTask(text) {
    if (this.running) {
      this.notify('Busy', 'A task is already running. Press Ctrl+C to cancel it first.', 'warning');
      return;
    }
    this.running = true;
    this.abort = new AbortController();
    this.phases.reset();
    this.pending = 0;
    this.streamed = 0;
    this.transcript.add('user', text);
    const startedAt = Date.now();
    try {
      const result = await this.agent.run(text, {
        signal: this.abort.signal,
        emit: (event) => this.#render(event),
        onDelta: (_delta, full) => {
          this.streamed = full.length;
          this.spinner.update(`${paint.faint('[Answer] ')}Writing`, `${this.streamed} chars`);
        },
      });
      this.spinner.stop();
      this.#renderResult(result, Date.now() - startedAt);
    } catch (err) {
      this.spinner.stop();
      this.#renderError(err);
    } finally {
      this.spinner.stop();
      this.running = false;
      this.abort = null;
      this.currentTool = null;
    }
  }

  /** Compact toast-style notification used for important lifecycle feedback. */
  notify(title, message, kind = 'info') {
    const tone = kind === 'error' ? color.red : kind === 'success' ? color.green : kind === 'warning' ? orange : violet;
    const icon = kind === 'error' ? sym.fail : kind === 'success' ? sym.ok : kind === 'warning' ? sym.warn : sym.ai;
    const body = String(message ?? '').split('\n').map((line) => `  ${line.length > 110 ? `${line.slice(0, 109)}…` : line}`);
    stdout.write(`\n${card(`${icon} ${title}`, body, 'Puter Agent', tone)}\n`);
    this.transcript.add('event', `${title}: ${message}`);
  }

  printTodos(todos = []) {
    const mark = { completed: color.green(sym.ok), in_progress: orange('◐'), pending: gray('○') };
    for (const t of todos) {
      const text = t.status === 'completed' ? gray(t.content) : t.status === 'in_progress' ? sBold(t.content) : t.content;
      console.log(`      ${mark[t.status] ?? '○'} ${text}`);
    }
  }

  /** Print lines above the live line without the two overlapping (stop, write, resume). */
  #print(...lines) {
    const was = this.spinner.active;
    this.spinner.stop();
    for (const l of lines) console.log(l);
    if (was && this.running) this.spinner.start(this.#liveLabel());
  }

  #liveLabel() {
    if (this.pending > 1) return `${paint.faint('[Explore] ')}Running ${this.pending} tools in parallel`;
    return this.currentTool ? workingLabel(this.currentTool.name, this.currentTool.args) : 'Thinking';
  }

  #render(event) {
    const width = stdout.columns || 80;
    switch (event.type) {
      case 'analysis':
        if (this.ui.showPhases && event.kind !== 'chat') {
          const tone = event.complexity === 'complex' ? paint.warm : event.complexity === 'moderate' ? paint.info : paint.ok;
          console.log(`  ${paint.faint(icons.think)} ${paint.muted(`${event.kind} ${icons.sep}`)} ${tone(event.complexity)}${event.signals?.length ? paint.faint(`  (${event.signals.join(', ')})`) : ''}`);
        }
        break;
      case 'thinking':
        this.step = event.step;
        this.spinner.step = event.step;
        if (event.step > 1) this.phases.enter(this.phases.current === 'analyze' ? 'explore' : this.phases.current);
        this.currentTool = null;
        this.spinner.start(event.step > 1 ? 'Thinking about the results' : 'Thinking');
        this.spinner.update(event.step > 1 ? 'Thinking about the results' : 'Thinking', '');
        break;
      case 'usage':
        if (event.totals?.totalTokens) this.spinner.update(undefined, `${event.totals.totalTokens.toLocaleString()} tok`);
        break;
      case 'assistant_text':
        this.spinner.stop();
        console.log(`\n${this.#speak(event.text.trim())}\n`);
        this.transcript.add('assistant', event.text.trim());
        break;
      case 'text_tool_calls':
        this.spinner.stop();
        console.log(gray(`  (the model wrote ${event.count} tool call(s) as text - running them anyway)`));
        break;
      case 'protocol':
        this.spinner.stop();
        console.log(orange(`  ${sym.warn} this model rejected native tool calling - switched to prompt-mode tools`));
        break;
      case 'parallel':
        this.pending = event.count;
        this.parallelLeft = event.count;
        break;
      case 'tool_call': {
        this.spinner.stop();
        this.phases.fromTool(event.name);
        this.currentTool = { name: event.name, args: event.args };
        console.log(toolCallLine(event.name, event.args, { parallel: event.parallel, width }));
        this.transcript.add('tool', `${event.name} ${argSummary(event.args, 120)}`);
        this.toolStartedAt = Date.now();
        this.spinner.start(this.#liveLabel());
        this.spinner.update(this.#liveLabel(), '');
        break;
      }
      case 'tool_result': {
        const ms = event.ms || Date.now() - this.toolStartedAt;
        this.spinner.stop();
        if (this.pending > 0) this.pending--;
        const res = event.result;
        const inBatch = this.parallelLeft > 0;
        if (inBatch) this.parallelLeft--;
        console.log(toolResultLine(res, { ms, width, label: inBatch ? event.name : '' }));
        if (res.ok) {
          const body = res.result ?? {};
          if (body.stdout !== undefined || body.stderr !== undefined) {
            const text = redactSecrets([body.stdout, body.stderr].filter((x) => x && x.trim()).join('\n'));
            for (const l of outputTail(text, { width })) console.log(l);
          }
          if (body.timed_out) console.log(orange(`    ${sym.warn} stopped by its time limit - the agent sees the partial output and will adapt`));
          if (event.name === 'todo_write') this.printTodos(body.todos);
          if (event.name === 'web_search') {
            for (const r of (body.results ?? []).slice(0, 4)) console.log(paint.faint(`      ${icons.bar} `) + paint.muted(`${String(r.title ?? '').slice(0, 60)}  `) + paint.faint(String(r.url ?? '').slice(0, 70)));
          }
          if (body.outline && body.chunked) console.log(paint.faint(`      ${icons.bar} large file: ${body.outline.length} definitions outlined, reading in sections`));
        }
        if (this.running && (this.pending > 0 || this.currentTool)) {
          this.spinner.start(this.#liveLabel());
          this.spinner.update(this.#liveLabel(), '');
        }
        break;
      }
      case 'deduped':
        this.#print(paint.faint(`      ${icons.bar} `) + paint.warn(`${icons.cache} identical to an earlier result - not sent to the model again`));
        break;
      case 'checkpoint':
        this.#print(orange(`  ${sym.warn} step budget for this kind of task reached (${event.budget}) - asking the agent to re-check its plan`));
        break;
      case 'verify_nudge':
        this.spinner.stop();
        console.log(orange(`  ${sym.warn} code changed but not run - asking the agent to verify before finishing`));
        break;
      case 'compacted':
        this.spinner.stop();
        console.log(gray(`  ${sym.mid} long conversation: older messages were summarised locally (no extra model call)`));
        break;
      case 'context_compressed':
        break;
      case 'model_tier':
        console.log(paint.faint(`  ${icons.think} using ${event.model} (${event.reason})`));
        break;
      case 'mentions':
        console.log(gray(`  ${sym.mid} attached: ${event.files.join(', ')}`));
        break;
      case 'retry':
        this.spinner.stop();
        console.log(color.yellow(`  ${sym.warn} ${event.error.kind}: ${String(event.error.message ?? '').slice(0, 200)} - retry ${event.attempt}/${event.retries} in ${(event.delayMs / 1000).toFixed(1)}s`));
        break;
      default:
    }
  }

  #renderResult({ content, stopReason, steps, changes, usage }, elapsedMs) {
    const width = stdout.columns || 80;
    if (stopReason === 'aborted') {
      console.log(color.yellow('\nCancelled. Type "continue" to resume, or give a new instruction.\n'));
    } else if (stopReason === 'max_steps') {
      console.log(color.yellow(`\nStopped after ${steps} steps (limit: maxSteps in config/settings.json). Type "continue" to let the agent keep going.\n`));
    } else if (stopReason === 'stuck') {
      this.notify('Agent paused', 'The agent repeated the same tool call without progress. Give it a hint or a different instruction.', 'error');
    } else {
      this.phases.enter('done');
      const text = content.trim() || '(no text reply)';
      console.log(`\n${this.#speak(text)}\n`);
      this.transcript.add('assistant', text);
      if (this.ui.showPhases && steps > 1) console.log(this.phases.render());
    }
    if (this.ui.statusBar) {
      const info = this.agent.contextInfo();
      console.log(statusBar({ usage: usage ?? {}, context: { tokens: info.tokens, percent: info.tokenPercent }, cache: info.cache, elapsedMs, steps, width }));
    }
    console.log('');
    const panel = changesPanel(changes);
    if (panel.length) console.log(`${panel.join('\n')}\n`);
  }

  #renderError(err) {
    const kind = classifyError(err).kind;
    if (kind === ErrorKind.ABORTED) {
      console.log(color.yellow('\nCancelled.\n'));
      return;
    }
    this.notify('Something went wrong', explainError(err), 'error');
  }
}
