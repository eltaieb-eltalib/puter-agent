import os from 'node:os';
import { stdin, stdout } from 'node:process';
import { Spinner, card, color, gray, orange, sym, teal, violet } from '../utils/logger.js';
import { renderMarkdownToTerminal } from '../utils/markdown-to-terminal.js';
import { resolveTheme } from './themes.js';
import { classifyError, ErrorKind, explainError } from '../utils/errors.js';
import { COMMANDS, chooseModel, runCommand } from './commands.js';
import { expandCustomCommand, listCustomCommands } from '../core/custom-commands.js';
import { centre, logoLines, homePanel } from './home.js';
import { createInput, stringWidth } from './input.js';
import { redactSecrets } from '../utils/redact.js';

const oneLine = (value, max = 100) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

function summarizeArgs(args = {}) {
  const key = ['path', 'file', 'command', 'query', 'url', 'question', 'from'].find((k) => args[k] !== undefined);
  if (!key) return '';
  const extra = args.to ? `  →  ${args.to}` : '';
  return oneLine(`${args[key]}${extra}`);
}

const fmtTime = (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

// What the user sees in the spinner while a tool is working.
function workingLabel(name, args = {}) {
  const target = summarizeArgs(args);
  switch (name) {
    case 'create_file':
      return `Building ${target}`;
    case 'edit_file':
      return `Editing ${target}`;
    case 'run_command':
    case 'run_node':
    case 'run_python':
      return `Running ${target}`;
    case 'web_search':
      return `Searching the web: ${target}`;
    case 'web_fetch':
      return `Reading ${target}`;
    case 'read_file':
    case 'list_files':
    case 'search_files':
      return `Reading ${target}`;
    default:
      return `Working: ${name}`;
  }
}

const TOOL_COLOR = {
  create_file: orange,
  edit_file: orange,
  delete_file: orange,
  move_file: orange,
  create_directory: orange,
  run_command: teal,
  run_node: teal,
  run_python: teal,
  open_path: teal,
  web_search: violet,
  web_fetch: violet,
};

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
    this.spinner = new Spinner(stdout);
    this.toolStartedAt = 0;
    this.theme = resolveTheme(tui);
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

  banner() {
    const mode = this.agent.mode === 'plan' ? orange('PLAN · READ ONLY') : teal('BUILD · ACTIVE');
    const providerName = this.provider?.name || this.provider?.id || this.settings.provider || 'connected';
    const width = Math.max(34, Math.min(76, (stdout.columns || 80) - 8));
    const rule = violet(`  ╭${'─'.repeat(width)}╮`);
    const edge = violet('  │');
    const end = violet(`  ╰${'─'.repeat(width)}╯`);
    console.log(`\n${rule}\n${edge}  ${violet(sym.ai)} ${color.bold('PUTER AGENT')} ${gray(`v${this.version}`)}${' '.repeat(Math.max(1, width - 27 - String(this.version).length))}${edge}\n${edge}  ${gray('MODEL')}  ${color.bold(this.agent.model)}${gray(this.thinkingLabel())}${edge}\n${edge}  ${gray('ENGINE')} ${providerName}   ${gray('MODE')} ${mode}${edge}\n${edge}  ${gray('WORKSPACE')} ${this.#folderLabel()}${edge}\n${end}\n  ${gray('/help')} ${gray('commands')}  ${sym.sep}  ${gray('Shift+Tab')} ${gray('switch mode')}  ${sym.sep}  ${gray('Ctrl+C')} ${gray('cancel')}\n`);
  }

  /** Non-interactive: run one request (`-p "text"`), then exit. */
  async startOnce(text) {
    // Non-interactive: do not create a readline interface.
    await this.#runTask(text);
    // Ensure the CLI exits after the single request finishes.
    // This prevents watchdog idle issues on some environments.
    process.exit(0);
  }

  #quit() {
    this.spinner.stop();
    this.input.detach();
    stdout.write('\n');
    process.exit(0);
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
   * Approval prompt used by the Permissions layer.
   * Returns 'once' | 'always' | false. "always" lasts for this session only.
   */
  async confirm(description, action) {
    return this.#paused(async () => {
      const [what, risk] = ACTION_TITLE[action] ?? ['Approval needed', 'warn'];
      const paint = risk === 'danger' ? color.red : risk === 'info' ? violet : orange;
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
        ],
        { signal: this.abort?.signal, lines, accent: paint, hint: 'o once · a always · n reject · ↑/↓ move · Enter confirm · Esc reject' },
      );
      const verdict = choice === 'always' ? `always allowed for this session: ${scope ?? what}  ${sym.sep}  /permissions reset to undo` : choice ? `allowed once: ${what}` : `rejected: ${what}`;
      stdout.write(`  ${choice ? color.green(sym.ok) : color.red(sym.fail)} ${gray(verdict)}\n`);
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
    this.running = true;
    this.abort = new AbortController();
    const startedAt = Date.now();
    try {
      const result = await this.agent.run(text, {
        signal: this.abort.signal,
        emit: (event) => this.#render(event),
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
    }
  }

  /** Compact toast-style notification used for important lifecycle feedback. */
  notify(title, message, kind = 'info') {
    const paint = kind === 'error' ? color.red : kind === 'success' ? color.green : kind === 'warning' ? orange : violet;
    const icon = kind === 'error' ? sym.fail : kind === 'success' ? sym.ok : kind === 'warning' ? sym.warn : sym.ai;
    const body = String(message ?? '').split('\n').map((line) => `  ${oneLine(line, 110)}`);
    stdout.write(`\n${card(`${icon} ${title}`, body, 'Puter Agent', paint)}\n`);
  }

  printTodos(todos = []) {
    const mark = { completed: color.green(sym.ok), in_progress: orange('◐'), pending: gray('○') };
    for (const t of todos) {
      const text = t.status === 'completed' ? gray(t.content) : t.content;
      console.log(`      ${mark[t.status] ?? '○'} ${text}`);
    }
  }

  #printOutput(res) {
    const text = redactSecrets([res.stdout, res.stderr].filter((s) => s && s.trim()).join('\n').trimEnd());
    if (!text) return;
    const lines = text.split(/\r?\n/);
    const shown = lines.slice(-8);
    if (lines.length > shown.length) console.log(gray(`      ${sym.mid} … ${lines.length - shown.length} earlier line(s)`));
    for (const l of shown) console.log(gray(`      ${sym.mid} ${oneLine(l, 110)}`));
  }

  #render(event) {
    switch (event.type) {
      case 'thinking':
        this.step = event.step;
        this.spinner.start(event.step > 1 ? 'Thinking about the result' : 'Thinking');
        this.spinner.update(event.step > 1 ? 'Thinking about the result' : 'Thinking');
        break;
      case 'assistant_text':
        this.spinner.stop();
        {
          const rendered = renderMarkdownToTerminal(event.text.trim());
          // color.* functions expect a string; sym.ai is already a string.
          const th = this.theme;
          const assistantPaint = typeof th.assistant === 'function' ? th.assistant : (s) => th.assistant ? th.assistant(s) : violet(sym.ai);
          console.log(`\n${assistantPaint(sym.ai)} ${rendered}\n`);
        }
        break;
      case 'text_tool_calls':
        this.spinner.stop();
        console.log(gray(`  (the model wrote ${event.count} tool call(s) as text - running them anyway)`));
        break;
      case 'tool_call': {
        this.spinner.stop();
        const paint = TOOL_COLOR[event.name] ?? gray;
        this.currentTool = { name: event.name, args: summarizeArgs(event.args) };
        console.log(`  ${paint(sym.dot)} ${color.bold(event.name)} ${gray(summarizeArgs(event.args))}`);
        this.toolStartedAt = Date.now();
        this.spinner.start(workingLabel(event.name, event.args));
        break;
      }
      case 'tool_result': {
        const took = fmtTime(Date.now() - this.toolStartedAt);
        this.spinner.stop();
        const res = event.result;
        if (!res.ok) {
          console.log(color.red(`    ${sym.fail} ${oneLine(res.error, 200)}`) + gray(`  ${took}`));
          break;
        }
        const body = res.result ?? {};
        const failed = body.success === false;
        const mark = failed ? color.red(sym.fail) : color.green(sym.ok);
        console.log(`    ${mark} ${failed ? color.red(body.summary ?? 'failed') : (body.summary ?? 'done')}${gray(`  ${took}`)}`);
        if (body.stdout !== undefined) this.#printOutput(body);
        if (body.timed_out) console.log(orange(`    ${sym.warn} cancelled - the agent can see the partial output and will adapt`));
        if (event.name === 'todo_write') this.printTodos(body.todos);
        if (event.name === 'web_search') {
          for (const r of (body.results ?? []).slice(0, 5)) {
            console.log(gray(`      ${sym.mid} ${oneLine(r.title, 60)}  ${oneLine(r.url, 70)}`));
          }
        }
        break;
      }
      case 'verify_nudge':
        this.spinner.stop();
        console.log(orange(`  ${sym.warn} code changed but not run - asking the agent to verify before finishing`));
        break;
      case 'compacted':
        this.spinner.stop();
        console.log(gray(`  ${sym.mid} long conversation: older messages were summarised`));
        break;
      case 'retry':
        this.spinner.stop();
        console.log(
          color.yellow(
            `  ${sym.warn} ${event.error.kind}: ${oneLine(event.error.message, 240)} - retry ${event.attempt}/${event.retries} in ${(event.delayMs / 1000).toFixed(1)}s`,
          ),
        );
        break;
      default:
    }
  }

  #renderResult({ content, stopReason, steps, changes, usage }, elapsedMs) {
    if (stopReason === 'aborted') {
      console.log(color.yellow('\nCancelled. Type "continue" to resume, or give a new instruction.\n'));
    } else if (stopReason === 'max_steps') {
      console.log(
        color.yellow(`\nStopped after ${steps} steps (limit: maxSteps in config/settings.json). Type "continue" to let the agent keep going.\n`),
      );
    } else if (stopReason === 'stuck') {
      this.notify('Agent paused', 'The same tool call failed 3 times. Give the agent a hint or a different instruction.', 'error');
    } else {
      const rendered = renderMarkdownToTerminal(content.trim() || '(no text reply)');
      const th = this.theme;
      const assistantPaint = typeof th.assistant === 'function' ? th.assistant : (s) => th.assistant ? th.assistant(s) : violet(sym.ai);
      console.log(`\n${assistantPaint(sym.ai)} ${rendered}\n`);
      console.log(gray(`  ${sym.ok} completed ${sym.sep} ${steps} step(s) ${sym.sep} ${fmtTime(elapsedMs)}`));
      if (usage?.modelCalls) {
        const tokens = Number(usage.totalTokens) || 0;
        const cached = Number(usage.cachedTokens) || 0;
        console.log(gray(`  usage: ${tokens.toLocaleString()} tokens (${cached.toLocaleString()} cached) ${sym.sep} ${usage.modelCalls} model call(s) ${sym.sep} ${usage.toolCalls} tool call(s)\n`));
      } else console.log('');
    }

    if (changes?.length) {
      console.log(color.bold('Files touched this task:') + gray('   (/undo restores them)'));
      const marks = { created: '+', overwritten: '!', edited: '~', deleted: '-', moved: '>', 'created-dir': '+' };
      for (const c of changes) console.log(`  ${marks[c.action] ?? '*'} ${c.path}  ${gray(`(${c.action})`)}`);
      console.log('');
    }
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
