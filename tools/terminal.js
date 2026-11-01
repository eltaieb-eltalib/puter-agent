import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { ToolError } from '../utils/errors.js';
import { checkCommandRules } from '../security/command-rules.js';
import { display, requireApproval, resolvePath } from './helpers.js';

// Defence in depth, NOT a sandbox: a few catastrophic patterns are refused outright,
// before the user is even asked. Everything else still needs explicit approval.
const BLOCKED = [
  [/\bformat(\.com)?\s+[a-z]:/i, 'disk format'],
  [/\bdiskpart\b/i, 'diskpart'],
  [/\b(shutdown|poweroff|reboot)\b/i, 'shutdown/reboot'],
  [/\b(bcdedit|vssadmin|cipher\s+\/w)\b/i, 'system/boot/backup tampering'],
  [/\breg(\.exe)?\s+(delete|add|import)\b/i, 'registry modification'],
  [/\brm\s+(-\w*\s+)*-\w*[rf]\w*\s+(-\w+\s+)*(\/|~|\$HOME|\*)(\s|$)/i, 'recursive delete of root/home'],
  [/\b(del|erase)\b[^\n]*\s\/[sq][^\n]*\s[a-z]:\\?(\s|$)/i, 'delete of a whole drive'],
  [/\b(rd|rmdir)\b[^\n]*\s\/s[^\n]*\s[a-z]:\\?(\s|$)/i, 'delete of a whole drive'],
  [/remove-item[^\n]*-recurse[^\n]*\s[a-z]:\\?(\s|$)/i, 'delete of a whole drive'],
  [/(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)[^\n|]*\|\s*(sh|bash|iex|invoke-expression|powershell|cmd)\b/i, 'download piped into a shell'],
];

export function findBlockedPattern(command) {
  for (const [re, label] of BLOCKED) if (re.test(command)) return label;
  return null;
}

function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

export function runProcess(file, args, { cwd, shell, timeoutMs, idleMs = 0, signal, maxOutput }) {
  return new Promise((resolve) => {
    // Never hand the Puter token to commands the model asked us to run.
    const env = { ...process.env };
    // Provider credentials must never be inherited by shell commands launched by the agent.
    delete env.PUTER_AUTH_TOKEN;
    delete env.GEMINI_API_KEY;
    delete env.OPENAI_API_KEY;

    const child = spawn(file, args, {
      cwd,
      shell,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'], // no stdin: interactive programs fail fast instead of hanging
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let truncated = false;
    let finished = false;
    let reason = null;
    let idleTimer = null;

    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      if (next.length <= maxOutput) return next;
      truncated = true;
      return next.slice(-maxOutput); // keep the tail: errors are usually at the end
    };
    const stop = (why) => {
      timedOut = true;
      reason = why;
      killTree(child);
    };
    // Idle watchdog: a command that prints nothing for a long time is almost certainly stuck
    // (waiting for input, a server that never exits, ...). Any output resets it.
    const bumpIdle = () => {
      if (!idleMs) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop('idle'), idleMs);
    };
    child.stdout.on('data', (d) => {
      stdout = append(stdout, d);
      bumpIdle();
    });
    child.stderr.on('data', (d) => {
      stderr = append(stderr, d);
      bumpIdle();
    });
    bumpIdle();

    const timer = setTimeout(() => stop('total'), timeoutMs);
    const onAbort = () => killTree(child);
    signal?.addEventListener('abort', onAbort, { once: true });

    const done = (extra) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(idleTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ ...extra, stdout, stderr, timed_out: timedOut, timeout_reason: reason, output_truncated: truncated });
    };
    child.on('error', (err) => done({ exit_code: null, error: err.message }));
    child.on('close', (code, sig) => done({ exit_code: code, signal: sig }));
  });
}

export function timeoutFor(ctx, requested) {
  const fallback = ctx.settings.limits.commandTimeoutMs;
  const ms = Number.isFinite(requested) && requested > 0 ? requested : fallback;
  return Math.min(ms, 600000);
}

