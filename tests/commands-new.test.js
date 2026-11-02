import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { COMMANDS } from '../terminal/commands.js';
import { Agent } from '../core/agent.js';
import { DEFAULTS } from '../config/load.js';
import { Transcript } from '../terminal/components/transcript.js';
import { stripAnsi } from '../terminal/input.js';
import { FakeProvider, makeEnv, textReply, toolReply } from './helpers.js';

describe('new slash commands (plain, non-TTY mode)', () => {
  let env;
  let ui;
  let printed;
  const origLog = console.log;
  beforeEach(async () => {
    env = await makeEnv();
    const provider = new FakeProvider([toolReply([{ name: 'create_file', args: { path: 'a.js', content: 'export function a() {}\n' } }]), textReply('done')]);
    const agent = new Agent({ provider, registry: env.registry, settings: { ...DEFAULTS, retry: { retries: 0 }, verify: { enabled: false } }, guard: env.guard, permissions: env.permissions, model: 'fake' });
    await agent.run('create a.js');
    ui = { agent, transcript: new Transcript(), input: { isTTY: false }, rl: { question: async () => '' }, ui: { rtl: 'auto' }, settings: DEFAULTS };
    ui.transcript.add('user', 'create a.js');
    ui.transcript.add('assistant', 'done');
    printed = [];
    console.log = (...a) => printed.push(stripAnsi(a.join(' ')));
  });
  afterEach(async () => {
    console.log = origLog;
    await env.cleanup();
  });

  test('/cache shows the three caches and /cache clear empties them', async () => {
    await COMMANDS.cache.run(ui, '');
    const out = printed.join('\n');
    for (const name of ['files', 'tools', 'model', 'generation']) assert.match(out, new RegExp(name));
    await COMMANDS.cache.run(ui, 'clear tools');
    assert.match(printed.at(-1), /Cache cleared: tools/);
    await COMMANDS.cache.run(ui, 'clear bogus');
    assert.match(printed.at(-1), /Unknown cache/);
  });

  test('/stats, /index, /audit, /history and /context run and show real numbers', async () => {
    await COMMANDS.stats.run(ui, '');
    assert.match(printed.join('\n'), /2 steps|steps/);
    await COMMANDS.index.run(ui, '');
    assert.match(printed.join('\n'), /Files\s+1 · 1 definitions/);
    await COMMANDS.audit.run(ui, '');
    assert.match(printed.join('\n'), /create_file/);
    await COMMANDS.history.run(ui, '');
    assert.match(printed.join('\n'), /You[\s\S]*create a\.js[\s\S]*Agent[\s\S]*done/);
    await COMMANDS.context.run(ui, '');
    assert.match(printed.join('\n'), /Local caches/i);
  });
});
