import os from 'node:os';
import { stdin, stdout } from 'node:process';
import { Spinner, card, color, gray, orange, sym, teal, violet } from '../utils/logger.js';
import { renderMarkdownToTerminal } from '../utils/markdown-to-terminal.js';
import { resolveTheme } from './themes.js';
import { classifyError, ErrorKind, explainError } from '../utils/errors.js';
import { COMMANDS, chooseModel, runCommand } from './commands.js';
import { centre, logoLines } from './home.js';
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
  web_search: violet,
  web_fetch: violet,
};

const ACTION_LABEL = {
  runCommand: 'all commands / scripts',
  deleteFile: 'all deletes',
  overwriteFile: 'all overwrites',
  moveFile: 'all moves',
  editFile: 'all edits',
  createFile: 'all file creation',
  outside: 'outside-workspace access',
  readSecret: 'reading secret files',
};

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
    const mode = this.agent.mode === 'plan' ? orange('plan (read-only)') : teal('build');
    console.log(
      `\n${card(
        `Puter Agent ${gray(`v${this.version}`)}`,
        [
          `${gray('model  ')} ${this.agent.model}${this.thinkingLabel()}`,
          `${gray('mode   ')} ${mode}`,
          `${gray('folder ')} ${this.agent.guard.root}`,
        ],
        gray(`/help commands ${sym.sep} /plan /build ${sym.sep} Ctrl+C cancels`),
        violet,
      )}\n`,
    );
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
      footerLeft: gray(this.#folderLabel()),
      footerRight: `${color.bold('shift+tab')} ${gray('mode')}   ${color.bold('ctrl+p')} ${gray('commands')}`,
    };
  }

  #commandList() {
    return Object.entries(COMMANDS)
      .filter(([, c]) => !c.hidden)
      .map(([name, c]) => ({ name, usage: c.usage, description: c.description, takesArg: /[[<]/.test(c.usage) }));
  }

  /** Start screen: big logo, centred prompt box. Returns the first input (or null). */
  async #homePrompt() {
    const cols = stdout.columns || 80;
    const rows = stdout.rows || 24;
    this.input.clearScreen();
    const { lines, width } = logoLines(cols);
    stdout.write('\n'.repeat(Math.max(1, Math.floor((rows - 18) / 2))));
    for (const l of lines) stdout.write(`${centre(l, width, cols)}\n`);
    const sub = `v${this.version}  ${sym.sep}  ${this.agent.model}`;
    stdout.write(`\n${centre(orange('/help') + gray(` commands  ${sym.sep}  ${sub}`), 5 + 11 + stringWidth(sub), cols)}\n\n`);
    const maxWidth = Math.min(76, cols - 5);
    return this.input.prompt({
      state: () => this.#promptState(),
      commands: this.#commandList(),
      margin: Math.max(2, Math.floor((cols - maxWidth) / 2)),
      maxWidth,
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
        await runCommand(this, line === '/' ? '/help' : line);
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
      const lines = String(description).split('\n').map((l) => l.trimEnd());
      const scope = ACTION_LABEL[action];
      stdout.write(`\n${card('Permission needed', lines, '', orange)}\n`);
      const choice = await this.input.choose(
        'Permission',
        [
          { key: 'o', aliases: ['y', '1'], label: 'Allow once', value: 'once' },
          { key: 'a', aliases: ['2'], label: scope ? `Always (${scope}, this session)` : 'Always (this session)', value: 'always' },
          { key: 'n', aliases: ['r', '3'], label: 'Reject', value: false },
        ],
        { signal: this.abort?.signal },
      );
      stdout.write(`  ${choice ? color.green(sym.ok) : color.red(sym.fail)} ${gray(choice === 'always' ? 'allowed for this session' : choice ? 'allowed once' : 'rejected')}\n`);
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

  #renderResult({ content, stopReason, steps, changes }, elapsedMs) {
    if (stopReason === 'aborted') {
      console.log(color.yellow('\nCancelled. Type "continue" to resume, or give a new instruction.\n'));
    } else if (stopReason === 'max_steps') {
      console.log(
        color.yellow(`\nStopped after ${steps} steps (limit: maxSteps in config/settings.json). Type "continue" to let the agent keep going.\n`),
      );
    } else if (stopReason === 'stuck') {
      console.log(color.red('\nStopped: the same tool call failed 3 times in a row. Give the agent a hint or a different instruction.\n'));
    } else {
      const rendered = renderMarkdownToTerminal(content.trim() || '(no text reply)');
      const th = this.theme;
      const assistantPaint = typeof th.assistant === 'function' ? th.assistant : (s) => th.assistant ? th.assistant(s) : violet(sym.ai);
      console.log(`\n${assistantPaint(sym.ai)} ${rendered}\n`);
      console.log(gray(`  ${sym.ok} done ${sym.sep} ${steps} step(s) ${sym.sep} ${fmtTime(elapsedMs)}\n`));
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
    console.log(color.red(`\n${sym.fail} ${explainError(err)}\n`));
  }
}
