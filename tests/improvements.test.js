import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { runAgentLoop } from '../core/agent-loop.js';
import { Checkpoint, undoLast } from '../core/checkpoint.js';
import { compactHistory } from '../core/compact.js';
import { buildSystemPrompt } from '../core/context.js';
import { addMemory, forgetMemory, loadMemory } from '../core/memory.js';
import { VerifyTracker, resultHint } from '../core/verify.js';
import { isSensitivePath, redactSecrets } from '../utils/redact.js';
import { FakeProvider, makeEnv, textReply, toolReply } from './helpers.js';

describe('secrets', () => {
  test('redactSecrets masks key formats, KEY=value lines and env values', () => {
    process.env.MY_TEST_API_TOKEN = 'supersecretvalue123';
    const out = redactSecrets('key sk-abcdefghijklmnopqrstuvwxyz123 and OPENAI_API_KEY=abcdef123456 and supersecretvalue123 and Bearer abcdefghijklmnopqrstuvwxyz');
    delete process.env.MY_TEST_API_TOKEN;
    assert.ok(!/sk-abcdef|abcdef123456|supersecretvalue123|Bearer abcdef/.test(out), out);
    assert.match(out, /OPENAI_API_KEY=\*\*\*/);
  });

  test('isSensitivePath: .env and keys yes, .env.example no', () => {
    for (const f of ['.env', 'a/.env.local', 'id_rsa', 'x/server.pem', '.npmrc']) assert.equal(isSensitivePath(f), true, f);
    for (const f of ['.env.example', 'README.md', 'src/env.js']) assert.equal(isSensitivePath(f), false, f);
  });

  test('read_file asks before opening .env (denied -> error) and search_files skips it', async () => {
    const env = await makeEnv({ approve: false });
    try {
      await fs.writeFile(path.join(env.dir, '.env'), 'SECRET_TOKEN=hunter2hunter2\n');
      await fs.writeFile(path.join(env.dir, 'a.txt'), 'hunter2hunter2 here\n');
      const read = await env.run('read_file', { path: '.env' });
      assert.equal(read.ok, false);
      assert.match(read.error, /denied/i);
      const found = await env.run('search_files', { query: 'hunter2' });
      assert.deepEqual(found.result.matches.map((m) => m.file), ['a.txt']);
    } finally {
      await env.cleanup();
    }
  });

  test('tool output sent to the model is masked', async () => {
    const env = await makeEnv();
    try {
      await fs.writeFile(path.join(env.dir, 'notes.txt'), 'token: sk-abcdefghijklmnopqrstuvwxyz123\n');
      const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'read it' }];
      await runAgentLoop({
        provider: new FakeProvider([toolReply([{ name: 'read_file', args: { path: 'notes.txt' } }]), textReply('done')]),
        model: 'f', messages, registry: env.registry, ctx: env.ctx,
      });
      const toolMsg = messages.find((m) => m.role === 'tool').content;
      assert.ok(!toolMsg.includes('sk-abcdef'), toolMsg);
    } finally {
      await env.cleanup();
    }
  });
});

describe('verification loop', () => {
  let env;
  beforeEach(async () => (env = await makeEnv()));
  afterEach(() => env.cleanup());
  const run = (script, extra = {}) => {
    const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'make a script' }];
    const provider = new FakeProvider(script);
    return runAgentLoop({ provider, model: 'f', messages, registry: env.registry, ctx: env.ctx, verify: true, ...extra }).then((r) => ({ r, messages, provider }));
  };

  test('finishing after changing code without running it is refused once, then accepted after a run', async () => {
    const { r, messages } = await run([
      toolReply([{ name: 'create_file', args: { path: 'ok.js', content: 'console.log(1)' } }]),
      textReply('Done, it works!'),
      toolReply([{ name: 'run_command', args: { command: 'node --check ok.js' } }]),
      textReply('Verified.'),
    ]);
    assert.equal(r.content, 'Verified.');
    assert.ok(messages.some((m) => m.role === 'user' && /did not run anything to verify/.test(m.content)));
  });

  test('gives up nagging after the limit (never loops forever)', async () => {
    const { r } = await run([
      toolReply([{ name: 'create_file', args: { path: 'a.js', content: 'x' } }]),
      textReply('one'), textReply('two'), textReply('three'),
    ]);
    assert.equal(r.content, 'three');
  });

  test('docs/text changes need no verification; plan mode neither', async () => {
    const { r } = await run([toolReply([{ name: 'create_file', args: { path: 'notes.md', content: '# hi' } }]), textReply('saved')]);
    assert.equal(r.content, 'saved');
  });

  test('VerifyTracker: a failed run keeps the file dirty', () => {
    const t = new VerifyTracker();
    t.observe('edit_file', { path: 'a.py' }, { ok: true, result: {} });
    t.observe('run_python', {}, { ok: true, result: { exit_code: 1 } });
    assert.match(t.nudge(), /last run failed/);
  });

  test('same failing call twice gets a "change approach" hint before it is stopped', async () => {
    const bad = toolReply([{ name: 'read_file', args: { path: 'missing.txt' } }]);
    const { r, messages } = await run([bad, bad, bad], { verify: false });
    assert.equal(r.stopReason, 'stuck');
    const tools = messages.filter((m) => m.role === 'tool');
    assert.match(tools[1].content, /failed twice/);
  });

  test('weak results get hints', () => {
    assert.match(resultHint('web_search', { ok: true, result: { results: [] } }), /No results/);
    assert.match(resultHint('web_fetch', { ok: true, result: { content: 'x' } }), /almost no text/);
    assert.equal(resultHint('web_search', { ok: true, result: { results: [{}] } }), null);
  });
});

