import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { Agent } from '../core/agent.js';
import { routeRequest } from '../core/router.js';
import { DEFAULTS } from '../config/load.js';
import { ToolRegistry } from '../tools/registry.js';
import { assertPublicUrl, isPrivateAddress } from '../tools/web.js';
import { FakeProvider, makeEnv, textReply } from './helpers.js';

describe('request router', () => {
  test('explicit search requests (Arabic and English) are routed with a clean query', () => {
    const cases = [
      ['ابحث لي عن نشيد العلم السوداني', 'نشيد العلم السوداني'],
      ['ابحث لي عن نشيد العلم السوداني في الانترنت', 'نشيد العلم السوداني'],
      ['من فضلك ابحث عن أسعار الذهب', 'أسعار الذهب'],
      ['search the internet for node 22 release notes', 'node 22 release notes'],
      ['ابحث عن مكتبة express ثم اعمل مشروع بيها', 'مكتبة express'],
    ];
    for (const [text, query] of cases) {
      const r = routeRequest(text);
      assert.equal(r.research, true, text);
      assert.equal(r.query, query, text);
    }
  });

  test('lookups without a search verb are routed only when nothing says "build" or "me/this"', () => {
    assert.equal(routeRequest('كلمات نشيد العلم').research, true);
    assert.equal(routeRequest('شنو اخبار اليوم؟').research, true);
    assert.equal(routeRequest('who is the CEO of Netflix?').research, true);
  });

  test('coding, project and conversation requests are never routed', () => {
    for (const text of [
      'اعمل لي تطبيق todo',
      'اكتب كود لحساب فيبوناتشي',
      'fix the bug in app.js',
      'what does this project do?',
      'What is my name?',
      'ما هو ملف package.json؟',
      'what is a closure in JavaScript?',
      'hello',
      '/help',
      '',
    ]) {
      assert.equal(routeRequest(text).research, false, text);
    }
  });
});

describe('Agent runs the routed search before the first model call', () => {
  const makeAgent = async (provider, settings = {}) => {
    const env = await makeEnv();
    const searches = [];
    const registry = new ToolRegistry().register({
      name: 'web_search',
      readOnly: true,
      description: 'fake search',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      execute: async ({ query }) => {
        searches.push(query);
        return { query, results: [{ title: 'نشيد العلم', url: 'https://example.org/anthem', snippet: 'x' }] };
      },
    });
    const agent = new Agent({
      provider,
      registry,
      settings: { ...DEFAULTS, ...settings },
      guard: env.guard,
      permissions: env.permissions,
      model: 'fake',
    });
    return { agent, searches, env };
  };

  test('search result is in the history the model sees, and the history is valid', async () => {
    const provider = new FakeProvider([textReply('done')]);
    const { agent, searches, env } = await makeAgent(provider);
    const events = [];
    await agent.run('ابحث لي عن نشيد العلم السوداني', { emit: (e) => events.push(e.type) });

    assert.deepEqual(searches, ['نشيد العلم السوداني']);
    const seen = provider.calls[0];
    assert.deepEqual(seen.map((m) => m.role), ['system', 'user', 'assistant', 'tool']);
    assert.equal(seen[2].tool_calls[0].id, seen[3].tool_call_id);
    assert.match(seen[3].content, /example\.org/);
    assert.deepEqual(events.slice(0, 2), ['tool_call', 'tool_result']);
    await env.cleanup();
  });

  test('normal requests and forceSearch:false do not search', async () => {
    let p = new FakeProvider([textReply('ok')]);
    let { agent, searches, env } = await makeAgent(p);
    await agent.run('اعمل لي تطبيق todo');
    assert.equal(searches.length, 0);
    await env.cleanup();

    p = new FakeProvider([textReply('ok')]);
    ({ agent, searches, env } = await makeAgent(p, { routing: { forceSearch: false } }));
    await agent.run('ابحث عن شيء');
    assert.equal(searches.length, 0);
    await env.cleanup();
  });
});

describe('web_fetch SSRF guard', () => {
  let server;
  let base;
  before(async () => {
    server = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('secret'));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  test('private, loopback, link-local and mapped addresses are recognised', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
  });

  test('assertPublicUrl blocks local names, IP literals (also decimal / hex forms) and metadata', async () => {
    for (const url of ['http://localhost/', 'http://app.localhost/', 'http://printer.local/', 'http://127.0.0.1:8080/', 'http://169.254.169.254/latest/meta-data/', 'http://2130706433/', 'http://0x7f000001/', 'http://[::1]/', 'http://[::ffff:7f00:1]/']) {
      await assert.rejects(assertPublicUrl(url), /Blocked/, url);
    }
    await assertPublicUrl('http://8.8.8.8/'); // public literal passes (no DNS needed)
  });

  test('web_fetch refuses a local server by default and reads it only when explicitly allowed', async () => {
    const env = await makeEnv();
    const blocked = await env.run('web_fetch', { url: `${base}/x` });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /Blocked/);

    env.ctx.settings = { ...DEFAULTS, search: { ...DEFAULTS.search, allowPrivateFetch: true } };
    const allowed = await env.run('web_fetch', { url: `${base}/x` });
    assert.ok(allowed.ok, allowed.error);
    assert.equal(allowed.result.content, 'secret');
    await env.cleanup();
  });
});
