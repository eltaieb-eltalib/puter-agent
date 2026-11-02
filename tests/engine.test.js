import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LRUCache, CacheManager, stableStringify } from '../core/cache.js';
import { compressToolResults, estimateTokens, summarizeToolOutput, SHORTENED_MARK } from '../core/context-manager.js';
import { analyzeRequest, taskFrame } from '../core/planner.js';
import { Ledger } from '../core/ledger.js';
import { createProtocol, isToolsUnsupported, toolCatalog } from '../core/tool-protocol.js';
import { failureHint } from '../core/verify.js';
import { runAgentLoop } from '../core/agent-loop.js';
import { compactHistory } from '../core/compact.js';
import { AuditLog } from '../core/audit.js';
import { Agent } from '../core/agent.js';
import { DEFAULTS } from '../config/load.js';
import { Permissions } from '../security/permissions.js';
import { FakeProvider, makeEnv, textReply, toolReply } from './helpers.js';

describe('LRU cache', () => {
  test('evicts least recently used entries and counts hits/misses', () => {
    const c = new LRUCache({ maxEntries: 2 });
    c.set('a', 1);
    c.set('b', 2);
    assert.equal(c.get('a'), 1); // a is now most recent
    c.set('c', 3); // evicts b
    assert.equal(c.get('b'), undefined);
    assert.equal(c.get('c'), 3);
    const s = c.stats();
    assert.equal(s.hits, 2);
    assert.equal(s.misses, 1);
    assert.equal(s.evictions, 1);
  });

  test('respects the byte budget and TTL', async () => {
    const c = new LRUCache({ maxEntries: 100, maxBytes: 100 });
    c.set('x', 'a'.repeat(30)); // 60 bytes
    c.set('y', 'b'.repeat(30)); // 60 bytes -> x evicted
    assert.equal(c.peek('x'), undefined);
    assert.equal(c.set('huge', 'z'.repeat(1000)), false, 'an item bigger than the cache is refused');
    const t = new LRUCache({ ttlMs: 5 });
    t.set('k', 1);
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(t.get('k'), undefined);
  });

  test('stableStringify ignores key order', () => {
    assert.equal(stableStringify({ b: 1, a: [1, { d: 2, c: 3 }] }), stableStringify({ a: [1, { c: 3, d: 2 }], b: 1 }));
  });
});