describe('checkpoints (/undo)', () => {
  test('restores edited/deleted files and removes created ones', async () => {
    const env = await makeEnv();
    try {
      await fs.writeFile(path.join(env.dir, 'keep.txt'), 'original');
      await fs.writeFile(path.join(env.dir, 'gone.txt'), 'bye');
      env.ctx.checkpoint = new Checkpoint(env.guard.root);
      assert.ok((await env.run('edit_file', { path: 'keep.txt', old_string: 'original', new_string: 'changed' })).ok);
      assert.ok((await env.run('delete_file', { path: 'gone.txt' })).ok);
      assert.ok((await env.run('create_file', { path: 'new.txt', content: 'n' })).ok);
      const res = await undoLast(env.guard.root);
      assert.deepEqual([res.restored.sort(), res.removed], [['gone.txt', 'keep.txt'], ['new.txt']]);
      assert.equal(await fs.readFile(path.join(env.dir, 'keep.txt'), 'utf8'), 'original');
      assert.equal(await fs.readFile(path.join(env.dir, 'gone.txt'), 'utf8'), 'bye');
      await assert.rejects(fs.stat(path.join(env.dir, 'new.txt')));
      assert.equal(await undoLast(env.guard.root), null);
    } finally {
      await env.cleanup();
    }
  });
});

describe('memory', () => {
  test('tools write/forget notes and the system prompt includes them', async () => {
    const env = await makeEnv();
    try {
      assert.ok((await env.run('memory_write', { note: 'User prefers Arabic answers' })).ok);
      assert.equal((await env.run('memory_write', { note: 'User prefers Arabic answers' })).result.added, false);
      assert.match(loadMemory(env.guard.root), /prefers Arabic/);
      assert.match(buildSystemPrompt({ workspace: env.guard.root }), /Long-term memory[\s\S]*prefers Arabic/);
      assert.equal((await env.run('memory_read', {})).result.summary, '1 note(s)');
      assert.equal(await forgetMemory(env.guard.root, 'arabic'), 1);
      assert.equal(loadMemory(env.guard.root), null);
      await addMemory(env.guard.root, 'x');
    } finally {
      await env.cleanup();
    }
  });
});

describe('context compaction', () => {
  const history = () => {
    const m = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 6; i++) {
      m.push({ role: 'user', content: `request ${i} ${'x'.repeat(500)}` });
      m.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
      m.push({ role: 'tool', tool_call_id: `c${i}`, content: 'y'.repeat(500) });
      m.push({ role: 'assistant', content: `answer ${i}` });
    }
    return m;
  };

  test('summarises old turns, keeps the last ones and a valid history', async () => {
    const messages = history();
    const provider = new FakeProvider([textReply('SUMMARY: user asked things')]);
    assert.equal(await compactHistory({ messages, provider, model: 'f', limit: 1000, keepTurns: 2 }), true);
    assert.equal(messages[0].content, 'sys');
    assert.match(messages[1].content, /SUMMARY: user asked things[\s\S]*request 4/);
    assert.equal(messages.filter((m) => m.role === 'user').length, 2);
    assert.match(messages.at(-1).content, /answer 5/);
    assert.equal(messages[2].role, 'assistant'); // valid: user -> assistant(tool_calls) -> tool ...
  });

  test('does nothing for short histories and survives a failing summariser', async () => {
    assert.equal(await compactHistory({ messages: history(), provider: new FakeProvider([]), model: 'f', limit: 10 ** 9 }), false);
    const messages = history();
    assert.equal(await compactHistory({ messages, provider: new FakeProvider([new Error('down')]), model: 'f', limit: 1000 }), true);
    assert.match(messages[1].content, /automatic summary unavailable/);
  });
});

describe('eval checker', () => {
  test('checkTask validates files, replies and commands', async () => {
    const { checkTask } = await import('../evals/run.js');
    const env = await makeEnv();
    try {
      await fs.writeFile(path.join(env.dir, 'a.txt'), 'hi there');
      const task = { checks: [{ file: 'a.txt', matches: '^hi' }, { reply: '42' }, { replyAbsent: 'SECRET' }, { run: 'node -e "console.log(7)"', stdoutMatches: '^7' }] };
      assert.deepEqual(checkTask(task, { dir: env.dir, reply: 'answer 42' }), []);
      assert.equal(checkTask(task, { dir: env.dir, reply: 'SECRET' }).length, 2);
    } finally {
      await env.cleanup();
    }
  });
});
