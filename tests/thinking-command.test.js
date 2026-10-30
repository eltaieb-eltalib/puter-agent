import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { GeminiProvider } from '../providers/gemini.js';
import { resolveProvider } from '../providers/provider-manager.js';
import { COMMANDS } from '../terminal/commands.js';
import { TerminalUI } from '../terminal/interface.js';

let dir;
const saved = {};
const connectFile = () => path.join(dir, 'config', 'connect.json');
const readConnect = async () => JSON.parse(await fs.readFile(connectFile(), 'utf8'));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-think-'));
  await fs.mkdir(path.join(dir, 'config'));
  for (const k of ['AGENT_CONFIG_ROOT', 'GEMINI_THINKING_LEVEL', 'GEMINI_API_KEY', 'GEMINI_BASE_URL']) saved[k] = process.env[k];
  process.env.AGENT_CONFIG_ROOT = dir;
  delete process.env.GEMINI_THINKING_LEVEL;
  process.env.GEMINI_API_KEY = 'test-key-1234567890';
  process.env.GEMINI_BASE_URL = 'http://127.0.0.1:1'; // nothing listens: model list falls back to the curated one
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  await fs.rm(dir, { recursive: true, force: true });
});

const makeUi = (provider, answers = []) => ({
  provider,
  settings: { requestTimeoutMs: 5000 },
  agent: { model: 'gemini-3.8-flash', provider, setModel() {} },
  models: [],
  rl: { question: async () => answers.shift() ?? '' },
  getModels: async () => [],
});

describe('/thinking', () => {
  test('sets the level on the provider and saves it next to the model choice', async () => {
    const p = new GeminiProvider({ apiKey: 'k-1234567890' });
    assert.equal(p.thinkingLevel, 'low');
    await COMMANDS.thinking.run(makeUi(p), 'high');
    assert.equal(p.thinkingLevel, 'high');
    assert.equal((await readConnect()).models.gemini.thinking, 'high');
  });

  test('without an argument it shows a menu (number or name) and "off" clears the level', async () => {
    const p = new GeminiProvider({ apiKey: 'k-1234567890' });
    await COMMANDS.thinking.run(makeUi(p, ['2']), '');
    assert.equal(p.thinkingLevel, 'medium');
    await COMMANDS.thinking.run(makeUi(p, ['off']), '');
    assert.equal(p.thinkingLevel, null);
    assert.equal((await readConnect()).models.gemini.thinking, 'off');
    await COMMANDS.thinking.run(makeUi(p, ['']), ''); // Enter = cancel
    assert.equal(p.thinkingLevel, null);
  });

  test('an unknown level changes nothing; a provider without thinking explains itself', async () => {
    const p = new GeminiProvider({ apiKey: 'k-1234567890' });
    await COMMANDS.thinking.run(makeUi(p), 'turbo');
    assert.equal(p.thinkingLevel, 'low');
    await assert.doesNotReject(COMMANDS.thinking.run(makeUi({ name: 'puter' }), 'high'));
    await assert.rejects(fs.access(connectFile()), 'nothing is saved for a provider that has no thinking');
  });

  test('the saved level is used at startup and when switching to gemini with /connect', async () => {
    await fs.writeFile(connectFile(), JSON.stringify({ provider: 'gemini', models: { gemini: { model: 'gemini-3.8-flash', thinking: 'medium' } } }));
    assert.equal(resolveProvider({ rootDir: dir, env: {}, settingsModel: 'x' }).thinking, 'medium');

    const ui = makeUi({ name: 'puter', listModels: async () => [] });
    await COMMANDS.connect.run(ui, 'gemini');
    assert.equal(ui.provider.name, 'gemini');
    assert.equal(ui.provider.thinkingLevel, 'medium');
    assert.equal((await readConnect()).models.gemini.thinking, 'medium', 'switching models must not erase it');
  });

  test('the prompt line shows the level for Gemini only', () => {
    const label = (provider) => TerminalUI.prototype.thinkingLabel.call({ provider });
    assert.equal(label(new GeminiProvider({ apiKey: 'k-1234567890', thinkingLevel: 'high' })), ' (thinking: high)');
    assert.equal(label(new GeminiProvider({ apiKey: 'k-1234567890', thinkingLevel: 'off' })), ' (thinking: off)');
    assert.equal(label({ name: 'puter' }), '');
  });
});
