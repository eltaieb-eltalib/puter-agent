import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  OpenAIProvider,
  OPENAI_DEFAULT_MODEL,
  normalizeReasoningLevel,
  pickDefaultOpenAIModel,
  normalizeOpenAIResponse,
  toOpenAITools,
  toResponsesInput,
} from '../providers/openai.js';
import { createDefaultRegistry } from '../tools/index.js';

describe('OpenAI Responses API provider', () => {
  test('requires a key and defaults to a current general-purpose reasoning model', () => {
    assert.throws(() => new OpenAIProvider({ apiKey: '' }), /OPENAI_API_KEY/);
    assert.equal(OPENAI_DEFAULT_MODEL, 'gpt-6.1-sol');
    assert.equal(new OpenAIProvider({ apiKey: 'test-key-12345678' }).reasoningLevel, 'medium');
  });

  test('chooses a useful OpenAI default model from the live model list', () => {
    assert.equal(pickDefaultOpenAIModel([{ id: 'gpt-4.1' }, { id: 'gpt-6.1-sol' }]), 'gpt-6.1-sol');
    assert.equal(pickDefaultOpenAIModel([{ id: 'gpt-4.1' }]), 'gpt-4.1');
  });

  test('normalizes the supported reasoning effort values', () => {
    for (const level of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      assert.equal(normalizeReasoningLevel(level), level);
    }
    assert.equal(normalizeReasoningLevel('unsupported'), 'medium');
  });

  test('converts registry tools to the flat Responses API function schema', () => {
    const tools = toOpenAITools(createDefaultRegistry().definitions());
    assert.ok(tools.length >= 10);
    assert.ok(tools.every((tool) => tool.type === 'function' && tool.name && tool.parameters));
    assert.equal(tools.some((tool) => 'function' in tool), false);
  });

  test('replays Responses output items and returns function_call_output items', () => {
    const output = [
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' },
      { type: 'function_call', call_id: 'call_1', name: 'list_files', arguments: '{"path":"."}' },
    ];
    const history = [
      { role: 'system', content: 'Be safe.' },
      { role: 'user', content: 'List files.' },
      { role: 'assistant', content: '', openaiResponseOutput: output },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    ];
    const converted = toResponsesInput(history);
    assert.equal(converted.instructions, 'Be safe.');
    assert.deepEqual(converted.input[1], output[0]);
    assert.deepEqual(converted.input[2], output[1]);
    assert.deepEqual(converted.input[3], {
      type: 'function_call_output',
      call_id: 'call_1',
      output: '{"ok":true}',
    });
  });

  test('normalizes text and multiple function calls without losing output items', () => {
    const response = {
      status: 'completed',
      output_text: 'Done',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] },
        { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a"}' },
        { type: 'function_call', call_id: 'c2', name: 'list_files', arguments: '{"path":"."}' },
      ],
    };
    const result = normalizeOpenAIResponse(response);
    assert.equal(result.content, 'Done');
    assert.deepEqual(result.toolCalls.map((call) => call.id), ['c1', 'c2']);
    assert.equal(result.message.openaiResponseOutput.length, 3);
  });
});