export function idleFor(ctx, requested) {
  const fallback = ctx.settings.limits.commandIdleMs ?? 30000;
  const ms = Number.isFinite(requested) && requested >= 0 ? requested : fallback;
  return Math.min(ms, 600000);
}

export function summarize(res) {
  if (res.timed_out) return res.timeout_reason === 'idle' ? 'timed out (no output for too long)' : 'timed out';
  if (res.error) return `failed to start: ${res.error}`;
  return `exit code ${res.exit_code}`;
}

/** Final result for the model: always includes stdout/stderr (even partial) so it can decide the next step. */
export function finish(res) {
  const out = { ...res, success: res.exit_code === 0, summary: summarize(res) };
  if (res.timed_out) {
    out.note =
      res.timeout_reason === 'idle'
        ? 'The command was cancelled because it printed nothing for too long (it may be waiting for input or running a server). Output captured so far is included. Do not retry it unchanged: use a non-interactive/bounded variant, or raise idle_timeout_ms only if it is really silent but working.'
        : 'The command was cancelled because it exceeded its time limit. Output captured so far is included. Do not retry it unchanged: use a faster/bounded variant, or raise timeout_ms only if the work really needs it.';
  }
  return out;
}

const runCommandTool = {
  name: 'run_command',
  description:
    'Run a shell command (cmd.exe on Windows, sh elsewhere) and return its output. cwd defaults to the workspace; an absolute cwd anywhere on the system is allowed (subject to the access level). The user is shown the exact command and must approve it. Use it for things like "node --check file.js" or "npm test". Interactive programs cannot be used (no stdin).',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The full command line.' },
      cwd: { type: 'string', description: 'Working directory: relative to the workspace, or an absolute path anywhere on the system. Default ".".' },
      timeout_ms: { type: 'integer', description: 'Hard time limit in ms. Set it to what the command SHOULD take plus a margin (quick checks 10000-20000, installs/builds 120000-300000). The command is killed when it is exceeded. Max 600000.' },
      idle_timeout_ms: { type: 'integer', description: 'Kill the command if it prints nothing for this many ms (default 30000; 0 disables).' },
    },
    required: ['command'],
  },
  async execute({ command, cwd = '.', timeout_ms, idle_timeout_ms }, ctx) {
    const blocked = findBlockedPattern(command);
    if (blocked) throw new ToolError(`Command refused by the safety policy (${blocked}).`);
    const dir = await resolvePath(ctx, cwd, 'run a command in');
    const rule = checkCommandRules(command, ctx.settings.rules);
    if (rule === 'deny') throw new ToolError('Command refused: it matches a deny rule in settings.rules.denyCommands. Use another approach.');
    if (rule !== 'allow') await requireApproval(ctx, 'runCommand', `Run command in ${display(ctx, dir)}:\n    ${command}`);
    const res = await runProcess(command, [], {
      cwd: dir,
      shell: true,
      timeoutMs: timeoutFor(ctx, timeout_ms),
      idleMs: idleFor(ctx, idle_timeout_ms),
      signal: ctx.signal,
      maxOutput: ctx.settings.limits.maxCommandOutputChars,
    });
    return finish(res);
  },
};

