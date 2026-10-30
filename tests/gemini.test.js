import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { Agent } from '../core/agent.js';
import { DEFAULTS } from '../config/load.js';
import { GeminiProvider, SKIP_SIGNATURE, normalizeThinkingLevel, cleanSchema, normalizeGeminiResponse, pickDefaultModel, toGeminiContents, toGeminiTools } from '../providers/gemini.js';
import { createDefaultRegistry } from '../tools/index.js';
import { ErrorKind, classifyError, explainError } from '../utils/errors.js';
import { makeEnv } from './helpers.js';

/** The schema rules the real Gemini API enforces (a violation is an HTTP 400). Returns a list of problems. */
function schemaProblems(node, where) {
  const out = [];
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'array' && !node.items) out.push(`${where}: array without items`);
  if (node.type === 'object' && node.properties && Object.keys(node.properties).length === 0) out.push(`${where}: object with empty properties`);
  for (const key of Object.keys(node)) {
    if (!['type', 'description', 'properties', 'required', 'items', 'enum', 'format', 'nullable'].includes(key)) out.push(`${where}: unsupported key "${key}"`);
  }
  for (const [k, v] of Object.entries(node.properties ?? {})) out.push(...schemaProblems(v, `${where}.${k}`));
  if (node.items) out.push(...schemaProblems(node.items, `${where}[]`));
  return out;
}

describe('Gemini conversion', () => {
  test('regression: every array has items (the real API answered 400 "items: missing field")', () => {
    const decls = toGeminiTools(createDefaultRegistry().definitions())[0].functionDeclarations;
    const problems = decls.flatMap((d) => schemaProblems(d.parameters, d.name));
    assert.deepEqual(problems, []);
    // the converter also repairs a third-party tool that forgot items
    assert.deepEqual(cleanSchema({ type: 'array' }), { type: 'array', items: { type: 'string' } });
  });

  test('pickDefaultModel picks the newest flash model, never a random first entry', () => {
    const list = (...ids) => ids.map((id) => ({ id }));
    assert.equal(pickDefaultModel(list('antigravity-preview-05-2026', 'gemini-2.5-flash', 'gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-3.8-flash-tts', 'gemini-3.8-live')), 'gemini-3.8-flash');
    assert.equal(pickDefaultModel(list('gemini-3.8-flash', 'gemini-3.10-flash')), 'gemini-3.10-flash');
    assert.equal(pickDefaultModel(list('antigravity-x', 'gemini-2.5-pro')), 'gemini-2.5-pro');
    assert.equal(pickDefaultModel(list('zzz')), 'zzz');
  });

  test('a retired model (404) gets a clear, non-misleading error', () => {
    const e = classifyError(Object.assign(new Error('[404 Not Found] This model models/gemini-2.5-flash is no longer available to new users.'), { status: 404 }));
    assert.equal(e.kind, ErrorKind.MODEL_NOT_FOUND);
    assert.equal(e.retryable, false);
    assert.match(explainError(e), /retired|does not exist/);
    assert.doesNotMatch(explainError(e), /function calling/);
  });

  test('thought signatures: kept from the response, replayed on the call; placeholder only when missing', () => {
    const r = normalizeGeminiResponse({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { name: 'list_files', args: {} }, thoughtSignature: 'SIG123' }] } }] });
    assert.equal(r.message.tool_calls[0].thought_signature, 'SIG123');
    const history = [
      { role: 'user', content: 'go' },
      r.message,
      { role: 'tool', tool_call_id: r.toolCalls[0].id, content: '{}' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    ];
    const real = toGeminiContents(history).contents;
    assert.equal(real[1].parts[0].thoughtSignature, 'SIG123');
    assert.equal(real[3].parts[0].thoughtSignature, undefined, 'no placeholder unless asked');
    const skip = toGeminiContents(history, { skipSignatureCheck: true }).contents;
    assert.equal(skip[1].parts[0].thoughtSignature, 'SIG123', 'a real signature is never replaced');
    assert.equal(skip[3].parts[0].thoughtSignature, SKIP_SIGNATURE);
  });

  test('every built-in tool converts to a valid declaration (no empty object schemas)', () => {
    const decls = toGeminiTools(createDefaultRegistry().definitions())[0].functionDeclarations;
    assert.ok(decls.length >= 10);
    for (const d of decls) {
      assert.ok(d.name && d.description);
      if (d.parameters) assert.ok(Object.keys(d.parameters.properties ?? {}).length > 0, `${d.name} has empty properties`);
      assert.doesNotMatch(JSON.stringify(d), /additionalProperties|\$schema/);
    }
  });

  test('history: system -> systemInstruction, tool results grouped into one user turn with the right names', () => {
    const { systemInstruction, contents } = toGeminiContents([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'checking',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
          { id: 'c2', type: 'function', function: { name: 'list_files', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true,"result":{"x":1}}' },
      { role: 'tool', tool_call_id: 'c2', content: 'plain text, not json' },
      { role: 'assistant', content: 'done' },
    ]);
    assert.equal(systemInstruction.parts[0].text, 'be brief');
    assert.deepEqual(contents.map((c) => c.role), ['user', 'model', 'user', 'model']);
    assert.deepEqual(contents[1].parts[2], { functionCall: { name: 'list_files', args: {} } });
    const responses = contents[2].parts.map((p) => p.functionResponse);
    assert.deepEqual(responses.map((r) => r.name), ['read_file', 'list_files']);
    assert.deepEqual(responses[0].response, { ok: true, result: { x: 1 } });
    assert.deepEqual(responses[1].response, { result: 'plain text, not json' });
  });

  test('response: text + function calls become the shape the agent loop expects', () => {
    const r = normalizeGeminiResponse({
      candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'hi ' }, { functionCall: { name: 'web_search', args: { query: 'q' } } }] } }],
    });
    assert.equal(r.content, 'hi ');
    assert.equal(r.toolCalls[0].name, 'web_search');
    assert.deepEqual(r.toolCalls[0].arguments, { query: 'q' });
    assert.equal(r.message.tool_calls[0].function.arguments, '{"query":"q"}');
    assert.equal(r.message.tool_calls[0].id, r.toolCalls[0].id);
    assert.throws(() => normalizeGeminiResponse({ candidates: [] }), (e) => e.kind === ErrorKind.BAD_REQUEST);
  });
});

