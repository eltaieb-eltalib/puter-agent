import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { CompatibleProvider } from '../providers/compatible.js';
import { toAnthropicRequest, anthropicUsage, AnthropicProvider } from '../providers/anthropic.js';
import { runAgentLoop, usageTotals } from '../core/agent-loop.js';
import { makeEnv } from './helpers.js';

// A tiny OpenAI-compatible server. Behaviour is chosen per request by the test.
let server;
let baseURL;
let handler = null;
const requests = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      requests.push(json);
      handler(req, res, json);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${server.address().port}/v1`;
});
after(() => new Promise((r) => server.close(r)));

const sse = (res, chunks) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end('data: [DONE]\n\n');
};
const completion = (res, message, usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message, finish_reason: 'stop' }], usage }));
};

async function provider() {
  const p = new CompatibleProvider({ name: 'ollama', baseURL, defaultModel: 'm', timeoutMs: 5000 });
  await p.connect();
  return p;
}

describe('OpenAI-compatible provider over HTTP', () => {
  test('non-streaming reply with a tool call; json response_format is sent', async () => {
    handler = (req, res) => completion(res, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] });
    const p = await provider();
    const r = await p.chat({ messages: [{ role: 'user', content: 'hi' }], responseFormat: 'json' });
    assert.equal(r.toolCalls[0].name, 'read_file');
    assert.deepEqual(r.toolCalls[0].arguments, { path: 'a' });
    assert.deepEqual(requests.at(-1).response_format, { type: 'json_object' });
  });

  test('streaming: text deltas reach onDelta and tool-call fragments are assembled', async () => {
    handler = (req, res, json) => {
      assert.equal(json.stream, true);
      sse(res, [
        { choices: [{ index: 0, delta: { content: 'Let me ' } }] },
        { choices: [{ index: 0, delta: { content: 'check.' } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'list_', arguments: '{"pa' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'files', arguments: 'th":"."}' } }] } }] },
        { choices: [], usage: { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57, prompt_tokens_details: { cached_tokens: 32 } } },
      ]);
    };
    const p = await provider();
    const deltas = [];
    const r = await p.chat({ messages: [{ role: 'user', content: 'hi' }], onDelta: (d) => deltas.push(d) });
    assert.deepEqual(deltas, ['Let me ', 'check.']);
    assert.equal(r.content, 'Let me check.');
    assert.equal(r.toolCalls[0].id, 'call_9');
    assert.equal(r.toolCalls[0].name, 'list_files');
    assert.deepEqual(r.toolCalls[0].arguments, { path: '.' });
    assert.deepEqual(usageTotals(r.usage), { promptTokens: 50, completionTokens: 7, cachedTokens: 32, totalTokens: 57 });
  });

  test('a dropped connection is retried by the agent loop and the task completes', async () => {
    let n = 0;
    handler = (req, res) => {
      n++;
      if (n === 1) {
        req.socket.destroy(); // connection reset mid-request
        return;
      }
      completion(res, { role: 'assistant', content: 'recovered' });
    };
    const env = await makeEnv();
    try {
      const p = await provider();
      const events = [];
      const res = await runAgentLoop({
        provider: p,
        model: 'm',
        messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'go' }],
        registry: env.registry,
        ctx: env.ctx,
        retry: { retries: 2, baseDelayMs: 5, maxDelayMs: 10 },
        emit: (e) => events.push(e),
      });
      assert.equal(res.content, 'recovered');
      assert.equal(n, 2);
      const retry = events.find((e) => e.type === 'retry');
      assert.equal(retry.error.kind, 'network');
    } finally {
      await env.cleanup();
    }
  });

  test('a request that times out is reported as a timeout', async () => {
    handler = () => {}; // never answers
    const p = new CompatibleProvider({ name: 'ollama', baseURL, defaultModel: 'm', timeoutMs: 150 });
    await p.connect();
    await assert.rejects(p.chat({ messages: [{ role: 'user', content: 'hi' }] }), (e) => e.kind === 'timeout');
  });
});

describe('Anthropic prompt caching', () => {
  const tools = [
    { type: 'function', function: { name: 'a', description: 'A', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'b', description: 'B', parameters: { type: 'object', properties: {} } } },
  ];
  const messages = [
    { role: 'system', content: 'SYSTEM' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'a', arguments: '{"x":1}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'result' },
  ];

  test('cache breakpoints on system, last tool and newest message', () => {
    const body = toAnthropicRequest({ model: 'claude', messages, tools });
    assert.deepEqual(body.system, [{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }]);
    assert.equal(body.tools[0].cache_control, undefined);
    assert.deepEqual(body.tools[1].cache_control, { type: 'ephemeral' });
    assert.deepEqual(body.messages[1].content[0], { type: 'tool_use', id: 't1', name: 'a', input: { x: 1 } }, 'tool_calls from other providers are rebuilt');
    const last = body.messages.at(-1).content.at(-1);
    assert.equal(last.type, 'tool_result');
    assert.deepEqual(last.cache_control, { type: 'ephemeral' });
    assert.equal(messages[3].content, 'result', 'the history itself is not modified');
    const off = toAnthropicRequest({ model: 'claude', messages, tools, promptCaching: false });
    assert.equal(off.system, 'SYSTEM');
    assert.ok(!JSON.stringify(off).includes('cache_control'));
  });

  test('cache reads are reported as cached tokens', async () => {
    assert.deepEqual(usageTotals(anthropicUsage({ input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 20 })), {
      promptTokens: 1000, completionTokens: 20, cachedTokens: 900, totalTokens: 1020,
    });
    let sent;
    const fetchImpl = async (url, init) => {
      sent = JSON.parse(init.body);
      return { ok: true, json: async () => ({ content: [{ type: 'tool_use', id: 'u1', name: 'a', input: {} }], usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 40 } }) };
    };
    const p = new AnthropicProvider({ apiKey: 'test-key-123456', fetchImpl });
    const r = await p.chat({ messages, tools });
    assert.ok(sent.system[0].cache_control);
    assert.equal(r.message.tool_calls[0].id, 'u1');
    assert.equal(usageTotals(r.usage).cachedTokens, 40);
  });

  test('Gemini usage metadata is normalised', () => {
    assert.deepEqual(usageTotals({ promptTokenCount: 80, candidatesTokenCount: 5, totalTokenCount: 85, cachedContentTokenCount: 60 }), { promptTokens: 80, completionTokens: 5, cachedTokens: 60, totalTokens: 85 });
  });
});
