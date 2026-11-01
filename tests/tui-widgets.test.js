import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';
import { createInput, stringWidth, stripAnsi } from '../terminal/input.js';
import { helpLines, menuPage, contextSections } from '../terminal/pages.js';
import { ask, pick, yesNo } from '../terminal/ui-kit.js';
import { confirmWidget, pagerWidget, selectWidget, textWidget } from '../terminal/widgets.js';
import { envKeyFor } from '../providers/provider-manager.js';
import { saveEnvValue } from '../utils/env.js';

function fakeTty(cols = 80, rows = 30) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = rows;
  let buf = '';
  stdout.on('data', (d) => (buf += d));
  const tick = () => new Promise((r) => setTimeout(r, 15));
  return { stdin, stdout, text: () => stripAnsi(buf), raw: () => buf, tick, type: async (s) => { stdin.write(s); await tick(); } };
}

const items = ['gpt-5', 'gemini-3.8-flash', 'gemini-3.8-pro', 'claude-sonnet'].map((id) => ({ value: id, label: id, description: 'provider' }));

describe('select widget', () => {
  test('type to filter, Enter picks, Esc cancels, never wider than the terminal', async () => {
    const t = fakeTty(60);
    const input = createInput(t);
    const p = input.widget(selectWidget({ title: 'Model', items, filter: true }));
    await t.tick();
    for (const l of t.text().split('\n')) assert.ok(stringWidth(l) <= 60, `too wide: ${l}`);
    await t.type('gem');
    await t.type('\x1b[B'); // down -> second match
    await t.type('\r');
    assert.equal(await p, 'gemini-3.8-pro');

    const t2 = fakeTty();
    const p2 = createInput(t2).widget(selectWidget({ title: 'Model', items }));
    await t2.tick();
    await t2.type('\x1b'); // Esc
    assert.equal(await p2, null);
  });

  test('allowCustom returns what was typed when nothing matches', async () => {
    const t = fakeTty();
    const p = createInput(t).widget(selectWidget({ title: 'Model', items, allowCustom: true }));
    await t.tick();
    await t.type('my-own-model');
    await t.type('\r');
    assert.deepEqual(await p, { custom: 'my-own-model' });
  });

  test('long lists scroll inside a bounded window', async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ value: i, label: `item-${i}` }));
    const t = fakeTty(80, 24);
    const p = createInput(t).widget(selectWidget({ title: 'Many', items: many }));
    await t.tick();
    const shown = t.text().split('\n').filter((l) => /item-\d+/.test(l)).length;
    assert.ok(shown <= 14, `window too tall: ${shown}`);
    await t.type('\x1b[F'); // End
    await t.type('\r');
    assert.equal(await p, 79);
  });
});

describe('text widget', () => {
  test('masked input never shows the secret; validation blocks Enter', async () => {
    const t = fakeTty();
    const p = createInput(t).widget(textWidget({ title: 'API key', mask: true, validate: (v) => (v.length < 8 ? 'too short' : null) }));
    await t.tick();
    await t.type('abc');
    await t.type('\r');
    assert.match(t.text(), /too short/);
    await t.type('defgh123');
    assert.doesNotMatch(t.text(), /abcdefgh123/);
    await t.type('\r');
    assert.equal(await p, 'abcdefgh123');
  });

  test('editing keys work and Esc cancels', async () => {
    const t = fakeTty();
    const p = createInput(t).widget(textWidget({ title: 'Path', initial: 'ab' }));
    await t.tick();
    await t.type('\x7f'); // backspace
    await t.type('xyz');
    await t.type('\r');
    assert.equal(await p, 'axyz');
    const t2 = fakeTty();
    const p2 = createInput(t2).widget(textWidget({ title: 'Path' }));
    await t2.tick();
    await t2.type('\x1b');
    assert.equal(await p2, null);
  });
});

