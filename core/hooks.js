import { spawn } from 'node:child_process';

const HOOK_TIMEOUT_MS = 30000;
const MAX_OUTPUT = 4000;

/**
 * Hooks: user-defined shell commands that run around tool calls (like Claude Code's hooks).
 *
 *   "hooks": {
 *     "PreToolUse":  [{ "matcher": "run_command|edit_file", "command": "node check.js" }],
 *     "PostToolUse": [{ "matcher": "edit_file|multi_edit|create_file", "command": "npx prettier --write ." }]
 *   }
 *
 * matcher: regex tested against the tool name ("*" or empty = every tool).
 * The command gets a JSON event on stdin and PUTER_HOOK_EVENT / PUTER_HOOK_TOOL in the environment,
 * and runs in the workspace folder.
 * PreToolUse: exit code 0 = continue, any other code = BLOCK the tool call (stderr/stdout is shown to the model).
 * PostToolUse: output (if any) is returned to the model next to the tool result; the exit code is ignored.
 *
 * Hooks are read from config/settings.json only (never from the workspace), so a downloaded project
 * cannot install hooks that run on your machine.
 */
export class Hooks {
  constructor(config = {}, { cwd = process.cwd(), timeoutMs = HOOK_TIMEOUT_MS } = {}) {
    this.config = config && typeof config === 'object' ? config : {};
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
  }

  setCwd(cwd) {
    this.cwd = cwd;
  }

  get active() {
    return ['PreToolUse', 'PostToolUse'].some((e) => Array.isArray(this.config[e]) && this.config[e].length);
  }

  #matching(event, tool) {
    const list = Array.isArray(this.config[event]) ? this.config[event] : [];
    return list.filter((h) => {
      if (!h || typeof h.command !== 'string' || !h.command.trim()) return false;
      const m = h.matcher;
      if (!m || m === '*') return true;
      try {
        return new RegExp(`^(?:${m})$`).test(tool);
      } catch {
        return false;
      }
    });
  }

  #exec(command, payload) {
    return new Promise((resolve) => {
      const env = { ...process.env, PUTER_HOOK_EVENT: payload.event, PUTER_HOOK_TOOL: payload.tool };
      for (const k of ['PUTER_AUTH_TOKEN', 'GEMINI_API_KEY', 'OPENAI_API_KEY']) delete env[k];
      const child = spawn(command, { cwd: this.cwd, shell: true, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let done = false;
      const add = (d) => {
        out = (out + d.toString('utf8')).slice(-MAX_OUTPUT);
      };
      child.stdout.on('data', add);
      child.stderr.on('data', add);
      const finish = (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ...res, output: out.trim() });
      };
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* gone */
        }
        finish({ code: null, timedOut: true });
      }, this.timeoutMs);
      child.on('error', (err) => finish({ code: null, error: err.message }));
      child.on('close', (code) => finish({ code }));
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(payload));
    });
  }

  /** Returns { blocked: boolean, message }. A hook that cannot run or times out BLOCKS (fail closed). */
  async pre(tool, args) {
    for (const h of this.#matching('PreToolUse', tool)) {
      const r = await this.#exec(h.command, { event: 'PreToolUse', tool, args });
      if (r.code === 0) continue;
      const why = r.timedOut ? 'timed out' : r.error ? `could not run (${r.error})` : `exit code ${r.code}`;
      return { blocked: true, message: `${h.command} -> ${why}${r.output ? `: ${r.output}` : ''}` };
    }
    return { blocked: false };
  }

  /** Returns the combined output of matching PostToolUse hooks ('' if none). */
  async post(tool, args, result) {
    const outputs = [];
    for (const h of this.#matching('PostToolUse', tool)) {
      const r = await this.#exec(h.command, { event: 'PostToolUse', tool, args, ok: !!result?.ok });
      if (r.output) outputs.push(`[${h.command}] ${r.output}`);
    }
    return outputs.join('\n');
  }
}