const runNodeTool = {
  name: 'run_node',
  description:
    'Run a JavaScript file with Node.js (no shell) from the workspace root and return its output. The user must approve it because it executes code.',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Script path, relative to the workspace root.' },
      args: { type: 'array', items: { type: 'string' }, description: 'Command-line arguments (strings).' },
      cwd: { type: 'string', description: 'Working directory (relative to the workspace, or an absolute path anywhere on the system). Default: workspace root.' },
      timeout_ms: { type: 'integer', description: 'Hard time limit in ms. Set it to what the command SHOULD take plus a margin (quick checks 10000-20000, installs/builds 120000-300000). The command is killed when it is exceeded. Max 600000.' },
      idle_timeout_ms: { type: 'integer', description: 'Kill the command if it prints nothing for this many ms (default 30000; 0 disables).' },
    },
    required: ['file'],
  },
  async execute({ file, args = [], cwd, timeout_ms, idle_timeout_ms }, ctx) {
    if (!args.every((a) => typeof a === 'string')) throw new ToolError('args must be an array of strings.');
    const abs = await resolvePath(ctx, file, 'run a script at');
    const workDir = cwd ? await resolvePath(ctx, cwd, 'run a script in') : ctx.guard.root;
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) throw new ToolError(`"${file}" is not a file.`);
    } catch (err) {
      if (err.code === 'ENOENT') throw new ToolError(`Script not found: ${file}`);
      throw err;
    }
    await requireApproval(
      ctx,
      'runCommand',
      `Run Node.js script: node ${display(ctx, abs)}${args.length ? ` ${args.join(' ')}` : ''}`,
    );
    const res = await runProcess(process.execPath, [abs, ...args], {
      cwd: workDir,
      shell: false,
      timeoutMs: timeoutFor(ctx, timeout_ms),
      idleMs: idleFor(ctx, idle_timeout_ms),
      signal: ctx.signal,
      maxOutput: ctx.settings.limits.maxCommandOutputChars,
    });
    return finish(res);
  },
};


const PY_CANDIDATES = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];

const runPythonTool = {
  name: 'run_python',
  description:
    'Run a Python script from the workspace (no shell) and return its output. Handy for data work, scraping with urllib/requests, parsing files or quick calculations when Node.js is not the best fit. Write the script with create_file first. The user must approve it because it executes code.',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Script path, relative to the workspace root.' },
      args: { type: 'array', items: { type: 'string' }, description: 'Command-line arguments (strings).' },
      cwd: { type: 'string', description: 'Working directory (relative to the workspace, or an absolute path anywhere on the system). Default: workspace root.' },
      timeout_ms: { type: 'integer', description: 'Hard time limit in ms. Set it to what the command SHOULD take plus a margin (quick checks 10000-20000, installs/builds 120000-300000). The command is killed when it is exceeded. Max 600000.' },
      idle_timeout_ms: { type: 'integer', description: 'Kill the command if it prints nothing for this many ms (default 30000; 0 disables).' },
    },
    required: ['file'],
  },
  async execute({ file, args = [], cwd, timeout_ms, idle_timeout_ms }, ctx) {
    if (!args.every((a) => typeof a === 'string')) throw new ToolError('args must be an array of strings.');
    const abs = await resolvePath(ctx, file, 'run a script at');
    const workDir = cwd ? await resolvePath(ctx, cwd, 'run a script in') : ctx.guard.root;
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) throw new ToolError(`"${file}" is not a file.`);
    } catch (err) {
      if (err.code === 'ENOENT') throw new ToolError(`Script not found: ${file}`);
      throw err;
    }
    await requireApproval(
      ctx,
      'runCommand',
      `Run Python script: python ${display(ctx, abs)}${args.length ? ` ${args.join(' ')}` : ''}`,
    );
    let res;
    for (const exe of PY_CANDIDATES) {
      res = await runProcess(exe, [abs, ...args], {
        cwd: workDir,
        shell: false,
        timeoutMs: timeoutFor(ctx, timeout_ms),
      idleMs: idleFor(ctx, idle_timeout_ms),
        signal: ctx.signal,
        maxOutput: ctx.settings.limits.maxCommandOutputChars,
      });
      if (!(res.error && /ENOENT/.test(res.error))) break; // interpreter exists (or failed for another reason)
    }
    if (res.error && /ENOENT/.test(res.error)) {
      throw new ToolError('Python is not installed or not on PATH. Use run_node / run_command with Node.js instead.');
    }
    return finish(res);
  },
};

export const terminalTools = [runCommandTool, runNodeTool, runPythonTool];

