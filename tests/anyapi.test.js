import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AnyAPIProvider, ANYAPI_BASE_URL, ANYAPI_DEFAULT_MODEL } from '../providers/anyapi.js';

describe('AnyAPI provider', () => {
  test('requires ANYAPI_API_KEY and uses the OpenAI-compatible v1 endpoint', () => {
    assert.throws(() => new AnyAPIProvider({ apiKey: '' }), /ANYAPI_API_KEY/);
    assert.equal(ANYAPI_BASE_URL, 'https://api.anyapi.ai/v1');
    assert.equal(ANYAPI_DEFAULT_MODEL, 'google/gemini-2.5-flash-lite');
    const provider = new AnyAPIProvider({ apiKey: 'test-anyapi-key-123456' });
    assert.equal(provider.name, 'anyapi');
    assert.equal(provider.baseURL, 'https://api.anyapi.ai/v1');
  });

  test('allows a custom compatible gateway URL', () => {
    const provider = new AnyAPIProvider({
      apiKey: 'test-anyapi-key-123456',
      baseURL: 'https://example.test/v1/',
    });
    assert.equal(provider.baseURL, 'https://example.test/v1');
  });
});
