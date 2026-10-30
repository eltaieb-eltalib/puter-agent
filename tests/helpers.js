import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '../config/load.js';
import { PathGuard } from '../security/path-guard.js';
import { Permissions } from '../security/permissions.js';
import { createDefaultRegistry } from '../tools/index.js';

/** A throw-away workspace plus a ready-to-use tool context. `approve` answers every prompt. */
export async function makeEnv({ approve = true, outsideWorkspace = 'ask' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'puter-agent-test-'));
  const guard = new PathGuard(dir);
  const prompts = [];
  const permissions = new Permissions({
    approvals: DEFAULTS.approvals,
    outsideWorkspace,
    prompt: async (description) => {
      prompts.push(description);
      return approve;
    },
  });
  const registry = createDefaultRegistry();
  const ctx = { guard, permissions, settings: DEFAULTS, changes: [], signal: undefined };
  return {
    dir,
    guard,
    permissions,
    registry,
    ctx,
    prompts,
    run: (name, args) => registry.execute(name, args, ctx),
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

/** Scripted provider: each chat() call returns the next item (an object, an Error, or a function). */
export class FakeProvider {
  constructor(script) {
    this.script = [...script];
    this.calls = [];
  }

  async chat({ messages }) {
    this.calls.push(messages.map((m) => ({ ...m })));
    const next = this.script.shift();
    if (next === undefined) throw new Error('FakeProvider script exhausted');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(messages) : next;
  }
}

export const textReply = (content) => ({
  content,
  toolCalls: [],
  message: { role: 'assistant', content },
});

/** calls: [{ name, args }] -> a provider reply asking for those tool calls. */
export function toolReply(calls, content = '') {
  const toolCalls = calls.map((c, i) => ({
    id: `call_${calls.length}_${i}_${c.name}`,
    name: c.name,
    arguments: c.args ?? {},
    rawArguments: JSON.stringify(c.args ?? {}),
    parseError: c.parseError,
  }));
  return {
    content,
    toolCalls,
    message: {
      role: 'assistant',
      content,
      tool_calls: toolCalls.map((t) => ({
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: t.rawArguments },
      })),
    },
  };
}
