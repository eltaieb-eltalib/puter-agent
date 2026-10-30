import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULTS } from '../config/load.js';
import { Permissions } from '../security/permissions.js';
import { makeEnv } from './helpers.js';

describe('Permissions: once / always', () => {
  test('"always" is remembered per action, "once" is not', async () => {
    const asked = [];
    const answers = ['once', 'always', 'no'];
    const p = new Permissions({ approvals: { runCommand: true, deleteFile: true }, prompt: async (d, a) => (asked.push(a), answers.shift()) });
    assert.equal(await p.confirm('runCommand', 'x'), true); // once
    assert.equal(await p.confirm('runCommand', 'x'), true); // asks again -> always
    assert.equal(await p.confirm('runCommand', 'x'), true); // remembered: no prompt
    assert.deepEqual(asked, ['runCommand', 'runCommand']);
    assert.equal(await p.confirm('deleteFile', 'y'), false); // other actions still ask -> 'no'
    p.revokeAll();
    assert.equal(p.isGranted('runCommand'), false);
  });

  test('legacy boolean answers still work and outside-workspace can be "always"', async () => {
    const p = new Permissions({ approvals: { runCommand: true }, prompt: async () => true });
    assert.equal(await p.confirm('runCommand', 'x'), true);
    const q = new Permissions({ prompt: async () => 'always' });
    assert.equal(await q.confirmOutside('z'), true);
    q.setPrompt(async () => assert.fail('should not ask again'));
    assert.equal(await q.confirmOutside('z'), true);
  });
});

describe('command timeouts', () => {
  test('a silent command is cancelled by the idle watchdog and partial output is returned', async () => {
    const env = await makeEnv();
    const script = `console.log('started'); setTimeout(() => {}, 20000);`;
    const res = await env.run('run_command', {
      command: `"${process.execPath}" -e "${script}"`,
      timeout_ms: 15000,
      idle_timeout_ms: 700,
    });
    assert.ok(res.ok);
    assert.equal(res.result.timed_out, true);
    assert.equal(res.result.timeout_reason, 'idle');
    assert.match(res.result.stdout, /started/);
    assert.match(res.result.note, /Do not retry it unchanged/);
    await env.cleanup();
  });

  test('a chatty command is not killed by the idle watchdog', async () => {
    const env = await makeEnv();
    const script = `let i=0;const t=setInterval(()=>{console.log(i++);if(i>5){clearInterval(t)}},150)`;
    const res = await env.run('run_command', { command: `"${process.execPath}" -e "${script}"`, timeout_ms: 15000, idle_timeout_ms: 600 });
    assert.equal(res.result.timed_out, false);
    assert.equal(res.result.exit_code, 0);
    await env.cleanup();
  });
});
