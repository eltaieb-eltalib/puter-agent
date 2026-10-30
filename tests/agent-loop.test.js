import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Agent } from '../core/agent.js';
import { runAgentLoop } from '../core/agent-loop.js';
import { normalizeResponse } from '../providers/puter.js';
import { AgentError, ErrorKind, classifyError, explainError, registerSecret } from '../utils/errors.js';
import { withRetry } from '../utils/retry.js';
import { FakeProvider, makeEnv, textReply, toolReply } from './helpers.js';
import { DEFAULTS } from '../config/load.js';

/** Every assistant tool_call must be answered by a tool message with the same id, in order. */
function assertHistoryValid(messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    const answers = messages.slice(i + 1, i + 1 + m.tool_calls.length);
    assert.deepEqual(
      answers.map((a) => [a.role, a.tool_call_id]),
      m.tool_calls.map((c) => ['tool', c.id]),
      'tool_calls must be answered immediately and in order',
    );
  }
}

describe('agent loop', () => {
  let env;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(() => env.cleanup());

  const loop = (provider, extra = {}) => {
    const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'build a calculator' }];
    const promise = runAgentLoop({
      provider,
      model: 'fake',
      messages,
      registry: env.registry,
      ctx: env.ctx,
      maxSteps: 10,
      retry: { retries: 3, baseDelayMs: 1, maxDelayMs: 2 },
      ...extra,
    });
    return { messages, promise };
  };

  test('multi-step task: several tool calls per turn, results fed back, final answer', async () => {
    const provider = new FakeProvider([
      toolReply(
        [
          { name: 'create_directory', args: { path: 'calculator' } },
          { name: 'create_file', args: { path: 'calculator/index.html', content: '<script src="script.js"></script>' } },
          { name: 'create_file', args: { path: 'calculator/style.css', content: 'body{}' } },
          { name: 'create_file', args: { path: 'calculator/script.js', content: 'console.log("calc")' } },
        ],
        'Plan: create 3 files.',
      ),
      toolReply([{ name: 'list_files', args: { path: 'calculator' } }]),
      toolReply([{ name: 'run_node', args: { file: 'calculator/script.js' } }]),
      textReply('Done: calculator created.'),
    ]);
    const { messages, promise } = loop(provider);
    const result = await promise;

    assert.equal(result.stopReason, 'done');
    assert.equal(result.content, 'Done: calculator created.');
    assert.equal(result.steps, 4);
    for (const f of ['index.html', 'style.css', 'script.js']) {
      assert.ok(await fs.stat(path.join(env.dir, 'calculator', f)));
    }
    assert.equal(env.ctx.changes.filter((c) => c.action === 'created').length, 3);
    assertHistoryValid(messages);

    // The model really received the tool results (turn 2 sees 4 tool messages).
    const turn2 = provider.calls[1];
    assert.equal(turn2.filter((m) => m.role === 'tool').length, 4);
    const listing = JSON.parse(provider.calls[2].filter((m) => m.role === 'tool').at(-1).content);
    assert.deepEqual(listing.result.entries, ['index.html', 'script.js', 'style.css']);
    const run = JSON.parse(messages.filter((m) => m.role === 'tool').at(-1).content);
    assert.match(run.result.stdout, /calc/);
  });

  test('a failing tool is reported to the model, which can recover', async () => {
    await fs.writeFile(path.join(env.dir, 'app.js'), 'const x = 1;\n');
    const provider = new FakeProvider([
      toolReply([{ name: 'edit_file', args: { path: 'app.js', old_string: 'const y = 1;', new_string: 'const y = 2;' } }]),
      (messages) => {
        const last = JSON.parse(messages.at(-1).content);
        assert.equal(last.ok, false);
        assert.match(last.error, /not found/);
        return toolReply([{ name: 'edit_file', args: { path: 'app.js', old_string: 'const x = 1;', new_string: 'const x = 2;' } }]);
      },
      textReply('fixed'),
    ]);
    const { promise } = loop(provider);
    assert.equal((await promise).stopReason, 'done');
    assert.equal(await fs.readFile(path.join(env.dir, 'app.js'), 'utf8'), 'const x = 2;\n');
  });

  test('malformed tool arguments produce an error result, not a crash', async () => {
    const provider = new FakeProvider([
      toolReply([{ name: 'create_file', args: {}, parseError: 'not valid JSON' }]),
      textReply('ok'),
    ]);
    const { messages, promise } = loop(provider);
    await promise;
    assert.equal(JSON.parse(messages.find((m) => m.role === 'tool').content).ok, false);
    assertHistoryValid(messages);
  });

  test('step limit stops the loop with a valid history', async () => {
    const forever = Array.from({ length: 10 }, (_, i) =>
      toolReply([{ name: 'list_files', args: { path: '.', max_entries: i + 1 } }]),
    );
    const { messages, promise } = loop(new FakeProvider(forever), { maxSteps: 3 });
    const result = await promise;
    assert.equal(result.stopReason, 'max_steps');
    assert.equal(result.steps, 3);
    assertHistoryValid(messages);
  });

  test('three identical failing calls stop the loop as "stuck"', async () => {
    const bad = () => toolReply([{ name: 'read_file', args: { path: 'missing.txt' } }]);
    const { promise } = loop(new FakeProvider([bad(), bad(), bad(), bad()]));
    assert.equal((await promise).stopReason, 'stuck');
  });

  test('empty reply is nudged once, then accepted', async () => {
    const provider = new FakeProvider([textReply(''), textReply('all done')]);
    const { promise } = loop(provider);
    const result = await promise;
    assert.equal(result.content, 'all done');
    assert.match(provider.calls[1].at(-1).content, /no text and no tool call/);
  });

  test('cancelling during a tool run still answers every pending tool call', async () => {
    const controller = new AbortController();
    env.registry.register({
      name: 'abort_now',
      description: 'test helper',
      execute: async () => {
        controller.abort();
        return { summary: 'aborted' };
      },
    });
    const provider = new FakeProvider([
      toolReply([
        { name: 'abort_now', args: {} },
        { name: 'create_file', args: { path: 'never.txt', content: 'x' } },
      ]),
    ]);
    const { messages, promise } = loop(provider, { signal: controller.signal });
    const result = await promise;
    assert.equal(result.stopReason, 'aborted');
    assertHistoryValid(messages);
    assert.match(messages.at(-1).content, /Cancelled/);
    await assert.rejects(fs.access(path.join(env.dir, 'never.txt')));
  });

  test('transient provider errors are retried with backoff events', async () => {
    const events = [];
    const provider = new FakeProvider([
      Object.assign(new Error('Too many requests'), { status: 429 }),
      new Error('fetch failed'),
      textReply('finally'),
    ]);
    const { promise } = loop(provider, { emit: (e) => events.push(e) });
    const result = await promise;
    assert.equal(result.content, 'finally');
    assert.deepEqual(
      events.filter((e) => e.type === 'retry').map((e) => [e.attempt, e.error.kind]),
      [[1, ErrorKind.RATE_LIMIT], [2, ErrorKind.NETWORK]],
    );
  });

  test('402 (no credit) and 401 (auth) are NOT retried', async () => {
    for (const [status, kind] of [[402, ErrorKind.PAYMENT], [401, ErrorKind.AUTH]]) {
      const provider = new FakeProvider([Object.assign(new Error('nope'), { status }), textReply('should not be reached')]);
      const { promise } = loop(provider);
      await assert.rejects(promise, (err) => err instanceof AgentError && err.kind === kind);
      assert.equal(provider.calls.length, 1);
    }
  });

  test('retries stop after the configured limit', async () => {
    const err = () => Object.assign(new Error('Service Unavailable'), { status: 503 });
    const provider = new FakeProvider([err(), err(), err(), err(), err()]);
    const { promise } = loop(provider, { retry: { retries: 2, baseDelayMs: 1, maxDelayMs: 2 } });
    await assert.rejects(promise, (e) => e.kind === ErrorKind.SERVER);
    assert.equal(provider.calls.length, 3);
  });
});