describe('file cache + tool cache (through the registry)', () => {
  let env;
  beforeEach(async () => {
    env = await makeEnv();
    env.ctx.cache = new CacheManager();
  });
  afterEach(() => env.cleanup());

  test('read_file is served from cache until the file changes (mtime/size + hash)', async () => {
    await fs.writeFile(path.join(env.dir, 'a.txt'), 'one\ntwo');
    const first = await env.run('read_file', { path: 'a.txt' });
    const second = await env.run('read_file', { path: 'a.txt' });
    assert.equal(first.result.content, 'one\ntwo');
    assert.equal(second.result.hash, first.result.hash);
    assert.equal(env.ctx.cache.files.stats().hits, 1);
    // edited by the agent -> invalidated immediately
    await env.run('edit_file', { path: 'a.txt', old_string: 'two', new_string: 'three' });
    const third = await env.run('read_file', { path: 'a.txt' });
    assert.equal(third.result.content, 'one\nthree');
    assert.notEqual(third.result.hash, first.result.hash);
    // edited outside the agent (different size) -> stat check catches it
    await fs.writeFile(path.join(env.dir, 'a.txt'), 'changed outside, longer');
    assert.equal((await env.run('read_file', { path: 'a.txt' })).result.content, 'changed outside, longer');
  });

  test('workspace tool results are cached and invalidated by any write', async () => {
    await fs.writeFile(path.join(env.dir, 'a.txt'), 'x');
    const a = await env.run('list_files', { path: '.' });
    const b = await env.run('list_files', { path: '.' });
    assert.ok(!a.cached && b.cached);
    await env.run('create_file', { path: 'b.txt', content: 'y' });
    const c = await env.run('list_files', { path: '.' });
    assert.ok(!c.cached, 'a write bumps the generation');
    assert.equal(c.result.entries.length, 2);
  });

  test('calls outside the workspace or on secret files are never cached (prompts always run)', async () => {
    const other = await fs.mkdtemp(path.join(path.dirname(env.dir), 'outside-'));
    try {
      await fs.writeFile(path.join(other, 'o.txt'), 'o');
      await env.run('list_files', { path: other });
      await env.run('list_files', { path: other });
      assert.equal(env.prompts.length, 2, 'asked both times');
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  test('large files are read in chunks with an outline', async () => {
    const body = Array.from({ length: 900 }, (_, i) => (i % 100 === 0 ? `function f${i}() {` : `  line ${i}`)).join('\n');
    await fs.writeFile(path.join(env.dir, 'big.js'), body);
    const r = await env.run('read_file', { path: 'big.js' });
    assert.equal(r.result.chunked, true);
    assert.equal(r.result.content.split('\n').length, 250);
    assert.ok(r.result.outline.some((l) => l.startsWith('501: function f500')));
    const slice = await env.run('read_file', { path: 'big.js', start_line: 500, end_line: 502 });
    assert.equal(slice.result.content.split('\n').length, 3);
  });
});

describe('context manager', () => {
  test('compression is batched: nothing changes until the budget is exceeded', () => {
    const tool = (i, n) => ({ role: 'tool', tool_call_id: `c${i}`, content: JSON.stringify({ ok: true, result: { summary: `r${i}`, data: 'x'.repeat(n) } }) });
    const messages = [tool(0, 1000), tool(1, 1000), tool(2, 100), tool(3, 100)];
    assert.equal(compressToolResults(messages, { keep: 2, maxChars: 300, triggerChars: 5000 }), 0, 'below budget: prefix untouched');
    assert.equal(compressToolResults(messages, { keep: 2, maxChars: 300, triggerChars: 1500 }), 2);
    assert.ok(messages[0].content.startsWith(SHORTENED_MARK));
    assert.match(messages[0].content, /r0/);
    assert.equal(compressToolResults(messages, { keep: 2, maxChars: 300, triggerChars: 0 }), 0, 'already compressed notes are not rewritten again');
  });

  test('tool-aware notes keep the facts (exit codes, paths, errors)', () => {
    const run = summarizeToolOutput('run_command', { command: 'npm test' }, JSON.stringify({ ok: true, result: { exit_code: 1, stdout: 'a\nb', stderr: 'boom\nFAIL x' } }));
    assert.match(run, /exit 1/);
    assert.match(run, /FAIL x/);
    const read = summarizeToolOutput('read_file', { path: 'a.js' }, JSON.stringify({ ok: true, result: { path: 'a.js', content: 'x'.repeat(3000), total_lines: 80, hash: 'abcdef123456' } }));
    assert.match(read, /a\.js/);
    assert.match(read, /80 lines/);
    assert.ok(read.length <= 500);
  });

  test('token estimate accounts for non-Latin scripts', () => {
    assert.equal(estimateTokens('abcd'.repeat(10)), 10);
    assert.ok(estimateTokens('مرحبا بك'.repeat(10)) > estimateTokens('abcdefgh'.repeat(10)));
  });
});

describe('planner (local, no model call)', () => {
  test('simple requests stay simple; multi-step requests are complex', () => {
    const simple = analyzeRequest('fix the typo in README.md');
    assert.equal(simple.kind, 'change');
    assert.equal(simple.complexity, 'simple');
    assert.match(taskFrame(simple), /no plan/);
    const complex = analyzeRequest('Refactor the whole project:\n- split agent.js\n- add tests\n- update README.md\n- then run the full test suite and fix failures');
    assert.equal(complex.complexity, 'complex');
    assert.ok(complex.needsPlan);
    assert.match(taskFrame(complex), /todo_write/);
    assert.equal(taskFrame(analyzeRequest('hello there')), '');
  });

  test('Arabic requests are understood', () => {
    const a = analyzeRequest('أصلح الخطأ في الملف app.js ثم شغل الاختبارات');
    assert.equal(a.kind, 'change');
    assert.notEqual(a.complexity, 'simple');
  });
});

describe('ledger', () => {
  test('records evidence from tool results and summarises it locally', () => {
    const l = new Ledger();
    l.addGoal('build a calculator');
    l.observe('read_file', { path: 'a.js' }, { ok: true, result: { path: 'a.js', hash: 'h1', total_lines: 3 } });
    l.observe('edit_file', { path: 'a.js' }, { ok: true, result: {} });
    l.observe('run_command', { command: 'node --check a.js' }, { ok: true, result: { exit_code: 0 } });
    l.observe('web_fetch', { url: 'https://x.org' }, { ok: false, error: 'ENOTFOUND' });
    const s = l.summary();
    assert.match(s, /build a calculator/);
    assert.match(s, /a\.js \(edit_file\)/);
    assert.doesNotMatch(s, /Files read: a\.js/, 'an edit makes the earlier read stale');
    assert.match(s, /node --check a\.js -> exit 0/);
    assert.match(s, /ENOTFOUND/);
    const copy = Ledger.fromJSON(JSON.parse(JSON.stringify(l.toJSON())));
    assert.equal(copy.summary(), s);
  });
});

describe('tool protocol layer', () => {
  const registry = { has: (n) => n === 'read_file' };
  const defs = [{ type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer' } }, required: ['path'] } } }];

  test('native: tools passed through; prompt: catalog in the system prompt', () => {
    const msgs = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }];
    const native = createProtocol('native').request(msgs, defs);
    assert.equal(native.tools.length, 1);
    const prompt = createProtocol('prompt').request(msgs, defs);
    assert.equal(prompt.tools.length, 0);
    assert.match(prompt.messages[0].content, /read_file\(path:string, start_line\?:integer\)/);
    assert.equal(msgs[0].content, 'SYS', 'the stored history is not modified');
    assert.equal(createProtocol('json').request(msgs, defs).responseFormat, 'json');
    assert.match(toolCatalog(defs), /Read a file/);
  });

  test('json mode parses tool calls, tool_calls arrays and final answers', () => {
    const p = createProtocol('json');
    const one = p.parse({ content: '{"tool":"read_file","args":{"path":"a"}}', toolCalls: [] }, registry);
    assert.equal(one.toolCalls[0].name, 'read_file');
    const many = p.parse({ content: '{"tool_calls":[{"tool":"read_file","args":{"path":"a"}},{"tool":"read_file","args":{"path":"b"}}]}', toolCalls: [] }, registry);
    assert.deepEqual(many.toolCalls.map((c) => c.arguments.path), ['a', 'b']);
    const fin = p.parse({ content: '{"final":"all done"}', toolCalls: [] }, registry);
    assert.equal(fin.content, 'all done');
    assert.equal(fin.toolCalls.length, 0);
    assert.deepEqual(p.resultMessage({ id: 'x', name: 'read_file' }, '{}').role, 'user');
  });

  test('recognises "tools not supported" errors', () => {
    assert.ok(isToolsUnsupported(new Error('This model does not support tools')));
    assert.ok(isToolsUnsupported(new Error('400 tool use is not supported for this model'.replace('tool use is not', 'tools are not'))));
    assert.ok(!isToolsUnsupported(new Error('rate limited')));
  });
});

describe('failure diagnosis', () => {
  test('gives a targeted hint for common failures', () => {
    assert.match(failureHint('read_file', {}, { ok: false, error: 'ENOENT: no such file or directory' }), /glob or list_files/);
    assert.match(failureHint('edit_file', {}, { ok: false, error: 'old_string was not found in a.js' }), /Re-read/);
    assert.match(failureHint('run_command', {}, { ok: true, result: { exit_code: 1, stderr: 'SyntaxError: Unexpected token' } }), /syntax/i);
    assert.match(failureHint('run_command', {}, { ok: true, result: { exit_code: 127, stderr: 'sh: foo: command not found' } }), /not installed/);
    assert.equal(failureHint('run_command', {}, { ok: true, result: { exit_code: 0 } }), null);
  });
});

describe('agent loop economy', () => {
  let env;
  beforeEach(async () => {
    env = await makeEnv();
    env.ctx.cache = new CacheManager();
  });
  afterEach(() => env.cleanup());

  const loop = (provider, extra = {}) =>
    runAgentLoop({ provider, model: 'fake', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'go' }], registry: env.registry, ctx: env.ctx, retry: { retries: 0 }, ...extra });

  test('an identical call with an identical result is answered with a short "unchanged" note', async () => {
    await fs.writeFile(path.join(env.dir, 'a.txt'), 'hello '.repeat(200));
    const provider = new FakeProvider([
      toolReply([{ name: 'read_file', args: { path: 'a.txt' } }]),
      toolReply([{ name: 'read_file', args: { path: 'a.txt' } }]),
      textReply('done'),
    ]);
    const res = await loop(provider);
    assert.equal(res.usage.dedupedResults, 1);
    const tools = provider.calls[2].filter((m) => m.role === 'tool');
    assert.ok(tools[0].content.length > 1000);
    assert.match(tools[1].content, /unchanged/);
    assert.ok(tools[1].content.length < 300);
  });

  test('read-only calls of one turn run in parallel and results keep their order', async () => {
    let active = 0;
    let peak = 0;
    const registry = env.registry;
    const slow = (name) => ({
      name,
      readOnly: true,
      description: name,
      execute: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 30));
        active--;
        return { summary: name };
      },
    });
    registry.register(slow('slow_a'));
    registry.register(slow('slow_b'));
    registry.register(slow('slow_c'));
    const provider = new FakeProvider([toolReply([{ name: 'slow_a' }, { name: 'slow_b' }, { name: 'slow_c' }]), textReply('ok')]);
    const events = [];
    await loop(provider, { emit: (e) => events.push(e) });
    assert.equal(peak, 3);
    const results = provider.calls[1].filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content).result.summary);
    assert.deepEqual(results, ['slow_a', 'slow_b', 'slow_c']);
    assert.ok(events.some((e) => e.type === 'parallel' && e.count === 3));
  });

  test('a failed call carries a local diagnosis', async () => {
    const provider = new FakeProvider([toolReply([{ name: 'read_file', args: { path: 'missing.txt' } }]), textReply('ok')]);
    await loop(provider);
    const tool = provider.calls[1].find((m) => m.role === 'tool');
    assert.match(tool.content, /Diagnosis: a path does not exist/);
  });

  test('soft budget sends exactly one checkpoint note', async () => {
    const replies = [];
    for (let i = 0; i < 4; i++) replies.push(toolReply([{ name: 'list_files', args: { path: '.', max_entries: 10 + i } }]));
    replies.push(textReply('ok'));
    const provider = new FakeProvider(replies);
    const events = [];
    await loop(provider, { analysis: { softBudget: 2, complexity: 'simple', goal: 'x' }, emit: (e) => events.push(e.type) });
    assert.equal(events.filter((t) => t === 'checkpoint').length, 1);
    const notes = provider.calls.at(-1).filter((m) => m.role === 'tool' && /Checkpoint:/.test(m.content));
    assert.equal(notes.length, 1);
  });

  test('auto protocol falls back to prompt-mode tools when the model rejects native tools', async () => {
    let n = 0;
    const provider = {
      calls: [],
      async chat({ messages, tools }) {
        this.calls.push({ messages, tools });
        n++;
        if (n === 1) throw Object.assign(new Error('this model does not support tools'), { status: 400 });
        if (n === 2) return { content: '{"tool":"list_files","args":{"path":"."}}', toolCalls: [], message: { role: 'assistant', content: '' } };
        return { content: 'finished', toolCalls: [], message: { role: 'assistant', content: 'finished' } };
      },
    };
    const events = [];
    const res = await loop(provider, { protocol: 'auto', emit: (e) => events.push(e.type) });
    assert.equal(res.content, 'finished');
    assert.ok(events.includes('protocol'));
    assert.equal(provider.calls[1].tools.length, 0);
    assert.match(provider.calls[1].messages[0].content, /Tool protocol/);
    const last = provider.calls[2].messages;
    assert.ok(last.some((m) => m.role === 'user' && m.content.startsWith('[tool_result list_files')));
    assert.ok(!last.some((m) => m.role === 'tool'), 'no tool-role messages in prompt mode');
  });
});

