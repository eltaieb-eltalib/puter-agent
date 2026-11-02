import crypto from 'node:crypto';
import { AgentError, ErrorKind, classifyError, registerSecret } from '../utils/errors.js';

export const OPENAI_DEFAULT_MODEL = 'gpt-6.1-sol';
export const OPENAI_REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const CURATED_MODELS = [
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-6.1-terra',
  'gpt-6-luna',
  'gpt-6-sol',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.2',
];

const NON_CHAT_MODEL = /(?:image|audio|realtime|transcribe|tts|embedding|moderation|whisper|search|computer-use)/i;
const isReasoningModel = (id) => /^(gpt-[56](?:[.-]|$)|o[134](?:-|$))/.test(id ?? '');

export function normalizeReasoningLevel(value) {
  const v = String(value ?? 'medium').trim().toLowerCase();
  return OPENAI_REASONING_LEVELS.includes(v) ? v : 'medium';
}

/** Prefer a useful current general-purpose model instead of the first alphabetically listed model. */
export function pickDefaultOpenAIModel(models = []) {
  const ids = models.map((model) => model.id);
  const preferred = [OPENAI_DEFAULT_MODEL, 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.5'];
  return preferred.find((id) => ids.includes(id)) ?? ids[0] ?? OPENAI_DEFAULT_MODEL;
}

/** Convert this project's Chat Completions-style registry tools to Responses API function tools. */
export function toOpenAITools(tools = []) {
  return tools
    .filter((tool) => tool?.type === 'function' && tool.function?.name)
    .map(({ function: fn }) => ({
      type: 'function',
      name: fn.name,
      description: fn.description ?? '',
      parameters: fn.parameters ?? { type: 'object', properties: {} },
    }));
}

/**
 * Convert the agent's provider-neutral chat history into Responses API input.
 * Full Responses output items are retained and replayed, including opaque reasoning
 * items required when continuing a tool-using reasoning turn.
 */
export function toResponsesInput(messages = []) {
  const input = [];
  const instructions = [];
  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content) instructions.push(String(message.content));
      continue;
    }
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: String(message.content ?? ''),
      });
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message.openaiResponseOutput)) {
      input.push(...message.openaiResponseOutput);
      continue;
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      if (message.content) input.push({ role: 'assistant', content: String(message.content) });
      for (const call of message.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function?.name ?? call.name,
          arguments: call.function?.arguments ?? call.arguments ?? '{}',
        });
      }
      continue;
    }
    if (message.role === 'assistant' || message.role === 'user' || message.role === 'developer') {
      input.push({ role: message.role, content: String(message.content ?? '') });
    }
  }
  return { instructions: instructions.join('\n\n') || undefined, input };
}

export function normalizeOpenAIResponse(response) {
  if (!response || !Array.isArray(response.output)) {
    throw new AgentError('OpenAI returned an empty or invalid Responses API payload.', { kind: ErrorKind.UNKNOWN });
  }
  if (response.status && response.status !== 'completed') {
    const detail = response.error?.message ?? response.incomplete_details?.reason ?? response.status;
    throw new AgentError(`OpenAI response did not complete: ${detail}`, {
      kind: response.status === 'incomplete' ? ErrorKind.BAD_REQUEST : ErrorKind.SERVER,
    });
  }

  const content = String(response.output_text ?? response.output
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text)
    .join('\n') ?? '');

  const toolCalls = response.output
    .filter((item) => item.type === 'function_call')
    .map((item) => {
      const rawArguments = String(item.arguments ?? '{}');
      let args = {};
      let parseError;
      try {
        args = rawArguments.trim() ? JSON.parse(rawArguments) : {};
      } catch (err) {
        parseError = `Tool arguments were not valid JSON (${err.message}). Call the tool again with valid JSON.`;
      }
      return {
        id: item.call_id,
        name: item.name,
        arguments: args,
        rawArguments,
        parseError,
      };
    });

  return {
    content,
    toolCalls,
    message: {
      role: 'assistant',
      content,
      // Keep every item in order; do not strip reasoning or tool-call output.
      openaiResponseOutput: response.output,
    },
    usage: response.usage,
  };
}

export class OpenAIProvider {
  name = 'openai';
  #client = null;

