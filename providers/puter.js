import { AgentError, ErrorKind, classifyError, registerSecret } from '../utils/errors.js';

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function textOf(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('');
  }
  return String(content);
}

/**
 * Convert a puter.ai.chat() response (called with normalize:true, i.e. OpenAI format)
 * into { content, toolCalls, message } where `message` is what gets appended to history.
 * Exported for testing.
 */
export function normalizeResponse(response) {
  if (!response || typeof response !== 'object') {
    throw new AgentError('Empty response from Puter.', { kind: ErrorKind.UNKNOWN });
  }
  if (response.success === false || (response.error && !response.message)) {
    throw classifyError(response);
  }
  const raw = response.message;
  if (!raw) {
    throw new AgentError(`Unexpected response shape from Puter: ${safeJson(response).slice(0, 300)}`, {
      kind: ErrorKind.UNKNOWN,
    });
  }

  const content = textOf(raw.content);
  const toolCalls = (raw.tool_calls ?? []).map((tc, i) => {
    const id = tc.id || `call_${Date.now()}_${i}`;
    const name = tc.function?.name ?? tc.name ?? '';
    const args = tc.function?.arguments ?? tc.arguments ?? tc.input ?? '{}';
    const rawArguments = typeof args === 'string' ? args : JSON.stringify(args);
    let parsed = {};
    let parseError;
    try {
      parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {};
    } catch (err) {
      parseError = `Your tool arguments were not valid JSON (${err.message}). Call the tool again with valid JSON.`;
    }
    return { id, name, arguments: parsed, rawArguments, parseError };
  });

  const message = { role: 'assistant', content };
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      // Never replay invalid JSON back to the provider.
      function: { name: tc.name, arguments: tc.parseError ? '{}' : tc.rawArguments },
    }));
  }
  return { content, toolCalls, message, usage: response.usage };
}

/**
 * Puter.js provider.
 *
 * Verified against the Puter docs and the installed @heyputer/puter.js 2.6.x:
 *  - Node entry point: `@heyputer/puter.js/src/init.cjs` exports { init, getAuthToken }.
 *  - Auth: PUTER_AUTH_TOKEN (from puter.com/dashboard) or browser sign-in via getAuthToken().
 *  - puter.ai.chat(messages, { model, tools, stream, normalize, signal, ... }).
 *  - tools use the OpenAI shape { type:'function', function:{ name, description, parameters } }.
 *  - tool calls: response.message.tool_calls[] with id / function.name / function.arguments (JSON string).
 *  - tool results go back as { role:'tool', tool_call_id, content:<string> }.
 */
export class PuterProvider {
  name = 'puter';
  #puter = null;

  constructor({ token = process.env.PUTER_AUTH_TOKEN, timeoutMs = 120000 } = {}) {
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  get hasToken() {
    return Boolean(this.token);
  }

  /** Load Puter.js and authenticate (opens a browser unless a token is configured). */
  async connect() {
    await this.#client();
  }

  async #client() {
    if (this.#puter) return this.#puter;
    let mod;
    try {
      mod = await import('@heyputer/puter.js/src/init.cjs');
    } catch (err) {
      throw new AgentError(
        `Could not load @heyputer/puter.js (${err.message}). Run "npm install" in the project folder.`,
        { kind: ErrorKind.UNKNOWN, cause: err },
      );
    }
    const { init, getAuthToken } = mod.init ? mod : mod.default;
    try {
      const token = this.token || (await getAuthToken());
      registerSecret(token);
      this.#puter = init(token);
    } catch (err) {
      throw new AgentError(`Puter sign-in failed: ${err?.message ?? err}`, {
        kind: ErrorKind.AUTH,
        cause: err,
      });
    }
    return this.#puter;
  }

  async listModels() {
    const puter = await this.#client();
    const list = await puter.ai.listModels();
    return (Array.isArray(list) ? list : [])
      .map((m) => (typeof m === 'string' ? { id: m } : { id: m?.id, provider: m?.provider }))
      .filter((m) => m.id)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * One model turn. Returns { content, toolCalls, message }.
   * Throws AgentError (classified) on failure; the caller decides about retries.
   */
  async chat({ model, messages, tools = [], signal } = {}) {
    const puter = await this.#client();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    // Enable streaming so the UI can print tokens gradually.
    const options = { model, stream: false, normalize: true, signal: combined };
    if (tools.length) options.tools = tools;

    let response;
    try {
      response = await puter.ai.chat(messages, options);
    } catch (err) {
      if (signal?.aborted) throw new AgentError('Request cancelled.', { kind: ErrorKind.ABORTED, cause: err });
      if (timeout.aborted) {
        throw new AgentError(`Request timed out after ${this.timeoutMs} ms.`, {
          kind: ErrorKind.TIMEOUT,
          cause: err,
        });
      }
      throw classifyError(err);
    }
    return normalizeResponse(response);
  }
}
