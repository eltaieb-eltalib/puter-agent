import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AgentRouterProvider,
  AGENTROUTER_BASE_URL,
  AGENTROUTER_ENDPOINT,
  AGENTROUTER_FULL_ENDPOINT,
  AGENTROUTER_MODELS,
  AGENTROUTER_DEFAULT_MODEL,
} from '../providers/agentrouter.js';

describe('AgentRouter Responses API provider', () => {
  test('uses the exact configured endpoint, timeout, models and default', () => {
    assert.equal(AGENTROUTER_BASE_URL, 'https://agentrouter.org/v1');
    assert.equal(AGENTROUTER_ENDPOINT, '/responses');
    assert.equal(AGENTROUTER_FULL_ENDPOINT, 'https://agentrouter.org/v1/responses');
    assert.deepEqual(AGENTROUTER_MODELS, ['gpt-5.6-sol', 'gpt-6-astra', 'gpt-6.1-sol']);
    assert.equal(AGENTROUTER_DEFAULT_MODEL, 'gpt-6-astra');
    assert.throws(() => new AgentRouterProvider({ apiKey: '' }), /AGENTROUTER_API_KEY/);
    assert.equal(new AgentRouterProvider({ apiKey: 'test-agentrouter-key' }).timeoutMs, 60000);
  });

  test('sends Responses API payload with the required Roo Code identification headers', async () => {
    const provider = new AgentRouterProvider({ apiKey: 'test-agentrouter-key' });
    const originalFetch = globalThis.fetch;
    let captured;
    globalThis.fetch = async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        status: 'completed',
        output_text: 'AgentRouter connected',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'AgentRouter connected' }] }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const result = await provider.chat({
        model: 'gpt-6-astra',
        messages: [{ role: 'user', content: 'Hello' }],
      });
      assert.equal(result.content, 'AgentRouter connected');
      assert.equal(captured.url, 'https://agentrouter.org/v1/responses');
      assert.equal(captured.options.method, 'POST');
      assert.equal(captured.options.headers.Authorization, 'Bearer test-agentrouter-key');
      assert.equal(captured.options.headers['HTTP-Referer'], 'https://github.com/RooVetGit/Roo-Cline');
      assert.equal(captured.options.headers['X-Title'], 'Roo Code');
      assert.equal(captured.options.headers['User-Agent'], 'RooCode/3.53.0');
      assert.equal(captured.body.model, 'gpt-6-astra');
      assert.equal(captured.body.input[0].role, 'user');
      assert.equal(captured.body.store, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returns the fixed AgentRouter model list without a network call', async () => {
    const provider = new AgentRouterProvider({ apiKey: 'test-agentrouter-key' });
    assert.deepEqual((await provider.listModels()).map((item) => item.id), AGENTROUTER_MODELS);
  });
});
