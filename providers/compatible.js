import { AgentError, ErrorKind, classifyError, registerSecret } from '../utils/errors.js';

// OpenAI Chat Completions adapter for gateways that explicitly implement this protocol.
export class CompatibleProvider {
  #client;
  constructor({ name, apiKey, baseURL, defaultModel, envKey, timeoutMs = 120000, headers } = {}) {
    this.name = name;
    this.defaultModel = defaultModel;
    this.envKey = envKey;
    const key = apiKey ?? (envKey ? process.env[envKey] : undefined) ?? (name === 'ollama' || name === 'lmstudio' ? 'local-no-key' : undefined);
    if (!key) throw new AgentError(`Missing ${envKey}. Add it to .env.`, { kind: ErrorKind.AUTH });
    registerSecret(key);
    this.apiKey = key;
    this.baseURL = baseURL;
    this.timeoutMs = timeoutMs;
    this.headers = headers;
  }
  async connect() {
    let OpenAI;
    try { ({ default: OpenAI } = await import('openai')); }
    catch (err) { throw new AgentError(`Could not load the OpenAI-compatible SDK (${err.message}). Run npm install.`, { kind: ErrorKind.UNKNOWN, cause: err }); }
    this.#client = new OpenAI({ apiKey: this.apiKey, baseURL: this.baseURL, timeout: this.timeoutMs, maxRetries: 0, defaultHeaders: this.headers });
  }
  async listModels() {
    try {
      const page = await this.#client.models.list();
      const models = [];
      for await (const m of page) if (m.id) models.push({ id: String(m.id), provider: this.name });
      if (models.length) return models.sort((a,b) => a.id.localeCompare(b.id));
    } catch { /* Some gateways disable model discovery; curated defaults remain selectable. */ }
    return (PROVIDER_PRESETS[this.name]?.models ?? [this.defaultModel]).map(id => ({ id, provider: this.name }));
  }
  async chat({ model, messages = [], tools = [], signal, responseFormat, onDelta, maxTokens } = {}) {
    if (signal?.aborted) throw new AgentError('Request cancelled.', { kind: ErrorKind.ABORTED });
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const params = {
      model: model || this.defaultModel,
      messages: messages.filter(m => ['system','user','assistant','tool'].includes(m.role)).map(m => ({
        role: m.role, content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      })),
      ...(tools.length ? { tools: tools.filter(t => t?.type === 'function').map(t => ({ type: 'function', function: t.function })) } : {}),
      ...(responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    };
    try {
      if (onDelta && this.stream !== false) {
        try {
          return await this.#streamChat(params, combined, onDelta);
        } catch (err) {
          // Gateways without streaming / stream_options support: remember it and use a normal request.
          if (signal?.aborted || timeout.aborted || !/stream/i.test(String(err?.message ?? ''))) throw err;
          this.stream = false;
        }
      }
      const result = await this.#client.chat.completions.create(params, { signal: combined });
      const msg = result.choices?.[0]?.message ?? {};
      return toReply(msg.content, msg.tool_calls ?? [], result.usage);
    } catch (err) {
      if (signal?.aborted) throw new AgentError('Request cancelled.', { kind: ErrorKind.ABORTED, cause: err });
      if (timeout.aborted) throw new AgentError(`${this.name} request timed out after ${this.timeoutMs} ms.`, { kind: ErrorKind.TIMEOUT, cause: err });
      throw classifyError(err);
    }
  }

  /** Streaming request: text deltas go to onDelta; tool-call fragments are assembled by index. */
  async #streamChat(params, signal, onDelta) {
    const stream = await this.#client.chat.completions.create({ ...params, stream: true, stream_options: { include_usage: true } }, { signal });
    let content = '';
    let usage;
    const calls = [];
    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        onDelta(delta.content, content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? calls.length;
        calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].function.name += tc.function.name;
        if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
      }
    }
    return toReply(content, calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` })), usage);
  }
}

/** Build the provider-neutral reply from Chat Completions content + tool_calls. */
export function toReply(content, rawCalls, usage) {
  const text = String(content ?? '');
  const toolCalls = rawCalls.map((call) => {
    const rawArguments = call.function?.arguments || '{}';
    let args = {};
    let parseError;
    try { args = JSON.parse(rawArguments); } catch (err) { parseError = `Tool arguments were not valid JSON (${err.message}).`; }
    return { id: call.id, name: call.function?.name, arguments: args, rawArguments, parseError };
  });
  return { content: text, toolCalls, message: { role: 'assistant', content: text, ...(rawCalls.length ? { tool_calls: rawCalls } : {}) }, usage };
}

export const PROVIDER_PRESETS = {
  anyapi: { envKey:'ANYAPI_API_KEY', baseURL:'https://api.anyapi.ai/v1', defaultModel:'google/gemini-2.5-flash-lite', models:['google/gemini-2.5-flash-lite'] },
  deepseek: { envKey:'DEEPSEEK_API_KEY', baseURL:'https://api.deepseek.com/v1', defaultModel:'deepseek-chat', models:['deepseek-chat','deepseek-reasoner'] },
  openrouter: { envKey:'OPENROUTER_API_KEY', baseURL:'https://openrouter.ai/api/v1', defaultModel:'deepseek/deepseek-chat-v3.1', models:['deepseek/deepseek-chat-v3.1','anthropic/claude-sonnet-4','openai/gpt-4.1'] },
  groq: { envKey:'GROQ_API_KEY', baseURL:'https://api.groq.com/openai/v1', defaultModel:'llama-3.3-70b-versatile', models:['llama-3.3-70b-versatile','openai/gpt-oss-120b'] },
  mistral: { envKey:'MISTRAL_API_KEY', baseURL:'https://api.mistral.ai/v1', defaultModel:'mistral-large-latest', models:['mistral-large-latest','codestral-latest'] },
  xai: { envKey:'XAI_API_KEY', baseURL:'https://api.x.ai/v1', defaultModel:'grok-3', models:['grok-3','grok-3-mini'] },
  cerebras: { envKey:'CEREBRAS_API_KEY', baseURL:'https://api.cerebras.ai/v1', defaultModel:'llama-3.3-70b', models:['llama-3.3-70b'] },
  together: { envKey:'TOGETHER_API_KEY', baseURL:'https://api.together.xyz/v1', defaultModel:'meta-llama/Llama-3.3-70B-Instruct-Turbo', models:['meta-llama/Llama-3.3-70B-Instruct-Turbo'] },
  fireworks: { envKey:'FIREWORKS_API_KEY', baseURL:'https://api.fireworks.ai/inference/v1', defaultModel:'accounts/fireworks/models/llama-v3p3-70b-instruct', models:['accounts/fireworks/models/llama-v3p3-70b-instruct'] },
  nvidia: { envKey:'NVIDIA_API_KEY', baseURL:'https://integrate.api.nvidia.com/v1', defaultModel:'meta/llama-3.3-70b-instruct', models:['meta/llama-3.3-70b-instruct'] },
  perplexity: { envKey:'PERPLEXITY_API_KEY', baseURL:'https://api.perplexity.ai', defaultModel:'sonar-pro', models:['sonar-pro','sonar'] },
  zai: { envKey:'ZAI_API_KEY', baseURL:'https://api.z.ai/api/paas/v4', defaultModel:'glm-4.5', models:['glm-4.5','glm-4.5-air'] },
  moonshot: { envKey:'MOONSHOT_API_KEY', baseURL:'https://api.moonshot.ai/v1', defaultModel:'kimi-k2-0905-preview', models:['kimi-k2-0905-preview'] },
  qwen: { envKey:'DASHSCOPE_API_KEY', baseURL:'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', defaultModel:'qwen-plus', models:['qwen-plus','qwen-max'] },
  ollama: { envKey:'OLLAMA_API_KEY', baseURL:'http://127.0.0.1:11434/v1', defaultModel:'qwen2.5-coder:7b', models:['qwen2.5-coder:7b'] },
  lmstudio: { envKey:'LMSTUDIO_API_KEY', baseURL:'http://127.0.0.1:1234/v1', defaultModel:'local-model', models:['local-model'] },
};
