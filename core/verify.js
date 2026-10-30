// "Do not claim success without proof": tracks whether code was changed and then actually run,
// and adds short hints to weak tool results so the model reports them instead of guessing.

const CODE_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|py|html|css|json|sh|bat|ps1|java|c|cpp|cs|go|rs|rb|php|sql)$/i;
const WRITERS = new Set(['create_file', 'edit_file']);
const RUNNERS = new Set(['run_command', 'run_node', 'run_python']);

export class VerifyTracker {
  constructor({ maxNudges = 2 } = {}) {
    this.maxNudges = maxNudges;
    this.nudges = 0;
    this.changed = new Set(); // code files changed since the last successful run
    this.lastRunFailed = false;
  }

  observe(name, args, result) {
    if (!result?.ok) return;
    if (WRITERS.has(name) && CODE_EXT.test(String(args?.path ?? ''))) this.changed.add(args.path);
    if (name === 'move_file' && CODE_EXT.test(String(args?.to ?? ''))) this.changed.add(args.to);
    if (RUNNERS.has(name)) {
      const body = result.result ?? {};
      if (body.exit_code === 0 && !body.timed_out) {
        this.changed.clear();
        this.lastRunFailed = false;
      } else this.lastRunFailed = true;
    }
  }

  /** A reminder to send instead of accepting a final answer, or null. */
  nudge() {
    if (!this.changed.size || this.nudges >= this.maxNudges) return null;
    this.nudges++;
    const files = [...this.changed].slice(0, 6).join(', ');
    return this.lastRunFailed
      ? `Your last run failed and you changed code afterwards (${files}). Do not finish yet: run it again (tests, "node --check", or the script itself), read the output and fix any error. If you truly cannot verify, say so explicitly in your final answer.`
      : `You changed code (${files}) but did not run anything to verify it. Before finishing: run the project's tests, a syntax check (for example "node --check file.js" or "python -m py_compile file.py") or the program itself, and read the output. If you cannot verify it, say so explicitly in your final answer instead of claiming it works.`;
  }
}

/** Extra guidance attached to results that are technically "ok" but weak. */
export function resultHint(name, result) {
  if (!result?.ok) return null;
  const body = result.result ?? {};
  if (name === 'web_search' && Array.isArray(body.results) && body.results.length === 0) {
    return 'No results. Try different wording (another language, fewer words). If still nothing, tell the user you could not find or verify it - do not answer from memory as if verified.';
  }
  if (name === 'web_fetch' && typeof body.content === 'string' && body.content.trim().length < 200) {
    return 'The page returned almost no text (blocked, empty or script-rendered). Try another source before relying on it, and say so if you cannot verify.';
  }
  if (name === 'read_file' && body.truncated) {
    return 'The file was truncated: read the rest with start_line/end_line before drawing conclusions about the whole file.';
  }
  return null;
}