  constructor({
    apiKey = process.env.OPENAI_API_KEY,
    baseURL = process.env.OPENAI_BASE_URL,
    timeoutMs = 120000,
    reasoningLevel = process.env.OPENAI_REASONING_EFFORT ?? 'medium',
    reasoningMode = process.env.OPENAI_REASONING_MODE ?? 'standard',
  } = {}) {
    if (!apiKey) {
      throw new AgentError('Missing OPENAI_API_KEY. Add it to .env.', { kind: ErrorKind.AUTH });
    }
    registerSecret(apiKey);
    this.apiKey = apiKey;
    this.baseURL = baseURL || undefined;
    this.timeoutMs = timeoutMs;
    this.reasoningLevel = normalizeReasoningLevel(reasoningLevel);
    this.reasoningMode = reasoningMode === 'pro' ? 'pro' : 'standard';
  }

  setThinkingLevel(level) {
    this.reasoningLevel = normalizeReasoningLevel(level);
    return this.reasoningLevel;
  }

  setReasoningMode(mode) {
    if (!['standard', 'pro'].includes(mode)) {
      throw new Error('OpenAI reasoning mode must be "standard" or "pro".');
    }
    this.reasoningMode = mode;
    return this.reasoningMode;
  }

  async #sdk() {
    if (this.#client) return this.#client;
    let OpenAI;
    try {
      ({ default: OpenAI } = await import('openai'));
    } catch (err) {
      throw new AgentError(`Could not load the official OpenAI SDK (${err.message}). Run "npm install" in the project folder.`, {
        kind: ErrorKind.UNKNOWN,
        cause: err,
      });
    }
    this.#client = new OpenAI({
      apiKey: this.apiKey,
      ...(this.baseURL ? { baseURL: this.baseURL } : {}),
      timeout: this.timeoutMs,
      maxRetries: 0, // the agent loop owns retries
    });
    return this.#client;
  }

  async connect() {
    await this.#sdk();
  }

  async listModels() {
    const client = await this.#sdk();
    try {
      const page = await client.models.list();
      const models = [];
      for await (const model of page) {
        const id = String(model.id ?? '');
        if (/^(gpt-|o[134](?:-|$))/.test(id) && !NON_CHAT_MODEL.test(id)) {
          models.push({ id, provider: 'openai' });
        }
      }
      if (models.length) return models.sort((a, b) => a.id.localeCompare(b.id));
    } catch {
      // Some compatible gateways do not expose /models. Keep the curated fallback.
    }
    return CURATED_MODELS.map((id) => ({ id, provider: 'openai' }));
  }

  async chat({ model, messages, tools = [], signal, responseFormat } = {}) {
    if (signal?.aborted) throw new AgentError('Request cancelled.', { kind: ErrorKind.ABORTED });
    const client = await this.#sdk();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const modelId = model || OPENAI_DEFAULT_MODEL;
    const { instructions, input } = toResponsesInput(messages);
    const params = {
      model: modelId,
      input,
      ...(instructions ? { instructions } : {}),
      ...(tools.length ? { tools: toOpenAITools(tools) } : {}),
      ...(responseFormat === 'json' ? { text: { format: { type: 'json_object' } } } : {}),
      // OpenAI caches long identical prompt prefixes automatically; a stable key per system prompt
      // routes requests of the same conversation to the same cache.
      ...(instructions && this.promptCacheKey !== false ? { prompt_cache_key: `pa-${crypto.createHash('sha1').update(`${modelId}\n${instructions}`).digest('hex').slice(0, 24)}` } : {}),
      store: false,
      ...(isReasoningModel(modelId) ? {
        reasoning: {
          effort: this.reasoningLevel,
          ...( /^gpt-(?:5\.6|6)(?:[.-]|$)/.test(modelId) && this.reasoningMode === 'pro'
            ? { mode: 'pro' }
            : {}),
        },
      } : {}),
    };
    try {
      const response = await client.responses.create(params, { signal: combined });
      return normalizeOpenAIResponse(response);
    } catch (err) {
      if (signal?.aborted) throw new AgentError('Request cancelled.', { kind: ErrorKind.ABORTED, cause: err });
      if (timeout.aborted) {
        throw new AgentError(`Request timed out after ${this.timeoutMs} ms.`, { kind: ErrorKind.TIMEOUT, cause: err });
      }
      throw classifyError(err);
    }
  }
}
