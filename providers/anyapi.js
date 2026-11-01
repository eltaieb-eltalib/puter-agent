import { AgentError, ErrorKind, classifyError, registerSecret } from '../utils/errors.js';

export const ANYAPI_BASE_URL = 'https://api.anyapi.ai/v1';
export const ANYAPI_DEFAULT_MODEL = 'google/gemini-2.5-flash-lite';

export class AnyAPIProvider {
  name = 'anyapi';
  #client = null;

  constructor({
    apiKey = process.env.ANYAPI_API_KEY,
    baseURL = process.env.ANYAPI_BASE_URL || ANYAPI_BASE_URL,
    timeoutMs = 120000,
  } = {}) {
    if (!apiKey) {
      throw new AgentError('Missing ANYAPI_API_KEY. Add it to .env.', { kind: ErrorKind.AUTH });
    }
    registerSecret(apiKey);
    this.apiKey = apiKey;
    this.baseURL = String(baseURL).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  async #sdk() {
    if (this.#client) return this.#client;
    let OpenAI;
    try {
      ({ default: OpenAI } = await import('openai'));
    } catch (err) {
      throw new AgentError(`Could not load the OpenAI-compatible SDK (${err.message}). Run npm install.`, {
        kind: ErrorKind.UNKNOWN, cause: err,
      });
    }
    this.#client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseURL,
      timeout: this.timeoutMs,
      maxRetries: 0,
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
        if (model?.id) models.push({ id: String(model.id), provider: 'anyapi' });
      }
      if (models.length) return models.sort((a, b) => a.id.localeCompare(b.id));
    } catch {
      // Keep a useful default if the gateway's model listing is temporarily unavailable.
    }
    return [{ id: ANYAPI_DEFAULT_MODEL, provider: 'anyapi' }];
  }

  async chat({ model, messages = [], tools = [], signal } = {}) {
    if (signal?.aborted) throw new AgentError('Request cancelled.', { kind: ErrorKind.ABORTED });
    const client = await this.#sdk();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    // AnyAPI exposes OpenAI-compatible Chat Completions. Do not use the Responses API here.
    const chatMessages = messages.map((message) => {
      if (message.role === 'tool') {
        return { role: 'tool', tool_call_id: message.tool_call_id, content: String(message.content ?? '') };
      }
      if (message.role === 'assistant' && message.tool_calls?.length) {
        return {
          role: 'assistant',
          ...(message.content ? { content: String(message.content) } : {}),
          tool_calls: message.tool_calls.map((call) => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.function?.name ?? call.name,
              arguments: typeof call.function?.arguments === 'string'
                ? call.function.arguments
                : JSON.stringify(call.function?.arguments ?? call.arguments ?? {}),
            },
          })),
        };
      }
      return { role: message.role, content: String(message.content ?? '') };
    }).filter((message) => ['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role));

    const params = {
      model: model || ANYAPI_DEFAULT_MODEL,
      messages: chatMessages,
      ...(tools.length ? { tools } : {}),
    };

    try {
      const response = await client.chat.completions.create(params, { signal: combined });
      const choice = response?.choices?.[0];
      if (!choice?.message) {
        throw new AgentError('AnyAPI returned an empty Chat Completions response.', { kind: ErrorKind.UNKNOWN });
      }
      const message = choice.message;
      const toolCalls = (message.tool_calls ?? []).map((call) => {
        const rawArguments = String(call.function?.arguments ?? '{}');
        let args = {};
        let parseError;
        try {
          args = rawArguments.trim() ? JSON.parse(rawArguments) : {};
        } catch (err) {
          parseError = `Tool arguments were not valid JSON (${err.message}). Call the tool again with valid JSON.`;
        }
        return { id: call.id, name: call.function?.name, arguments: args, rawArguments, parseError };
      });
      return {
        content: typeof message.content === 'string' ? message.content : '',
        toolCalls,
        message: {
          role: 'assistant',
          content: typeof message.content === 'string' ? message.content : '',
          ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
        },
        usage: response.usage,
      };
    } catch (err) {
      if (signal?.aborted) throw new AgentError('Request cancelled.', { kind: ErrorKind.ABORTED, cause: err });
      if (timeout.aborted) throw new AgentError(`AnyAPI request timed out after ${this.timeoutMs} ms.`, {
        kind: ErrorKind.TIMEOUT, cause: err,
      });
      if (err instanceof AgentError) throw err;
      throw classifyError(err);
    }
  }
}
