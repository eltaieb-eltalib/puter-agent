import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';
import { createInput, stringWidth, stripAnsi, wrapCells } from '../terminal/input.js';

function fakeTty(cols) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = 30;
  let buf = '';
  stdout.on('data', (d) => (buf += d));
  return { stdin, stdout, text: () => stripAnsi(buf) };
}

describe('TUI layout', () => {
  test('wrapCells never exceeds the width', () => {
    for (const line of wrapCells('npm test -- --reporter=verbose --coverage some/very/long/path/to/file.test.js', 20)) {
      assert.ok(stringWidth(line) <= 20, line);
    }
  });

  test('permission dialog rows fit a narrow terminal (so redraws stay aligned)', async () => {
    const t = fakeTty(50);
    const input = createInput(t);
    const p = input.choose('Run a command or script', [
      { key: 'o', label: 'Allow once (only this)', value: 'once' },
      { key: 'a', label: 'Always: all commands / scripts (this session)', value: 'always' },
      { key: 'n', label: 'Reject (agent tries another way)', value: false },
    ], { lines: ['BUILD mode · access: ask · tool: run_command (step 3)', 'Run command in .:', '    npm test --coverage some/very/long/path/to/file.test.js'] });
    await new Promise((r) => setTimeout(r, 20));
    for (const l of t.text().split('\n')) assert.ok(stringWidth(l) <= 50, `too wide (${stringWidth(l)}): ${l}`);
    assert.match(t.text(), /BUILD mode/);
    t.stdin.write('a');
    assert.equal(await p, 'always');
  });

  test('footer key hints fall back to shorter tiers instead of overflowing', async () => {
    for (const cols of [110, 60, 40]) {
      const t = fakeTty(cols);
      const input = createInput(t);
      input.prompt({
        state: () => ({ accent: (x) => x, info: 'Build', footerLeft: (m) => 'x'.repeat(Math.min(m, 30)), footerRight: ['shift+tab mode   ctrl+p palette   / commands   ↑↓ history', 'shift+tab mode   / commands', '/ commands'] }),
        commands: [],
        margin: 2,
        maxWidth: 100,
      });
      await new Promise((r) => setTimeout(r, 20));
      const footer = t.text().split('\n').filter((l) => /commands/.test(l)).at(-1);
      assert.ok(footer && stringWidth(footer.replace('\r', '')) <= cols, `cols=${cols}: ${footer}`);
      t.stdin.write('\x03');
    }
  });
});
