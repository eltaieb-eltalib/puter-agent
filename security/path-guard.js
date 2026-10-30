import fs from 'node:fs';
import path from 'node:path';
import { PathError } from '../utils/errors.js';

/** True when `target` is `root` or lives underneath it (works for Windows and POSIX paths). */
export function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Confines file access to a workspace folder.
 *
 * - Resolves relative paths against the workspace root.
 * - Follows symlinks (via realpath of the deepest existing ancestor) so a link
 *   inside the workspace cannot be used to escape it.
 * - Rejects NUL bytes and, on Windows, NTFS alternate data streams ("file.txt:stream").
 *
 * resolve() never throws for "outside" paths: it reports `inside: false` and the
 * caller decides (ask the user / deny).
 */
export class PathGuard {
  constructor(workspace) {
    this.setWorkspace(workspace);
  }

  setWorkspace(workspace) {
    const abs = path.resolve(workspace);
    fs.mkdirSync(abs, { recursive: true });
    this.root = fs.realpathSync(abs);
  }

  resolve(input) {
    if (typeof input !== 'string' || input.trim() === '') {
      throw new PathError('Path must be a non-empty string.');
    }
    if (input.includes('\0')) throw new PathError('Path contains a NUL byte.');
    if (process.platform === 'win32') {
      const withoutDrive = input.replace(/^[a-zA-Z]:/, '');
      if (withoutDrive.includes(':')) {
        throw new PathError('Paths containing ":" (alternate data streams) are not allowed.');
      }
    }
    const abs = path.resolve(this.root, input);
    const real = this.#realish(abs);
    return { abs, real, inside: isInside(this.root, real) };
  }

  isRoot(abs) {
    return path.relative(this.root, abs) === '';
  }

  // realpath of the deepest existing ancestor + the not-yet-existing remainder.
  #realish(abs) {
    let current = abs;
    const rest = [];
    for (;;) {
      try {
        const real = fs.realpathSync(current);
        return rest.length ? path.join(real, ...rest.reverse()) : real;
      } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
        const parent = path.dirname(current);
        if (parent === current) return abs;
        rest.push(path.basename(current));
        current = parent;
      }
    }
  }
}
