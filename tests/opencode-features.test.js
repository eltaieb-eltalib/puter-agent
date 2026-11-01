import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { Agent } from '../core/agent.js';
import { expandCustomCommand, listCustomCommands } from '../core/custom-commands.js';
import { expandMentions } from '../core/mentions.js';
import { globToRegExp } from '../tools/filesystem.js';
import { FakeProvider, makeEnv, textReply, toolReply } from './helpers.js';
import { DEFAULTS } from '../config/load.js';

describe('glob', () => {
  test('pattern conversion', () => {
    assert.ok(globToRegExp('**/*.js').test('a/b/c.js'));
    assert.ok(globToRegExp('**/*.js').test('c.js'));
    assert.ok(!globToRegExp('*.js').test('a/c.js'));
    assert.ok(globToRegExp('src/**/*.{ts,tsx}').test('src/x/y.tsx'));
    assert.ok(!globToRegExp('src/**/*.{ts,tsx}').test('src/x/y.js'));
  });

  test('finds files by name at any depth and skips node_modules', async () => {
    const env = await makeEnv();
    await fs.mkdir(path.join(env.dir, 'a/b'), { recursive: true });
    await fs.mkdir(path.join(env.dir, 'node_modules/x'), { recursive: true });
    await fs.writeFile(path.join(env.dir, 'a/b/one.js'), '1');
    await fs.writeFile(path.join(env.dir, 'top.js'), '1');
    await fs.writeFile(path.join(env.dir, 'node_modules/x/skip.js'), '1');
    const res = await env.run('glob', { pattern: '*.js' });
    assert.ok(res.ok, res.error);
    assert.deepEqual([...res.result.files].sort(), ['a/b/one.js', 'top.js']);
    await env.cleanup();
  });
});

describe('multi_edit', () => {
  test('applies edits in order, atomically', async () => {
    const env = await makeEnv();
    await fs.writeFile(path.join(env.dir, 'f.txt'), 'alpha beta\ngamma');
    const ok = await env.run('multi_edit', { path: 'f.txt', edits: [{ old_string: 'alpha', new_string: 'ALPHA' }, { old_string: 'ALPHA beta', new_string: 'done' }] });
    assert.ok(ok.ok, ok.error);
    assert.equal(await fs.readFile(path.join(env.dir, 'f.txt'), 'utf8'), 'done\ngamma');
    const bad = await env.run('multi_edit', { path: 'f.txt', edits: [{ old_string: 'gamma', new_string: 'G' }, { old_string: 'missing', new_string: 'x' }] });
    assert.equal(bad.ok, false);
    assert.equal(await fs.readFile(path.join(env.dir, 'f.txt'), 'utf8'), 'done\ngamma'); // nothing written
    await env.cleanup();
  });
});

describe('@mentions and custom commands', () => {
  test('@file attaches content; outside and secret files are ignored', async () => {
    const env = await makeEnv();
    await fs.writeFile(path.join(env.dir, 'a.js'), 'const x = 1;');
    await fs.writeFile(path.join(env.dir, '.env'), 'KEY=secret');
    const r = expandMentions('explain @a.js and @.env and @../nope', env.guard);
    assert.deepEqual(r.attached, ['a.js']);
    assert.match(r.text, /const x = 1;/);
    assert.doesNotMatch(r.text, /secret/);
    assert.equal(expandMentions('mail me at a@b.com', env.guard).attached.length, 0);
    await env.cleanup();
  });

  test('custom command templates', async () => {
    const env = await makeEnv();
    const dir = path.join(env.dir, '.puter-agent', 'commands');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'review.md'), '# Review code\nReview: $ARGUMENTS');
    await fs.writeFile(path.join(dir, 'plain.md'), 'Do the thing');
    assert.equal(listCustomCommands(env.dir).length, 2);
    assert.match(expandCustomCommand(env.dir, '/review src/a.js'), /Review: src\/a\.js/);
    assert.equal(expandCustomCommand(env.dir, '/plain extra'), 'Do the thing\n\nextra');
    assert.equal(expandCustomCommand(env.dir, '/unknown'), null);
    await env.cleanup();
  });
});

describe('task sub-agent', () => {
  test('runs a read-only sub-loop and returns its report', async () => {
    const env = await makeEnv();
    await fs.writeFile(path.join(env.dir, 'x.txt'), 'needle');
    const provider = new FakeProvider([
      toolReply([{ name: 'task', args: { description: 'find needle', prompt: 'Where is the needle?' } }]),
      toolReply([{ name: 'read_file', args: { path: 'x.txt' } }]), // sub-agent step 1
      textReply('The needle is in x.txt.'), // sub-agent report
      textReply('Done: needle is in x.txt.'), // main answer
    ]);
    const agent = new Agent({ provider, registry: env.registry, settings: DEFAULTS, guard: env.guard, permissions: env.permissions, model: 'm' });
    const res = await agent.run('find the needle with a sub-agent');
    assert.match(res.content, /needle is in x\.txt/);
    const toolMsg = agent.messages.find((m) => m.role === 'tool' && /sub-agent done/.test(m.content));
    assert.ok(toolMsg, 'task result is in the history');
    assert.ok(provider.calls[1][0].content.includes('You are a sub-agent'));
    await env.cleanup();
  });
});
