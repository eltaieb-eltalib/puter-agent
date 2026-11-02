/**
 * Approval policy.
 *
 * settings.approvals maps an action name to true (ask the user first) or false (allow
 * automatically). Unknown actions always ask. Access outside the workspace is controlled
 * separately: "ask" prompts, "deny" refuses outright, "allow" lets the agent reach any folder
 * without asking (full access; use with care).
 *
 * The prompt function (injected by the terminal UI) is called as prompt(description, action)
 * and may answer:  true | 'once'  -> allow this time
 *                  'always'       -> allow this action for the rest of the session
 *                  false | 'no'   -> deny
 *                  'never'        -> deny this action for the rest of the session (no more prompts)
 *                  'cancel'       -> deny and cancel the whole running task (onCancel is called)
 * "always"/"never" are remembered per action (e.g. runCommand, deleteFile, outside), never persisted.
 * A rejected request is also remembered exactly (same action + same description): if the agent asks
 * for the very same thing again in this session it is refused without asking, so a user's "no" is
 * never worn down by repetition. Performance features (caching etc.) never bypass these checks.
 * With no prompt function installed, everything that needs approval is denied.
 */
export class Permissions {
  constructor({ approvals = {}, outsideWorkspace = 'ask', prompt = null } = {}) {
    this.approvals = approvals;
    this.outsideWorkspace = outsideWorkspace;
    this.prompt = prompt;
    this.granted = new Set();
    this.denied = new Set(); // actions denied for the session ('never')
    this.rejected = new Set(); // exact action+description pairs the user rejected
    this.onCancel = null; // set by the UI: aborts the running task
    this.onDecision = null; // ({ action, description, answer, auto }) => void, for the audit log
  }

  #decide(action, description, answer, auto = false) {
    try {
      this.onDecision?.({ action, description: String(description ?? '').split('\n').slice(0, 2).join(' ').slice(0, 300), answer, auto });
    } catch {
      /* logging never blocks a decision */
    }
  }

  setPrompt(fn) {
    this.prompt = fn;
  }

  needsApproval(action) {
    return this.approvals[action] ?? true;
  }

  isGranted(action) {
    return this.granted.has(action);
  }

  /** New user request: exact rejections from the previous task no longer apply ('never' still does). */
  beginTask() {
    this.rejected.clear();
  }

  isDenied(action) {
    return this.denied.has(action);
  }

  revokeAll() {
    this.granted.clear();
    this.denied.clear();
    this.rejected.clear();
  }

  async confirm(action, description) {
    if (!this.needsApproval(action)) return true;
    if (this.granted.has(action)) {
      this.#decide(action, description, 'always', true);
      return true;
    }
    return this.#ask(description, action);
  }

  /** Profiles used by /access. 'full' = outside access + commands/scripts/open without asking. */
  static PROFILES = {
    workspace: { outsideWorkspace: 'deny', approvals: { runCommand: true, openPath: true } },
    ask: { outsideWorkspace: 'ask', approvals: { runCommand: true, openPath: true } },
    full: { outsideWorkspace: 'allow', approvals: { runCommand: false, openPath: false } },
  };

  /** Current access level name, or 'custom' when settings do not match a profile. */
  get accessLevel() {
    for (const [name, p] of Object.entries(Permissions.PROFILES)) {
      if (this.outsideWorkspace !== p.outsideWorkspace) continue;
      if (Object.entries(p.approvals).every(([k, v]) => this.needsApproval(k) === v)) return name;
    }
    return 'custom';
  }

  /** Apply a profile at runtime. Deletes/overwrites/moves and secret-file reads keep asking. */
  setAccess(level) {
    const profile = Permissions.PROFILES[level];
    if (!profile) throw new Error(`Unknown access level "${level}". Use: workspace | ask | full.`);
    this.outsideWorkspace = profile.outsideWorkspace;
    this.approvals = { ...this.approvals, ...profile.approvals };
    this.granted.clear();
    this.denied.clear();
    return level;
  }

  async confirmOutside(description) {
    if (this.outsideWorkspace === 'deny') return false;
    if (this.outsideWorkspace === 'allow') return true;
    if (this.granted.has('outside')) return true;
    return this.#ask(description, 'outside');
  }

  // Questions are asked ONE AT A TIME (parallel sub-agents may need several approvals at once), and a
  // question already answered "always" while it waited in the queue is not asked again.
  #chain = Promise.resolve();

  #ask(description, action) {
    const exact = `${action}\u0000${description}`;
    const run = this.#chain.then(async () => {
      if (this.denied.has(action) || this.rejected.has(exact)) {
        this.#decide(action, description, 'denied-before', true);
        return false;
      }
      if (this.granted.has(action)) return true;
      if (!this.prompt) {
        this.#decide(action, description, 'no-prompt', true);
        return false;
      }
      const answer = await this.prompt(description, action);
      this.#decide(action, description, answer === true ? 'once' : answer || 'no');
      if (answer === 'always') {
        this.granted.add(action);
        return true;
      }
      if (answer === true || answer === 'once') return true;
      if (answer === 'never') this.denied.add(action);
      else this.rejected.add(exact);
      if (answer === 'cancel') this.onCancel?.();
      return false;
    });
    this.#chain = run.catch(() => {});
    return run;
  }
}
