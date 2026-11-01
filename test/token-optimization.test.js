import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../tools/registry.js';
import { compressToolHistory, usageTotals } from '../core/agent-loop.js';

test('dynamic tool definitions only expose selected tools and respect read-only mode', () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'read_file', description: 'Read', readOnly: true, execute: async () => ({}) });
  registry.register({ name: 'run_command', description: 'Run', readOnly: false, execute: async () => ({}) });
  assert.deepEqual(registry.definitions({ include: ['read_file'] }).map((x) => x.function.name), ['read_file']);
  assert.deepEqual(registry.definitions({ readOnly: true, include: ['read_file', 'run_command'] }).map((x) => x.function.name), ['read_file']);
});

test('progressive compression preserves recent tool results and tool message structure', () => {
  const messages = Array.from({ length: 6 }, (_, i) => ({ role: 'tool', tool_call_id: `call-${i}`, content: JSON.stringify({ ok: true, result: { summary: `result ${i}`, data: 'x'.repeat(2000) } }) }));
  compressToolHistory(messages, { keep: 2, maxChars: 500 });
  assert.ok(messages[0].content.length < 700);
  assert.match(messages[0].content, /result 0/);
  assert.ok(messages[4].content.length > 2000);
  assert.ok(messages[5].content.length > 2000);
  assert.equal(messages[0].tool_call_id, 'call-0');
});

test('usage normalization handles OpenAI-style and input/output token fields', () => {
  assert.deepEqual(usageTotals({ prompt_tokens: 100, completion_tokens: 25, total_tokens: 125, prompt_tokens_details: { cached_tokens: 40 } }), {
    promptTokens: 100, completionTokens: 25, cachedTokens: 40, totalTokens: 125,
  });
  assert.deepEqual(usageTotals({ input_tokens: 10, output_tokens: 5 }), {
    promptTokens: 10, completionTokens: 5, cachedTokens: 0, totalTokens: 15,
  });
});
