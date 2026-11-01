import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { PROVIDER_NAMES, createProvider, resolveProvider } from '../providers/provider-manager.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function rootWithConnect(connect) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-root-'));
  await fs.mkdir(path.join(dir, 'config'));
  if (connect) await fs.writeFile(path.join(dir, 'config', 'connect.json'), JSON.stringify(connect));
  return dir;
}

describe('provider manager', () => {
  // This file once had a duplicate import and crashed on startup while every other test passed.
  test('the module loads and knows both providers', () => {
    assert.deepEqual(PROVIDER_NAMES.sort(), ['agentrouter','anthropic','anyapi','cerebras','deepseek','fireworks','gemini','groq','lmstudio','mistral','moonshot','nvidia','ollama','openai','openrouter','perplexity','puter','qwen','together','xai','zai'].sort());
  });

  test('the real entry point starts (--help exits 0)', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'index.js'), '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Usage: node index\.js/);
  });

  test('unknown provider is rejected, API providers need their keys', () => {
    assert.throws(() => createProvider('nope'), /Unknown provider/);
    assert.throws(() => createProvider('gemini', { apiKey: '' }), /GEMINI_API_KEY/);
    assert.throws(() => createProvider('openai', { apiKey: '' }), /OPENAI_API_KEY/);
    assert.throws(() => createProvider('agentrouter', { apiKey: '' }), /AGENTROUTER_API_KEY/);
    assert.throws(() => createProvider('deepseek', { apiKey: '' }), /DEEPSEEK_API_KEY/);
    assert.throws(() => createProvider('anthropic', { apiKey: '' }), /ANTHROPIC_API_KEY/);
    assert.equal(createProvider('ollama').name, 'ollama');
    assert.equal(createProvider('anyapi', { apiKey:'test-key-12345678' }).defaultModel, 'google/gemini-2.5-flash-lite');
  });

  test('resolveProvider: env > connect.json > puter, and picks the right model', async () => {
    const root = await rootWithConnect({ provider: 'gemini', models: { gemini: { model: 'gemini-2.5-pro' }, puter: { model: 'x' } } });
    const empty = await rootWithConnect(null);

    let r = resolveProvider({ rootDir: root, env: {}, settingsModel: 'gpt-5.4-nano' });
    assert.deepEqual([r.name, r.model], ['gemini', 'gemini-2.5-pro']);

    r = resolveProvider({ rootDir: root, env: { AGENT_PROVIDER: 'puter' }, settingsModel: 'gpt-5.4-nano' });
    assert.deepEqual([r.name, r.model], ['puter', 'x']);

    r = resolveProvider({ rootDir: root, env: {}, cliModel: 'gemini-2.0-flash', settingsModel: 'gpt' });
    assert.equal(r.model, 'gemini-2.0-flash');

    r = resolveProvider({ rootDir: empty, env: {}, settingsModel: 'gpt-5.4-nano' });
    assert.deepEqual([r.name, r.model], ['puter', 'gpt-5.4-nano']);

    r = resolveProvider({ rootDir: empty, env: { AGENT_PROVIDER: 'gemini' }, settingsModel: 'gpt-5.4-nano' });
    assert.equal(r.model, 'gemini-3.8-flash', 'a puter model id must never be sent to Gemini');

    r = resolveProvider({ rootDir: empty, env: { AGENT_PROVIDER: 'openai' }, settingsModel: 'some-other-model' });
    assert.deepEqual([r.name, r.model], ['openai', 'gpt-6.1-sol']);

    r = resolveProvider({ rootDir: empty, env: { AGENT_PROVIDER: 'agentrouter' }, settingsModel: 'm' });
    assert.deepEqual([r.name, r.model], ['agentrouter', 'gpt-6-astra']);

    r = resolveProvider({ rootDir: empty, env: { AGENT_PROVIDER: 'deepseek' }, settingsModel: 'm' });
    assert.deepEqual([r.name, r.model], ['deepseek', 'deepseek-chat']);

    r = resolveProvider({ rootDir: empty, env: { AGENT_PROVIDER: 'bogus' }, settingsModel: 'm' });
    assert.deepEqual([r.name, r.unknown], ['puter', 'bogus']);
  });
});
