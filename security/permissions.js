/**
 * Approval policy.
 *
 * settings.approvals maps an action name to true (ask the user first) or false (allow
 * automatically). Unknown actions always ask. Access outside the workspace is controlled
 * separately: "ask" prompts, "deny" refuses outright.
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

  async confirmOutside(description) {
    if (this.outsideWorkspace === 'deny') return false;
    if (this.granted.has('outside')) return true;
    return this.#ask(description, 'outside');
  }

  async #ask(description, action) {
    if (!this.prompt) return false;
    const answer = await this.prompt(description, action);
    if (answer === 'always') {
      this.granted.add(action);
      return true;
    }
    return answer === true || answer === 'once';
  }
}
