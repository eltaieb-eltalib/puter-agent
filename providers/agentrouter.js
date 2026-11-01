import { AgentError, ErrorKind, classifyError, registerSecret } from '../utils/errors.js';
import { toResponsesInput, toOpenAITools, normalizeOpenAIResponse } from './openai.js';

export const AGENTROUTER_DEFAULT_MODEL = 'gpt-6-astra';
export const AGENTROUTER_BASE_URL = 'https://agentrouter.org/v1';
export const AGENTROUTER_ENDPOINT = '/responses';
export const AGENTROUTER_FULL_ENDPOINT = `${AGENTROUTER_BASE_URL}${AGENTROUTER_ENDPOINT}`;
export const AGENTROUTER_MODELS = ['gpt-5.6-sol', 'gpt-6-astra', 'gpt-6.1-sol'];

export class AgentRouterProvider {
  name = 'agentrouter';

  constructor({ apiKey = process.env.AGENTROUTER_API_KEY } = {}) {
    if (!apiKey) {
      throw new AgentError('Missing AGENTROUTER_API_KEY. Add it to .env.', { kind: ErrorKind.AUTH });
    }
    registerSecret(apiKey);
    this.apiKey = apiKey;
    // AgentRouter connection settings are intentionally fixed to the supplied specification.
    this.baseURL = AGENTROUTER_BASE_URL;
    this.endpoint = AGENTROUTER_FULL_ENDPOINT;
    this.timeoutMs = 60000;
    this.headers = Object.freeze({
      'HTTP-Referer': 'https://github.com/RooVetGit/Roo-Cline',
      'X-Title': 'Roo Code',
      'User-Agent': 'RooCode/3.53.0',
    });
  }

  async connect() {
    // Validate local configuration without sending a billable test request.
    if (!this.apiKey) throw new AgentError('Missing AGENTROUTER_API_KEY.', { kind: ErrorKind.AUTH });
  }

  async listModels() {
    return AGENTROUTER_MODELS.map((id) => ({ id, provider: 'agentrouter' }));
  }

  async chat({ model, messages, tools = [], signal } = {}) {
    if (signal?.aborted) throw new AgentError('Request cancelled.', { kind: ErrorKind.ABORTED });
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const { instructions, input } = toResponsesInput(messages);
    const modelId = model || AGENTROUTER_DEFAULT_MODEL;
    const body = {
      model: modelId,
      input,
      ...(instructions ? { instructions } : {}),
      ...(tools.length ? { tools: toOpenAITools(tools) } : {}),
      store: false,
    };

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          ...this.headers,
        },
        body: JSON.stringify(body),
        signal: combined,
      });
      const raw = await response.text();
      let payload;
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        throw new AgentError(`AgentRouter returned invalid JSON (HTTP ${response.status}).`, {
          kind: response.status >= 500 ? ErrorKind.SERVER : ErrorKind.BAD_REQUEST,
        });
      }
      if (!response.ok) {
        const message = payload?.error?.message ?? payload?.message ?? payload?.error ?? `HTTP ${response.status}`;
        throw new AgentError(`AgentRouter API error: ${String(message)}`, {
          kind: response.status === 401 || response.status === 403
            ? ErrorKind.AUTH
            : response.status === 429
              ? ErrorKind.RATE_LIMIT
              : response.status >= 500
                ? ErrorKind.SERVER
                : ErrorKind.BAD_REQUEST,
        });
      }
      return normalizeOpenAIResponse(payload);
    } catch (err) {
      if (signal?.aborted) throw new AgentError('Request cancelled.', { kind: ErrorKind.ABORTED, cause: err });
      if (timeout.aborted) {
        throw new AgentError('AgentRouter request timed out after 60000 ms.', {
          kind: ErrorKind.TIMEOUT,
          cause: err,
        });
      }
      if (err instanceof AgentError) throw err;
      throw classifyError(err);
    }
  }
}
