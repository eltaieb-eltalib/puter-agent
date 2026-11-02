import { AgentError, ErrorKind, classifyError, registerSecret } from '../utils/errors.js';

// Anthropic Messages API adapter.
// Prompt caching (official feature): cache_control breakpoints are placed on the system prompt, the
// last tool definition and the newest message, so each step re-reads the long, unchanged prefix from
// Anthropic's cache (billed at a fraction of normal input) instead of paying for it again. Prompts
// below the model's minimum cacheable length are simply not cached by the API; nothing breaks.

const EPHEMERAL = { type: 'ephemeral' };

/** Convert the provider-neutral history into Anthropic messages (+ cache breakpoints). */
export function toAnthropicRequest({ model, messages = [], tools = [], maxTokens = 8192, promptCaching = true }) {
  const systemText = messages.filter((m) => m.role === 'system').map((m) => String(m.content ?? '')).join('\n\n');
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') }] });
      continue;
    }
    if (m.role === 'assistant' && !Array.isArray(m.content) && m.tool_calls?.length) {
      // History written by another provider (or text tool calls): rebuild tool_use blocks.
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: String(m.content) });
      for (const c of m.tool_calls) {
        let input = {};
        try {
          input = JSON.parse(c.function?.arguments ?? '{}');
        } catch {
          /* keep {} */
        }
        blocks.push({ type: 'tool_use', id: c.id, name: c.function?.name, input });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: Array.isArray(m.content) ? m.content : String(m.content ?? '') });
  }

  const apiTools = tools
    .filter((t) => t?.type === 'function')
    .map((t) => ({ name: t.function.name, description: t.function.description ?? '', input_schema: t.function.parameters ?? { type: 'object', properties: {} } }));

  if (promptCaching) {
    if (apiTools.length) apiTools[apiTools.length - 1] = { ...apiTools[apiTools.length - 1], cache_control: EPHEMERAL };
    const last = out[out.length - 1];
    if (last) {
      const blocks = Array.isArray(last.content) ? last.content.map((b) => ({ ...b })) : [{ type: 'text', text: String(last.content) }];
      const i = blocks.length - 1;
      if (i >= 0 && blocks[i].type !== 'thinking') blocks[i] = { ...blocks[i], cache_control: EPHEMERAL };
      out[out.length - 1] = { ...last, content: blocks };
    }
  }

  return {
    model,
    max_tokens: maxTokens,
    ...(systemText ? { system: promptCaching ? [{ type: 'text', text: systemText, cache_control: EPHEMERAL }] : systemText } : {}),
    messages: out,
    ...(apiTools.length ? { tools: apiTools } : {}),
  };
}

/** Anthropic usage -> OpenAI-style usage (cached = tokens read from the prompt cache). */
export function anthropicUsage(u) {
  if (!u) return undefined;
  const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return {
    prompt_tokens: input,
    completion_tokens: u.output_tokens ?? 0,
    total_tokens: input + (u.output_tokens ?? 0),
    prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens ?? 0 },
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
  };
}

export class AnthropicProvider {
  name = 'anthropic';
  constructor({ apiKey = process.env.ANTHROPIC_API_KEY, timeoutMs = 120000, promptCaching = process.env.ANTHROPIC_PROMPT_CACHING !== 'off', fetchImpl = globalThis.fetch } = {}) {
    if (!apiKey) throw new AgentError('Missing ANTHROPIC_API_KEY. Add it to .env.', { kind: ErrorKind.AUTH });
    registerSecret(apiKey);
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.promptCaching = promptCaching;
    this.fetch = fetchImpl;
  }

  async connect() {}

  async listModels() {
    return ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'].map((id) => ({ id, provider: this.name }));
  }

  async chat({ model = 'claude-sonnet-4-5', messages = [], tools = [], signal } = {}) {
    if (signal?.aborted) throw new AgentError('Request cancelled.', { kind: ErrorKind.ABORTED });
    const body = toAnthropicRequest({ model, messages, tools, promptCaching: this.promptCaching });
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const res = await this.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: combined,
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new AgentError(`Anthropic API error: ${payload.error?.message ?? `HTTP ${res.status}`}`, {
          kind: res.status === 401 || res.status === 403 ? ErrorKind.AUTH : res.status === 429 ? ErrorKind.RATE_LIMIT : res.status >= 500 ? ErrorKind.SERVER : ErrorKind.BAD_REQUEST,
        });
      }
      const content = (payload.content ?? []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');
      const toolCalls = (payload.content ?? []).filter((x) => x.type === 'tool_use').map((x) => ({ id: x.id, name: x.name, arguments: x.input ?? {}, rawArguments: JSON.stringify(x.input ?? {}) }));
      // The stored message keeps the native blocks (needed to replay tool_use) plus tool_calls, so the
      // rest of the agent (dedup, compression, other providers) understands the history.
      const message = {
        role: 'assistant',
        content: payload.content ?? [{ type: 'text', text: content }],
        ...(toolCalls.length ? { tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArguments } })) } : {}),
      };
      return { content, toolCalls, message, usage: anthropicUsage(payload.usage) };
    } catch (err) {
      if (signal?.aborted) throw new AgentError('Request cancelled.', { kind: ErrorKind.ABORTED, cause: err });
      if (timeout.aborted) throw new AgentError(`Anthropic request timed out after ${this.timeoutMs} ms.`, { kind: ErrorKind.TIMEOUT, cause: err });
      if (err instanceof AgentError) throw err;
      throw classifyError(err);
    }
  }
}
