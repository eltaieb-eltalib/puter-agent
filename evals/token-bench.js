// Token-economy benchmark (offline, no API key): replays one scripted coding session through the
// Agent with a recording provider and reports what would be sent to a real model.
//
//   node evals/token-bench.js
//
// Metrics per session:
//   sent      - characters of messages + tool definitions sent over all model calls (~ chars/4 tokens)
//   reusable  - share of each request that is an exact prefix of the previous request; this is
//               what provider-side prompt caching (OpenAI / Anthropic / Gemini) can bill as cached
//   calls     - model calls (identical script, so equal unless the agent avoided a call)

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.BENCH_ROOT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(path.join(ROOT, p));

const { DEFAULTS } = await imp('config/load.js');
const { PathGuard } = await imp('security/path-guard.js');
const { Permissions } = await imp('security/permissions.js');
const { createDefaultRegistry } = await imp('tools/index.js');
const { Agent } = await imp('core/agent.js');

const call = (id, name, args) => ({ id, name, arguments: args, rawArguments: JSON.stringify(args) });
const toolReply = (...calls) => ({
  content: '',
  toolCalls: calls,
  message: { role: 'assistant', content: '', tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArguments } })) },
});
const text = (t) => ({ content: t, toolCalls: [], message: { role: 'assistant', content: t } });

const script = [
  // request 1: understand + change a big file
  [
    toolReply(call('a1', 'list_files', { path: '.' })),
    toolReply(call('a2', 'read_file', { path: 'src/big.js' })),
    toolReply(call('a3', 'search_files', { query: 'function handler_1', path: 'src' })),
    toolReply(call('a4', 'read_file', { path: 'src/big.js' })), // repeated read, file unchanged
    toolReply(call('a5', 'read_file', { path: 'src/util.js' }), call('a6', 'read_file', { path: 'src/config.js' })),
    toolReply(call('a7', 'edit_file', { path: 'src/util.js', old_string: 'return 1;', new_string: 'return 2;' })),
    toolReply(call('a8', 'run_command', { command: 'node --check src/util.js', timeout_ms: 10000 })),
    toolReply(call('a9', 'list_files', { path: '.' })), // repeated listing
    text('Changed util() to return 2 and verified the syntax.'),
  ],
  // request 2: follow-up question
  [
    toolReply(call('b1', 'search_files', { query: 'config', path: 'src' })),
    toolReply(call('b2', 'read_file', { path: 'src/config.js' })),
    text('config.js exports the defaults used by util.js.'),
  ],
  // request 3: another change
  [
    toolReply(call('c1', 'read_file', { path: 'src/util.js' })),
    toolReply(call('c2', 'edit_file', { path: 'src/util.js', old_string: 'return 2;', new_string: 'return 3;' })),
    toolReply(call('c3', 'run_command', { command: 'node --check src/util.js', timeout_ms: 10000 })),
    text('Done: util() now returns 3.'),
  ],
];

async function makeWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'token-bench-'));
  await fs.mkdir(path.join(dir, 'src'));
  const big = Array.from({ length: 1500 }, (_, i) => (i % 25 === 0 ? `export function handler_${i}(req, res) {` : i % 25 === 24 ? '}' : `  const value_${i} = compute(${i}, req.params.id, "some string value");`)).join('\n');
  await fs.writeFile(path.join(dir, 'src', 'big.js'), big);
  await fs.writeFile(path.join(dir, 'src', 'util.js'), `import { DEFAULTS } from './config.js';\nexport function util() {\n  return 1;\n}\n${'// filler\n'.repeat(80)}`);
  await fs.writeFile(path.join(dir, 'src', 'config.js'), `export const DEFAULTS = {\n${Array.from({ length: 120 }, (_, i) => `  option${i}: ${i},`).join('\n')}\n};\n`);
  await fs.writeFile(path.join(dir, 'package.json'), '{"name":"bench","type":"module"}');
  return dir;
}

const commonPrefix = (a, b) => {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
};

async function run() {
  const dir = await makeWorkspace();
  const requests = [];
  let current = [];
  const provider = {
    name: 'bench',
    async chat({ messages, tools = [] }) {
      // tools first, like most providers' cache order (tools -> system -> messages)
      requests.push(JSON.stringify(tools) + JSON.stringify(messages));
      const next = current.shift();
      if (!next) throw new Error('script exhausted');
      return next;
    },
  };
  const guard = new PathGuard(dir);
  const permissions = new Permissions({ approvals: DEFAULTS.approvals, prompt: async () => 'once' });
  const settings = { ...DEFAULTS, retry: { retries: 0, baseDelayMs: 1, maxDelayMs: 1 }, verify: { enabled: false } };
  const agent = new Agent({ provider, registry: createDefaultRegistry(), settings, guard, permissions, model: 'bench' });
  const prompts = ['Look at src/big.js and change util() in src/util.js to return 2, then run a syntax check', 'what does src/config.js do?', 'now make util return 3 and check it'];
  for (let i = 0; i < script.length; i++) {
    current = [...script[i]];
    await agent.run(prompts[i]);
  }
  await fs.rm(dir, { recursive: true, force: true });
  const sent = requests.reduce((n, r) => n + r.length, 0);
  let reusable = 0;
  for (let i = 1; i < requests.length; i++) reusable += commonPrefix(requests[i - 1], requests[i]);
  return { calls: requests.length, sent, approxTokens: Math.round(sent / 4), reusablePct: Math.round((reusable / sent) * 100), uncachedApproxTokens: Math.round((sent - reusable) / 4) };
}

const r = await run();
console.log(JSON.stringify(r));