describe('local compaction (zero model calls)', () => {
  test('summarises old turns from the ledger without calling the provider', async () => {
    const provider = new FakeProvider([]);
    const messages = [{ role: 'system', content: 's' }];
    for (let i = 0; i < 4; i++) messages.push({ role: 'user', content: `request ${i} ${'x'.repeat(200)}` }, { role: 'assistant', content: `answer ${i}` });
    const done = await compactHistory({ messages, provider, model: 'm', limit: 100, keepTurns: 1, summarizer: 'local', localSummary: 'Files changed: a.js (edit_file)' });
    assert.ok(done);
    assert.equal(provider.calls.length, 0);
    assert.match(messages[1].content, /Files changed: a\.js/);
    assert.match(messages[1].content, /request 0/);
  });

  test('model summaries are cached by request hash', async () => {
    const cache = new LRUCache();
    const make = () => {
      const m = [{ role: 'system', content: 's' }];
      for (let i = 0; i < 3; i++) m.push({ role: 'user', content: `u${i}` }, { role: 'assistant', content: `a${i}` });
      return m;
    };
    const provider = new FakeProvider([textReply('SUMMARY')]);
    await compactHistory({ messages: make(), provider, model: 'm', limit: 0, keepTurns: 1, cache });
    await compactHistory({ messages: make(), provider, model: 'm', limit: 0, keepTurns: 1, cache });
    assert.equal(provider.calls.length, 1, 'second identical compaction came from the model cache');
  });
});

