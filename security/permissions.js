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
 * "always" is remembered per action (e.g. runCommand, deleteFile, outside), never persisted.
 * With no prompt function installed, everything that needs approval is denied.
 */
export class Permissions {
  constructor({ approvals = {}, outsideWorkspace = 'ask', prompt = null } = {}) {
    this.approvals = approvals;
    this.outsideWorkspace = outsideWorkspace;
    this.prompt = prompt;
    this.granted = new Set();
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

  revokeAll() {
    this.granted.clear();
  }

  async confirm(action, description) {
    if (!this.needsApproval(action) || this.granted.has(action)) return true;
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
    const run = this.#chain.then(async () => {
      if (this.granted.has(action)) return true;
      if (!this.prompt) return false;
      const answer = await this.prompt(description, action);
      if (answer === 'always') {
        this.granted.add(action);
        return true;
      }
      return answer === true || answer === 'once';
    });
    this.#chain = run.catch(() => {});
    return run;
  }
}
