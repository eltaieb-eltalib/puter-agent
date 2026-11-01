import path from 'node:path';
import { isInside } from '../security/path-guard.js';
import { ToolError } from '../utils/errors.js';

/** Workspace-relative path with forward slashes, or the absolute path if outside. */
export function display(ctx, abs) {
  if (!isInside(ctx.guard.root, abs)) return abs;
  const rel = path.relative(ctx.guard.root, abs);
  return rel === '' ? '.' : rel.split(path.sep).join('/');
}

/**
 * Resolve a model-supplied path through the PathGuard.
 * Paths outside the workspace are only allowed if the user approves.
 */
export async function resolvePath(ctx, input, verb) {
  const resolved = ctx.guard.resolve(input);
  if (!resolved.inside) {
    const ok = await ctx.permissions.confirmOutside(
      `The agent wants to ${verb} a path OUTSIDE the workspace:\n    ${resolved.abs}`,
    );
    if (!ok) {
      throw new ToolError(
        `Access denied: ${resolved.abs} is outside the workspace (${ctx.guard.root}) and the user did not allow it.`,
      );
    }
  }
  return resolved.abs;
}

export async function requireApproval(ctx, action, description) {
  const ok = await ctx.permissions.confirm(action, description);
  if (!ok) {
    throw new ToolError(
      `The user denied this action (${action}). Do not retry it unchanged: choose another approach or ask the user what they want.`,
    );
  }
}

export function recordChange(ctx, action, abs) {
  ctx.changes?.push({ action, path: display(ctx, abs) });
}

/**
 * Small human-readable diff for approval prompts: trims the common start/end lines and shows what
 * changes ("-" removed, "+" added). Not a full diff algorithm: good enough to review an edit.
 */
export function miniDiff(before, after, { maxLines = 14, maxWidth = 100 } = {}) {
  const a = String(before ?? '').replace(/\r\n/g, '\n').split('\n');
  const b = String(after ?? '').replace(/\r\n/g, '\n').split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const cut = (l) => (l.length > maxWidth ? `${l.slice(0, maxWidth - 1)}…` : l);
  const lines = [
    ...a.slice(start, endA).map((l) => `- ${cut(l)}`),
    ...b.slice(start, endB).map((l) => `+ ${cut(l)}`),
  ];
  if (!lines.length) return '';
  const shown = lines.slice(0, maxLines);
  const more = lines.length - shown.length;
  return `    @@ line ${start + 1}\n${shown.map((l) => `    ${l}`).join('\n')}${more > 0 ? `\n    … ${more} more changed line(s)` : ''}`;
}