describe('Agent (conversation)', () => {
  let env;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(() => env.cleanup());

  const makeAgent = (provider) =>
    new Agent({
      provider,
      registry: env.registry,
      settings: { ...DEFAULTS, retry: { retries: 0, baseDelayMs: 1, maxDelayMs: 1 } },
      guard: env.guard,
      permissions: env.permissions,
      model: 'fake',
    });

  test('context is kept between requests and the system prompt names the workspace', async () => {
    const provider = new FakeProvider([textReply('Hi Sam'), textReply('Your name is Sam')]);
    const agent = makeAgent(provider);
    await agent.run('My name is Sam');
    const second = await agent.run('What is my name?');
    assert.equal(second.content, 'Your name is Sam');
    const sent = provider.calls[1];
    assert.deepEqual(sent.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
    assert.ok(sent[0].content.includes(env.guard.root));
    agent.reset();
    assert.equal(agent.messages.length, 1);
  });

  test('a failed request leaves no dangling user message and the next one works', async () => {
    const provider = new FakeProvider([
      Object.assign(new Error('insufficient credits'), { status: 402 }),
      textReply('recovered'),
    ]);
    const agent = makeAgent(provider);
    await assert.rejects(agent.run('hello'), (e) => e.kind === ErrorKind.PAYMENT);
    assert.deepEqual(agent.messages.map((m) => m.role), ['system']);
    assert.equal((await agent.run('hello again')).content, 'recovered');
  });

  test('"continue" after a mid-task failure resumes with the earlier tool work in context', async () => {
    const provider = new FakeProvider([
      toolReply([{ name: 'create_file', args: { path: 'a.txt', content: 'A' } }]),
      new Error('fetch failed'), // network drops after the first tool round
      textReply('finished the rest'),
    ]);
    const agent = makeAgent(provider);
    await assert.rejects(agent.run('make files'), (e) => e.kind === ErrorKind.NETWORK);
    assertHistoryValid(agent.messages);
    const resumed = await agent.run('continue');
    assert.equal(resumed.content, 'finished the rest');
    assert.ok(provider.calls[2].some((m) => m.role === 'tool'), 'earlier tool results are still in context');
  });

  test('old tool results are shortened to protect the context window', async () => {
    const big = 'x'.repeat(5000);
    const replies = [];
    for (let i = 0; i < 12; i++) replies.push(toolReply([{ name: 'create_file', args: { path: `f${i}.txt`, content: big } }]));
    replies.push(textReply('done'));
    const agent = makeAgent(new FakeProvider(replies));
    agent.messages.push({ role: 'tool', tool_call_id: 'old', content: 'y'.repeat(5000) });
    await agent.run('go');
    const old = agent.messages.find((m) => m.tool_call_id === 'old');
    assert.ok(old.content.length < 600);
    assert.match(old.content, /shortened/);
  });
});

describe('provider response parsing', () => {
  test('parses OpenAI-format tool calls (arguments are a JSON string)', () => {
    const r = normalizeResponse({
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'abc', type: 'function', function: { name: 'create_file', arguments: '{"path":"a","content":"b"}' } }],
      },
    });
    assert.equal(r.content, '');
    assert.deepEqual(r.toolCalls[0].arguments, { path: 'a', content: 'b' });
    assert.equal(r.message.tool_calls[0].id, 'abc');
  });

  test('invalid JSON arguments become a parseError and are never replayed', () => {
    const r = normalizeResponse({
      message: { content: '', tool_calls: [{ id: '1', function: { name: 'x', arguments: '{oops' } }] },
    });
    assert.match(r.toolCalls[0].parseError, /not valid JSON/);
    assert.equal(r.message.tool_calls[0].function.arguments, '{}');
  });

  test('plain text replies, array content and missing ids are handled', () => {
    assert.equal(normalizeResponse({ message: { content: 'hello' } }).content, 'hello');
    assert.equal(normalizeResponse({ message: { content: [{ type: 'text', text: 'a' }, { text: 'b' }] } }).content, 'ab');
    const r = normalizeResponse({ message: { content: '', tool_calls: [{ function: { name: 'x', arguments: {} } }] } });
    assert.ok(r.toolCalls[0].id);
  });

  test('error-shaped responses throw classified errors', () => {
    assert.throws(
      () => normalizeResponse({ success: false, error: { code: 'insufficient_funds', message: 'no credits' } }),
      (e) => e.kind === ErrorKind.PAYMENT,
    );
    assert.throws(() => normalizeResponse({ nonsense: true }), /Unexpected response shape/);
  });
});

