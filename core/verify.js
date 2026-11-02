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

/**
 * Diagnose a FAILED tool call so the model fixes the cause instead of retrying blindly.
 * Returns a short hint or null. Pure string inspection, no model call.
 */
export function failureHint(name, args = {}, result = {}) {
  const body = result?.result ?? {};
  const failedRun = result?.ok && ['run_command', 'run_node', 'run_python'].includes(name) && body.exit_code !== 0 && body.exit_code !== undefined;
  if (result?.ok && !failedRun) return null;
  const text = `${result?.error ?? ''}\n${body.stderr ?? ''}\n${body.stdout ?? ''}`.slice(-4000);
  if (body.timed_out) return 'Diagnosis: killed by the time limit. Use a bounded/faster variant (e.g. a single test file, --run, no watch mode) rather than the same command.';
  if (/old_string.*not found|was not found in|no match/i.test(text)) return 'Diagnosis: the text to replace is not in the file (it changed or differs in whitespace). Re-read the exact lines with read_file (start_line/end_line) and copy them exactly.';
  if (/found \d+ times|matches \d+ places|is not unique|multiple (?:matches|occurrences)/i.test(text)) return 'Diagnosis: old_string matches several places. Include more surrounding lines so it is unique, or set replace_all if every occurrence should change.';
  if (/ENOENT|no such file|cannot find (?:the )?(?:path|file)|not found:? .*\.\w+/i.test(text) && !/command not found|is not recognized/i.test(text))
    return 'Diagnosis: a path does not exist. Locate it first with glob or list_files (check spelling, folder and extension) before retrying.';
  if (/EACCES|EPERM|permission denied|access is denied/i.test(text)) return 'Diagnosis: permission problem. Do not retry the same call; use a path inside the workspace or explain to the user what access is needed.';
  if (/command not found|is not recognized as an internal or external command|not recognized as the name/i.test(text))
    return 'Diagnosis: the program is not installed or not on PATH. Check with a version command or use an available alternative (node/python script).';
  if (/SyntaxError|Unexpected token|IndentationError|ParseError/i.test(text)) return 'Diagnosis: syntax error. Read the reported file:line, fix that exact spot, then run the same check again.';
  if (/Cannot find module|ModuleNotFoundError|ERR_MODULE_NOT_FOUND|No module named/i.test(text)) return 'Diagnosis: a module/import is missing. Check the import path and package.json/requirements before installing anything.';
  if (/AssertionError|expected .* (?:to|but)|\bFAIL(?:ED)?\b|failing/i.test(text)) return 'Diagnosis: a test assertion failed. Compare expected vs actual in the output and fix the code (not the test) unless the test is wrong.';
  if (/denied this action|did not allow it/i.test(text)) return 'The user refused this. Respect it: do not retry the same action; choose another approach or ask what they prefer.';
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(text)) return 'Diagnosis: network problem. Retry at most once, or use another source.';
  return null;
}
