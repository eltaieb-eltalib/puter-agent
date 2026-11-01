import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { Permissions } from '../security/permissions.js';
import { makeEnv } from './helpers.js';

describe('full access level', () => {
  test('"allow" reaches outside folders without asking', async () => {
    const env = await makeEnv({ outsideWorkspace: 'allow', approve: false });
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'puter-agent-outside-'));
    await fs.writeFile(path.join(other, 'a.txt'), 'hello');
    const res = await env.run('read_file', { path: path.join(other, 'a.txt') });
    assert.ok(res.ok, res.error);
    assert.match(res.result.content, /hello/);
    assert.equal(env.prompts.length, 0);
    await fs.rm(other, { recursive: true, force: true });
    await env.cleanup();
  });

  test('setAccess switches profiles and reports the level', () => {
    const p = new Permissions({ approvals: { runCommand: true, openPath: true, deleteFile: true }, outsideWorkspace: 'ask' });
    assert.equal(p.accessLevel, 'ask');
    p.setAccess('full');
    assert.equal(p.accessLevel, 'full');
    assert.equal(p.needsApproval('runCommand'), false);
    assert.equal(p.needsApproval('deleteFile'), true); // destructive actions keep asking
    p.setAccess('workspace');
    assert.equal(p.accessLevel, 'workspace');
    assert.throws(() => p.setAccess('nope'), /Unknown access level/);
  });

  test('run_command works in an absolute cwd outside the workspace and blocked patterns still apply', async () => {
    const env = await makeEnv({ outsideWorkspace: 'allow' });
    env.permissions.setAccess('full');
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'puter-agent-cwd-'));
    const res = await env.run('run_command', { command: `"${process.execPath}" -e "console.log(process.cwd())"`, cwd: other });
    assert.ok(res.ok, res.error);
    assert.equal(res.result.exit_code, 0);
    assert.equal(await fs.realpath(res.result.stdout.trim()), await fs.realpath(other));
    const bad = await env.run('run_command', { command: 'shutdown /s /t 0' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /safety policy/);
    await fs.rm(other, { recursive: true, force: true });
    await env.cleanup();
  });

  test('run_node accepts a cwd and list_drives returns roots', async () => {
    const env = await makeEnv({ outsideWorkspace: 'allow' });
    env.permissions.setAccess('full');
    await fs.writeFile(path.join(env.dir, 't.js'), 'console.log(process.cwd())');
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'puter-agent-node-'));
    const res = await env.run('run_node', { file: 't.js', cwd: other });
    assert.ok(res.ok, res.error);
    assert.equal(await fs.realpath(res.result.stdout.trim()), await fs.realpath(other));
    const drives = await env.run('list_drives', {});
    assert.ok(drives.ok && drives.result.drives.length > 0);
    await fs.rm(other, { recursive: true, force: true });
    await env.cleanup();
  });

  test('open_path rejects missing paths and non-http URLs are treated as paths', async () => {
    const env = await makeEnv({ outsideWorkspace: 'allow' });
    env.permissions.setAccess('full');
    const res = await env.run('open_path', { path: 'does-not-exist.pdf' });
    assert.equal(res.ok, false);
    assert.match(res.error, /Not found/);
    await env.cleanup();
  });
});
