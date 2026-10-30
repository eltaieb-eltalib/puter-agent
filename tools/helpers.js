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