describe('audit log', () => {
  test('mutating tools are recorded with masked secrets', async () => {
    const env = await makeEnv();
    try {
      env.ctx.audit = new AuditLog(env.dir);
      await env.run('create_file', { path: 'k.txt', content: 'token sk-abcdefghijklmnopqrstuvwxyz123456' });
      await env.run('list_files', { path: '.' }); // read-only: not recorded
      const entries = await env.ctx.audit.tail();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].tool, 'create_file');
      assert.equal(entries[0].ok, true);
      assert.doesNotMatch(JSON.stringify(entries[0]), /sk-abcdefghijklmnop/);
    } finally {
      await env.cleanup();
    }
  });
});

describe('Agent integration', () => {
  test('tool set is sticky across requests (stable prompt prefix) and busy guard prevents overlap', async () => {
    const env = await makeEnv();
    try {
      const sentTools = [];
      const provider = {
        async chat({ tools }) {
          sentTools.push(tools.map((t) => t.function.name));
          return textReply('ok');
        },
      };
      const agent = new Agent({ provider, registry: env.registry, settings: { ...DEFAULTS, retry: { retries: 0 } }, guard: env.guard, permissions: env.permissions, model: 'fake' });
      await agent.run('please run npm test');
      await agent.run('what is this?');
      assert.ok(sentTools[0].includes('run_command'));
      assert.deepEqual(sentTools[1], sentTools[0], 'second request offers the same tools in the same order');
      const p = agent.run('one');
      await assert.rejects(agent.run('two'), /already working/);
      await p;
      const info = agent.contextInfo();
      assert.ok(info.cache.files && info.session.tasks === 3);
    } finally {
      await env.cleanup();
    }
  });
});