describe('pager and confirm', () => {
  test('pager scrolls and closes with q', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line-${i}`);
    const t = fakeTty(80, 20);
    const p = createInput(t).widget(pagerWidget({ title: 'Doc', lines }));
    await t.tick();
    assert.match(t.text(), /line-0\b/);
    await t.type('G');
    assert.match(t.text(), /line-59\b/);
    await t.type('q');
    assert.equal(await p, true);
  });

  test('a dangerous confirm defaults to No; y says yes', async () => {
    const t = fakeTty();
    const p = createInput(t).widget(confirmWidget({ title: 'Full access', lines: ['sure?'], danger: true }));
    await t.tick();
    await t.type('\r');
    assert.equal(await p, false);
    const t2 = fakeTty();
    const p2 = createInput(t2).widget(confirmWidget({ title: 'Full access', danger: true }));
    await t2.tick();
    await t2.type('y');
    assert.equal(await p2, true);
  });
});

describe('ui-kit fallbacks and pages', () => {
  const plainUi = (answers) => ({ rl: { question: async () => answers.shift() ?? '' } });

  test('without a TTY the helpers fall back to numbers / typed answers', async () => {
    const list = [{ value: 'low', label: 'low' }, { value: 'high', label: 'high' }];
    assert.equal(await pick(plainUi(['2']), { title: 'x', items: list }), 'high');
    assert.equal(await pick(plainUi(['low']), { title: 'x', items: list }), 'low');
    assert.equal(await pick(plainUi(['']), { title: 'x', items: list }), null);
    assert.equal(await ask(plainUi(['hello']), { title: 'x' }), 'hello');
    assert.equal(await yesNo(plainUi(['yes']), { title: 'x' }), true);
    assert.equal(await yesNo(plainUi(['no']), { title: 'x' }), false);
  });

  test('Ctrl+P on the empty prompt opens the menu', async () => {
    const t = fakeTty();
    const input = createInput(t);
    const p = input.prompt({ state: () => ({ accent: (x) => x, info: '', footerLeft: '', footerRight: [] }), commands: [{ name: 'menu', usage: '/menu', description: 'x' }], margin: 2, maxWidth: 80 });
    await t.tick();
    await t.type('\x10');
    assert.equal(await p, '/menu');
  });

  test('menu lists groups with current values and runs the chosen command', async () => {
    let seenDef;
    let ran = null;
    const ui = {
      provider: { name: 'gemini', setThinkingLevel() {} },
      thinkingLabel: () => ' (thinking: low)',
      agent: { model: 'gemini-3.8-flash', mode: 'build', permissions: { accessLevel: 'ask', granted: new Set(['runCommand']) }, registry: { list: () => [1, 2, 3], mcpStatus: [{ ok: true }] }, state: { todos: [] }, guard: { root: '/work' } },
      input: { isTTY: true, widget: async (def) => { seenDef = def; return '/access'; } },
    };
    await menuPage(ui, { access: { run: async (_ui, arg) => { ran = arg; } } });
    const first = stripAnsi(seenDef.render({ cols: 100, rows: 40 }).join('\n'));
    for (const word of ['Session', 'Model & provider', 'gemini-3.8-flash', 'thinking: low', 'BUILD']) assert.ok(first.includes(word), `menu is missing "${word}"`);
    seenDef.onKey({ name: 'end' }, {}); // the list scrolls: look at the end of it
    const last = stripAnsi(seenDef.render({ cols: 100, rows: 40 }).join('\n'));
    for (const word of ['3 available', 'Quit', '1 connected']) assert.ok(last.includes(word), `menu end is missing "${word}"`);
    assert.equal(ran, '');
  });

  test('help groups commands and lists shortcuts; context sections have the numbers', () => {
    const cmds = { menu: { usage: '/menu', description: 'Open menu' }, model: { usage: '/model', description: 'Pick model' }, odd: { usage: '/odd', description: 'Other thing' } };
    const out = stripAnsi(helpLines(cmds, os.tmpdir()).join('\n'));
    for (const word of ['Interface', 'Model & provider', 'Other', '/odd', 'Shortcuts', 'Ctrl+P']) assert.ok(out.includes(word), word);
    const sec = contextSections({ percent: 42, chars: 5000, approxTokens: 1250, limit: 120000, messages: 7, tools: 30, byRole: { system: 1, user: 2, assistant: 3, tool: 4 }, session: { tasks: 2, totalTokens: 900, cachedTokens: 100, modelCalls: 3, toolCalls: 4 } });
    assert.equal(sec.length, 3);
    assert.match(stripAnsi(JSON.stringify(sec)), /42%/);
  });
});

describe('API key storage', () => {
  test('envKeyFor and saveEnvValue (create, replace, append)', async () => {
    assert.equal(envKeyFor('deepseek'), 'DEEPSEEK_API_KEY');
    assert.equal(envKeyFor('gemini'), 'GEMINI_API_KEY');
    assert.equal(envKeyFor('puter'), null);
    assert.equal(envKeyFor('ollama'), null);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'env-'));
    const file = path.join(dir, '.env');
    delete process.env.TEST_KEY_X;
    saveEnvValue(file, 'TEST_KEY_X', 'one');
    assert.equal(await fs.readFile(file, 'utf8'), 'TEST_KEY_X=one\n');
    await fs.appendFile(file, 'OTHER=keep\n');
    saveEnvValue(file, 'TEST_KEY_X', 'two');
    assert.equal(await fs.readFile(file, 'utf8'), 'TEST_KEY_X=two\nOTHER=keep\n');
    assert.equal(process.env.TEST_KEY_X, 'two');
    assert.throws(() => saveEnvValue(file, 'bad key', 'x'), /Invalid/);
    assert.throws(() => saveEnvValue(file, 'TEST_KEY_X', 'a\nb'), /single line/);
    delete process.env.TEST_KEY_X;
    await fs.rm(dir, { recursive: true, force: true });
  });
});
