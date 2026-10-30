import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { DEFAULTS } from '../config/load.js';
import { runAgentLoop } from '../core/agent-loop.js';
import { buildSystemPrompt } from '../core/context.js';
import { extractTextToolCalls } from '../core/text-tools.js';
import { htmlToText, parseDuckDuckGo } from '../tools/web.js';
import { FakeProvider, makeEnv, textReply, toolReply } from './helpers.js';

let server;
let base;
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>نشيد &amp; اختبار</title>
<style>.x{}</style><script>var a=1;</script></head><body><nav>menu</nav><h1>العنوان</h1><p>السطر الأول<br>السطر الثاني</p><ul><li>أ</li><li>ب</li></ul></body></html>`;

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/search') {
      if (u.searchParams.get('q') === 'broken') {
        res.writeHead(403).end('json disabled');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [{ title: 'Result A', url: 'https://a.example', content: 'about A' }, { title: 'B', url: 'https://b.example', content: '' }] }));
    } else if (u.pathname === '/w/api.php') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ query: { search: [{ title: 'Sudan flag', snippet: 'the <span>flag</span>' }] } }));
    } else if (u.pathname === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    } else if (u.pathname === '/missing') {
      res.writeHead(404).end('no');
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('x'.repeat(3000));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const withSearch = (env, search) => {
  env.ctx.settings = { ...DEFAULTS, search: { ...DEFAULTS.search, ...search } };
};

describe('htmlToText / DuckDuckGo parser', () => {
  test('converts html to readable text and keeps Arabic', () => {
    const { title, text } = htmlToText(PAGE);
    assert.equal(title, 'نشيد & اختبار');
    assert.match(text, /العنوان\nالسطر الأول\nالسطر الثاني/);
    assert.match(text, /- أ\n- ب/);
    assert.doesNotMatch(text, /menu|var a/);
  });

  test('parses DuckDuckGo html results and decodes redirect urls', () => {
    const html = `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fx%3Fa%3D1&amp;rut=abc">Example <b>one</b></a>
      <a class="result__snippet" href="x">Snippet &amp; text</a>
      <a class="result__a" href="https://direct.example/">Two</a>`;
    const r = parseDuckDuckGo(html);
    assert.equal(r.length, 2);
    assert.deepEqual(r[0], { title: 'Example one', url: 'https://example.org/x?a=1', snippet: 'Snippet & text' });
    assert.equal(r[1].url, 'https://direct.example/');
  });
});

describe('web tools', () => {
  test('web_search via SearXNG JSON', async () => {
    const env = await makeEnv();
    withSearch(env, { providers: ['searxng'], searxngUrls: [base], timeoutMs: 3000 });
    const res = await env.run('web_search', { query: 'علم السودان' });
    assert.ok(res.ok, res.error);
    assert.equal(res.result.provider, 'searxng');
    assert.equal(res.result.results[0].title, 'Result A');
    await env.cleanup();
  });

  test('web_search falls back to the next provider when SearXNG fails', async () => {
    const env = await makeEnv();
    withSearch(env, { providers: ['searxng', 'wikipedia'], searxngUrls: [base], wikipediaEndpoint: base, timeoutMs: 3000 });
    const res = await env.run('web_search', { query: 'broken' });
    assert.ok(res.ok, res.error);
    assert.equal(res.result.provider, 'wikipedia');
    assert.equal(res.result.results[0].snippet, 'the flag');
    await env.cleanup();
  });

  test('web_search reports a helpful error when everything fails', async () => {
    const env = await makeEnv();
    withSearch(env, { providers: ['searxng'], searxngUrls: [base], timeoutMs: 3000 });
    const res = await env.run('web_search', { query: 'broken' });
    assert.equal(res.ok, false);
    assert.match(res.error, /All search providers failed/);
    await env.cleanup();
  });

  test('web_fetch reads html, paginates, and rejects bad input', async () => {
    const env = await makeEnv();
    withSearch(env, { allowPrivateFetch: true }); // the test server lives on 127.0.0.1
    const page = await env.run('web_fetch', { url: `${base}/page` });
    assert.ok(page.ok, page.error);
    assert.equal(page.result.title, 'نشيد & اختبار');
    assert.match(page.result.content, /السطر الثاني/);

    const long = await env.run('web_fetch', { url: `${base}/long`, max_chars: 1000 });
    assert.equal(long.result.has_more, true);
    assert.equal(long.result.next_start, 1000);
    const next = await env.run('web_fetch', { url: `${base}/long`, start: 1000, max_chars: 5000 });
    assert.equal(next.result.has_more, false);

    assert.equal((await env.run('web_fetch', { url: `${base}/missing` })).ok, false);
    assert.match((await env.run('web_fetch', { url: 'file:///etc/passwd' })).error, /http/);
    await env.cleanup();
  });
});

describe('todo, plan mode, text tool calls', () => {
  test('todo_write stores a validated checklist', async () => {
    const env = await makeEnv();
    env.ctx.state = { todos: [] };
    const ok = await env.run('todo_write', { todos: [{ content: 'a', status: 'in_progress' }, { content: 'b' }] });
    assert.ok(ok.ok);
    assert.equal(env.ctx.state.todos[1].status, 'pending');
    assert.equal((await env.run('todo_write', { todos: [{ content: 'a', status: 'weird' }] })).ok, false);
    await env.cleanup();
  });

  test('plan mode blocks writes but allows reads and the web', async () => {
    const env = await makeEnv();
    env.ctx.mode = 'plan';
    const denied = await env.run('create_file', { path: 'x.txt', content: 'hi' });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /PLAN mode/);
    assert.equal((await env.run('run_command', { command: 'echo hi' })).ok, false);
    assert.ok((await env.run('list_files', {})).ok);
    const names = env.registry.definitions({ readOnly: true }).map((d) => d.function.name);
    assert.ok(names.includes('web_search') && names.includes('read_file'));
    assert.ok(!names.includes('create_file') && !names.includes('run_command'));
    await env.cleanup();
  });

  test('extractTextToolCalls recognises JSON tool calls printed as text', async () => {
    const env = await makeEnv();
    const text = 'سأبحث الآن:\n```json\n{"tool":"web_search","args":{"query":"نشيد العلم"}}\n```\nثم أقرأ\n{"tool":"nope","args":{}}\n{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}';
    const { calls, text: rest } = extractTextToolCalls(text, env.registry);
    assert.deepEqual(calls.map((c) => c.name), ['web_search', 'read_file']);
    assert.deepEqual(calls[1].arguments, { path: 'a.txt' });
    assert.match(rest, /سأبحث الآن/);
    assert.doesNotMatch(rest, /web_search/);
    assert.match(rest, /"tool":"nope"/); // unknown tools are left alone
    await env.cleanup();
  });

  test('agent loop executes text tool calls and keeps history valid', async () => {
    const env = await makeEnv();
    await import('node:fs/promises').then((fs) => fs.writeFile(`${env.dir}/a.txt`, 'hello'));
    const provider = new FakeProvider([
      textReply('{"tool":"read_file","args":{"path":"a.txt"}}'),
      textReply('The file says hello.'),
    ]);
    const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'read a.txt' }];
    const events = [];
    const out = await runAgentLoop({ provider, model: 'm', messages, registry: env.registry, ctx: env.ctx, emit: (e) => events.push(e.type) });
    assert.equal(out.stopReason, 'done');
    assert.equal(out.content, 'The file says hello.');
    assert.ok(events.includes('text_tool_calls'));
    const assistant = messages.find((m) => m.tool_calls);
    const tool = messages.find((m) => m.role === 'tool');
    assert.equal(tool.tool_call_id, assistant.tool_calls[0].id);
    assert.match(tool.content, /hello/);
    await env.cleanup();
  });
});

describe('system prompt', () => {
  test('contains the decision guide, mode and project notes', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const dir = await fs.mkdtemp(`${os.tmpdir()}/pa-prompt-`);
    await fs.writeFile(`${dir}/AGENTS.md`, 'Use tabs.');
    const p = buildSystemPrompt({ workspace: dir, mode: 'plan' });
    assert.match(p, /web_search/);
    assert.match(p, /PLAN \(read-only\)/);
    assert.match(p, /Use tabs\./);
    assert.match(p, /NEVER ask permission in text/);
    assert.match(buildSystemPrompt({ workspace: dir }), /Mode: BUILD/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
