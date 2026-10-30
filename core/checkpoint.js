import fs from 'node:fs/promises';
import path from 'node:path';

const DIR = '.puter-agent/checkpoints';
const KEEP = 10;

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/**
 * Before the agent changes a file, keep the original. `/undo` puts everything back
 * (restores overwritten/edited/deleted/moved files and removes files the task created).
 */
export class Checkpoint {
  constructor(root) {
    this.root = root;
    this.id = stamp();
    this.dir = path.join(root, DIR, this.id);
    this.entries = []; // { rel, existed, backup? }
    this.seen = new Set();
  }

  get size() {
    return this.entries.length;
  }

  /** Call BEFORE writing/deleting `abs`. Records the original state once per file. */
  async protect(abs) {
    if (this.seen.has(abs)) return;
    this.seen.add(abs);
    const rel = path.relative(this.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return; // outside the workspace: not tracked
    let stat = null;
    try {
      stat = await fs.lstat(abs);
    } catch {
      /* does not exist yet */
    }
    if (!stat) {
      this.entries.push({ rel, existed: false });
    } else if (stat.isFile()) {
      const backup = path.join(this.dir, 'files', rel);
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.copyFile(abs, backup);
      this.entries.push({ rel, existed: true });
    }
    await this.#writeManifest();
  }

  async #writeManifest() {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, 'manifest.json'), JSON.stringify({ id: this.id, entries: this.entries }), 'utf8');
  }
}

async function listIds(root) {
  try {
    return (await fs.readdir(path.join(root, DIR))).sort();
  } catch {
    return [];
  }
}

/** Remove old checkpoints (keep the newest few). */
export async function pruneCheckpoints(root) {
  const ids = await listIds(root);
  for (const id of ids.slice(0, -KEEP)) await fs.rm(path.join(root, DIR, id), { recursive: true, force: true });
}

/** Undo the most recent checkpoint. Returns { id, restored, removed } or null when there is none. */
export async function undoLast(root) {
  const ids = await listIds(root);
  for (const id of ids.reverse()) {
    const dir = path.join(root, DIR, id);
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    } catch {
      await fs.rm(dir, { recursive: true, force: true });
      continue;
    }
    const restored = [];
    const removed = [];
    for (const e of [...manifest.entries].reverse()) {
      const target = path.join(root, e.rel);
      if (e.existed) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(path.join(dir, 'files', e.rel), target);
        restored.push(e.rel);
      } else {
        await fs.rm(target, { force: true });
        removed.push(e.rel);
      }
    }
    await fs.rm(dir, { recursive: true, force: true });
    return { id, restored, removed };
  }
  return null;
}