describe('permissions', () => {
  test('once / always / never / cancel and exact-rejection memory', async () => {
    const answers = ['no', 'never', 'cancel', 'always'];
    const asked = [];
    let cancelled = 0;
    const decisions = [];
    const p = new Permissions({ approvals: { runCommand: true, deleteFile: true, moveFile: true }, prompt: async (d, a) => (asked.push(`${a}:${d}`), answers.shift()) });
    p.onCancel = () => cancelled++;
    p.onDecision = (d) => decisions.push(d.answer);
    assert.equal(await p.confirm('runCommand', 'rm x'), false); // no
    assert.equal(await p.confirm('runCommand', 'rm x'), false, 'same request again: refused without asking');
    assert.equal(asked.length, 1);
    p.beginTask();
    assert.equal(await p.confirm('runCommand', 'rm x'), false); // never
    assert.equal(await p.confirm('runCommand', 'ls'), false, 'never = whole action denied for the session');
    assert.equal(asked.length, 2);
    assert.equal(await p.confirm('deleteFile', 'a.txt'), false); // cancel
    assert.equal(cancelled, 1);
    assert.equal(await p.confirm('moveFile', 'a -> b'), true); // always
    assert.equal(await p.confirm('moveFile', 'c -> d'), true);
    assert.equal(asked.length, 4);
    assert.deepEqual(decisions, ['no', 'denied-before', 'never', 'denied-before', 'cancel', 'always', 'always']);
    p.revokeAll();
    assert.equal(p.isDenied('runCommand'), false);
  });
});

describe('model tiers and token caps', () => {
  test('simple requests use models.simple; output cap reaches the provider', async () => {
    const env = await makeEnv();
    try {
      const seen = [];
      const provider = { async chat({ model, maxTokens }) { seen.push({ model, maxTokens }); return textReply('ok'); } };
      const settings = { ...DEFAULTS, retry: { retries: 0 }, models: { simple: 'small-model' }, tokens: { maxOutput: 1234 } };
      const agent = new Agent({ provider, registry: env.registry, settings, guard: env.guard, permissions: env.permissions, model: 'big-model' });
      await agent.run('fix the typo in README.md');
      await agent.run('Refactor the whole project:\n- split agent.js\n- add tests\n- update README.md\n- then run all tests');
      assert.deepEqual(seen, [{ model: 'small-model', maxTokens: 1234 }, { model: 'big-model', maxTokens: 1234 }]);
    } finally {
      await env.cleanup();
    }
  });
});