// ---- the real SDK talking to a local fake of the Gemini REST API ----------------------------------
describe('Gemini end to end (real SDK + fake Gemini server + real tools)', () => {
  let server;
  let base;
  const requests = [];
  let script = [];

  before(async () => {
    server = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = body ? JSON.parse(body) : {};
      requests.push({ url: req.url, key: req.headers['x-goog-api-key'], body: parsed });
      const problems = (parsed.tools?.[0]?.functionDeclarations ?? []).flatMap((d) => schemaProblems(d.parameters, d.name));
      if (problems.length) {
        return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 400, message: problems.join('; ') } }));
      }
      if (/gemini-[3-9]/.test(req.url)) {
        const missing = (parsed.contents ?? []).some((c) => c.role === 'model' && c.parts.some((p) => p.functionCall && !p.thoughtSignature));
        if (missing) {
          return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 400, message: 'Function call is missing a thought_signature in functionCall parts.' } }));
        }
      }
      const level = parsed.generationConfig?.thinkingConfig?.thinkingLevel;
      if (/gemini-3\.[78]-/.test(req.url) && level === 'minimal') {
        return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 400, message: 'Thinking level MINIMAL is not supported for this model. Please retry with other thinking level.' } }));
      }
      const reply = script.shift();
      if (reply?.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      if (reply?.status) return res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: reply.status, message: reply.message } }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts: reply.parts } }] }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const provider = () => new GeminiProvider({ apiKey: 'test-key-1234567890', baseUrl: base, timeoutMs: 5000 });

  test('agent calls a tool through Gemini, gets the result back, and answers', async () => {
    requests.length = 0;
    const env = await makeEnv();
    await env.run('create_file', { path: 'hello.txt', content: 'hi from the workspace' });

    script = [
      { parts: [{ text: 'let me look' }, { functionCall: { name: 'list_files', args: {} } }] },
      { parts: [{ text: 'The workspace contains hello.txt' }] },
    ];
    const agent = new Agent({
      provider: provider(),
      registry: env.registry,
      settings: { ...DEFAULTS, retry: { retries: 0, baseDelayMs: 1, maxDelayMs: 1 } },
      guard: env.guard,
      permissions: env.permissions,
      model: 'gemini-2.5-flash',
    });
    const result = await agent.run('what files are here?');

    assert.equal(result.stopReason, 'done');
    assert.equal(result.content, 'The workspace contains hello.txt');
    assert.equal(requests.length, 2);

    const [first, second] = requests;
    assert.match(first.url, /models\/gemini-2\.5-flash:generateContent$/);
    assert.equal(first.key, 'test-key-1234567890');
    assert.match(first.body.systemInstruction.parts[0].text, /Puter Agent/);
    assert.ok(first.body.tools[0].functionDeclarations.some((d) => d.name === 'list_files'));
    assert.deepEqual(first.body.contents.map((c) => c.role), ['user']);

    assert.deepEqual(second.body.contents.map((c) => c.role), ['user', 'model', 'user']);
    const fr = second.body.contents[2].parts[0].functionResponse;
    assert.equal(fr.name, 'list_files');
    assert.match(JSON.stringify(fr.response), /hello\.txt/, 'the real tool output must reach Gemini');
    await env.cleanup();
  });

  test('Gemini 3.8: signature from the first reply is sent back, and no temperature override', async () => {
    requests.length = 0;
    const env = await makeEnv();
    script = [
      { parts: [{ functionCall: { name: 'list_files', args: {} }, thoughtSignature: 'REAL-SIG-1' }] },
      { parts: [{ text: 'done' }] },
    ];
    const agent = new Agent({
      provider: provider(),
      registry: env.registry,
      settings: { ...DEFAULTS, retry: { retries: 0, baseDelayMs: 1, maxDelayMs: 1 } },
      guard: env.guard,
      permissions: env.permissions,
      model: 'gemini-3.8-flash',
    });
    const result = await agent.run('list the files');
    assert.equal(result.content, 'done');
    assert.match(requests[0].url, /models\/gemini-3\.8-flash:generateContent$/);
    assert.equal(requests[0].body.generationConfig?.temperature, undefined);
    assert.equal(requests[1].body.contents[1].parts[0].thoughtSignature, 'REAL-SIG-1');
    await env.cleanup();
  });

  test('thinking: Gemini 3 gets thinkingLevel "low" by default (fast), configurable, and off means nothing sent', async () => {
    const msgs = [{ role: 'user', content: 'hi' }];
    requests.length = 0;
    script = [{ parts: [{ text: 'a' }] }, { parts: [{ text: 'b' }] }, { parts: [{ text: 'c' }] }, { parts: [{ text: 'd' }] }];
    await provider().chat({ model: 'gemini-3.8-flash', messages: msgs });
    await new GeminiProvider({ apiKey: 'test-key-1234567890', baseUrl: base, thinkingLevel: 'high' }).chat({ model: 'gemini-3.8-flash', messages: msgs });
    await new GeminiProvider({ apiKey: 'test-key-1234567890', baseUrl: base, thinkingLevel: 'off' }).chat({ model: 'gemini-3.8-flash', messages: msgs });
    await provider().chat({ model: 'gemini-2.5-flash', messages: msgs }); // 2.x has no thinkingLevel
    assert.equal(requests[0].body.generationConfig.thinkingConfig.thinkingLevel, 'low');
    assert.equal(requests[1].body.generationConfig.thinkingConfig.thinkingLevel, 'high');
    assert.equal(requests[2].body.generationConfig?.thinkingConfig, undefined);
    assert.equal(requests[3].body.generationConfig.thinkingConfig, undefined);
    assert.equal(requests[3].body.generationConfig.temperature, 0.2);
  });

  test('thinking: a level the model rejects (minimal on 3.8) is dropped automatically and the call still succeeds', async () => {
    requests.length = 0;
    script = [{ parts: [{ text: 'ok1' }] }, { parts: [{ text: 'ok2' }] }];
    const p = new GeminiProvider({ apiKey: 'test-key-1234567890', baseUrl: base, thinkingLevel: 'minimal' });
    const first = await p.chat({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(first.content, 'ok1');
    assert.equal(requests.length, 2, 'one rejected attempt + one retry');
    assert.equal(requests[1].body.generationConfig?.thinkingConfig, undefined);
    await p.chat({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'again' }] });
    assert.equal(requests.length, 3, 'the bad level is not sent again');
  });

  test('normalizeThinkingLevel', () => {
    assert.equal(normalizeThinkingLevel(undefined), 'low');
    assert.equal(normalizeThinkingLevel('HIGH'), 'high');
    assert.equal(normalizeThinkingLevel('off'), null);
    assert.equal(normalizeThinkingLevel('banana'), 'low');
    assert.equal(new GeminiProvider({ apiKey: 'test-key-1234567890', thinkingLevel: '' }).thinkingLevel, 'low');
  });

  test('HTTP errors are classified (auth, rate limit) so retry logic works', async () => {
    script = [{ status: 403, message: 'API key not valid' }];
    await assert.rejects(provider().chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }), (e) => e.kind === ErrorKind.AUTH);
    script = [{ status: 429, message: 'Resource has been exhausted' }];
    await assert.rejects(provider().chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }), (e) => e.kind === ErrorKind.RATE_LIMIT && e.retryable);
  });

  test('cancelling aborts the request', async () => {
    script = [{ parts: [{ text: 'late' }] }];
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(provider().chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], signal: ac.signal }), (e) => e.kind === ErrorKind.ABORTED);
  });

  test('cancelling while the request is in flight aborts it', async () => {
    script = [{ delayMs: 1500, parts: [{ text: 'too late' }] }];
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);
    const started = Date.now();
    await assert.rejects(provider().chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], signal: ac.signal }), (e) => e.kind === ErrorKind.ABORTED);
    assert.ok(Date.now() - started < 1000, 'should not wait for the slow server');
  });

  test('listModels falls back to a curated list when the API is unreachable', async () => {
    const p = new GeminiProvider({ apiKey: 'test-key-1234567890', baseUrl: 'http://127.0.0.1:1' });
    const list = await p.listModels();
    assert.ok(list.some((m) => m.id === 'gemini-3.8-flash'));
  });
});
