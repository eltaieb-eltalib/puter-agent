// Audit log of executed operations that change something (writes, deletes, moves, commands, MCP).
// One JSON object per line in <workspace>/.puter-agent/audit.log. Secrets are masked and long
// arguments are clipped. Writes are serialised and never block or crash the agent.

import fs from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from '../utils/redact.js';

const MAX_ARG = 300;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // rotate to audit.log.1 above this size

function clipArgs(args = {}) {
  const out = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    out[k] = s && s.length > MAX_ARG ? `${s.slice(0, MAX_ARG)}…(${s.length} chars)` : v;
  }
  return out;
}

export class AuditLog {
  #chain = Promise.resolve();

  constructor(workspace, { enabled = true } = {}) {
    this.enabled = enabled;
    this.setWorkspace(workspace);
  }

  setWorkspace(workspace) {
    this.file = path.join(workspace, '.puter-agent', 'audit.log');
  }

  /** entry: { tool, args, ok, error?, ms, approved? } */
  record(entry) {
    if (!this.enabled) return this.#chain;
    const line = `${redactSecrets(JSON.stringify({ at: new Date().toISOString(), ...entry, args: clipArgs(entry.args) }))}\n`;
    const file = this.file;
    this.#chain = this.#chain
      .then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const size = await fs.stat(file).then((s) => s.size, () => 0);
        if (size > MAX_FILE_BYTES) await fs.rename(file, `${file}.1`).catch(() => {});
        await fs.appendFile(file, line, 'utf8');
      })
      .catch(() => {});
    return this.#chain;
  }

  /** Last `n` entries (newest last). */
  async tail(n = 20) {
    await this.#chain;
    try {
      const text = await fs.readFile(this.file, 'utf8');
      return text
        .trim()
        .split('\n')
        .slice(-n)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}