describe('error classification and retry', () => {
  test('classifies common failure shapes', () => {
    const cases = [
      [{ status: 429 }, ErrorKind.RATE_LIMIT],
      [{ status: 402 }, ErrorKind.PAYMENT],
      [{ status: 401 }, ErrorKind.AUTH],
      [{ status: 403, message: 'Forbidden' }, ErrorKind.AUTH],
      [{ status: 503 }, ErrorKind.SERVER],
      [{ status: 400, message: 'bad' }, ErrorKind.BAD_REQUEST],
      [{ code: 'network_error', message: 'x' }, ErrorKind.NETWORK],
      [{ code: 'request_timeout', message: 'x' }, ErrorKind.TIMEOUT],
      [{ error: { code: 'token_auth_failed', message: 'x' } }, ErrorKind.AUTH],
      ['fetch failed', ErrorKind.NETWORK],
      [Object.assign(new Error('x'), { name: 'AbortError' }), ErrorKind.ABORTED],
      [new Error('something odd'), ErrorKind.UNKNOWN],
    ];
    for (const [input, kind] of cases) {
      const err = input instanceof Error || typeof input === 'string' ? input : Object.assign(new Error(input.message ?? 'x'), input);
      assert.equal(classifyError(err).kind, kind, JSON.stringify(input));
    }
    assert.equal(classifyError({ success: false, error: { code: 'insufficient_funds', message: 'x' } }).kind, ErrorKind.PAYMENT);
  });

  test('Puter network failures (raw XHR-like object) are NETWORK errors and never leak the token or request', () => {
    // Shape observed from @heyputer/puter.js when api.puter.com is unreachable.
    const xhrLike = {
      upload: {},
      response: null,
      status: 0,
      timeout: 0,
      _puterReq: { url: 'https://api.puter.com/drivers/call', body: '{"auth_token":"tok-SECRET-123456","messages":[{"content":"SYSTEM PROMPT TEXT"}]}' },
    };
    registerSecret('tok-SECRET-123456');
    const e = classifyError(xhrLike);
    assert.equal(e.kind, ErrorKind.NETWORK);
    assert.equal(e.retryable, true);
    assert.ok(!/SECRET|SYSTEM PROMPT/.test(e.message), e.message);
    assert.ok(!/SECRET|SYSTEM PROMPT/.test(explainError(xhrLike)));
  });

  test('registered secrets are masked in any error message; unknown objects are redacted and truncated', () => {
    registerSecret('another-secret-value');
    assert.equal(new AgentError('failed with another-secret-value!').message, 'failed with ***!');
    const msg = classifyError({ weird: true, auth_token: 'abc12345', body: 'x'.repeat(1000), note: 'y'.repeat(1000) }).message;
    assert.ok(!msg.includes('abc12345'));
    assert.ok(msg.length < 400);
  });

  test('the word "timeout" inside unrelated text does not make a non-timeout error a timeout', () => {
    assert.equal(classifyError(Object.assign(new Error('config timeoutMs=0'), { status: 500 })).kind, ErrorKind.SERVER);
    assert.equal(classifyError(new Error('Request timeout')).kind, ErrorKind.TIMEOUT);
    assert.equal(classifyError(new Error('Request timed out')).kind, ErrorKind.TIMEOUT);
    assert.equal(classifyError(new Error('overtimeout-free')).kind, ErrorKind.UNKNOWN);
  });

  test('exponential backoff doubles the delay and honours the cap', async () => {
    const delays = [];
    let n = 0;
    await withRetry(
      async () => {
        if (++n < 5) throw Object.assign(new Error('x'), { status: 503 });
        return 'ok';
      },
      { retries: 5, baseDelayMs: 100, maxDelayMs: 500, jitter: false, sleep: async (ms) => delays.push(ms) },
    );
    assert.deepEqual(delays, [100, 200, 400, 500]);
  });
});
