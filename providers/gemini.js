import { AgentError, ErrorKind, classifyError, registerSecret } from '../utils/errors.js';

export const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';

/** "3.10" > "3.8" (numeric per part, not as decimals). */
function compareVersions(a, b) {
  const [a1, a2 = 0] = String(a).split('.').map(Number);
  const [b1, b2 = 0] = String(b).split('.').map(Number);
  return a1 - b1 || a2 - b2;
}

/** Major version of a gemini id ("gemini-3.8-flash" -> 3), or 0. */
const majorOf = (id) => Number(/^gemini-(\d+)/.exec(id ?? '')?.[1] ?? 0);

/**
 * Best starting model from the provider's own list: the newest stable "gemini-X.Y-flash",
 * else the configured default if offered, else any gemini model, else the first entry.
 * (Never hardcode one id as the only answer: Google retires models, e.g. gemini-2.5-flash.)
 */
export function pickDefaultModel(models = []) {
  const ids = models.map((m) => m.id);
  const flash = ids
    .map((id) => ({ id, v: /^gemini-(\d+(?:\.\d+)?)-flash$/.exec(id)?.[1] }))
    .filter((m) => m.v)
    .sort((a, b) => compareVersions(b.v, a.v))[0];
  return flash?.id ?? ids.find((id) => id === GEMINI_DEFAULT_MODEL) ?? ids.find((id) => id.startsWith('gemini')) ?? ids[0];
}

// Offline fallback when the live model list cannot be fetched. Any id can still be typed by hand.
const FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-3.7-flash'];

// Thinking is what makes Gemini 3 slow ("hi" took ~39 s at the default "medium"). "low" is accepted by every
// current Flash model; "minimal" is rejected by 3.7/3.8 Flash (HTTP 400), so it is never the default.
export const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'];

/** "low" | "medium" | ... -> itself; "off"/"default"/"" -> null (send nothing); anything else -> "low". Exported for tests. */
export function normalizeThinkingLevel(value) {
  const v = String(value ?? 'low').trim().toLowerCase();
  if (['off', 'default', 'none', ''].includes(v)) return null;
  return THINKING_LEVELS.includes(v) ? v : 'low';
}

// Gemini accepts only a subset of JSON Schema. Unknown keys make the whole request fail with 400.
const SCHEMA_KEYS = new Set(['type', 'description', 'properties', 'required', 'items', 'enum', 'format', 'nullable']);

/** OpenAI-style JSON Schema -> the subset Gemini understands (recursive). Exported for tests. */
export function cleanSchema(schema) {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties') {
      out.properties = Object.fromEntries(Object.entries(value ?? {}).map(([k, v]) => [k, cleanSchema(v)]));
    } else if (key === 'items') {
      out.items = cleanSchema(value);
    } else if (SCHEMA_KEYS.has(key)) {
      out[key] = value;
    }
  }
  // Gemini rejects `type: "array"` without `items` (HTTP 400 "items: missing field").
  if (out.type === 'array' && !out.items) out.items = { type: 'string' };
  return out;
}

/** OpenAI `tools` -> Gemini `tools`. Exported for tests. */
export function toGeminiTools(tools = []) {
  if (!tools.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => {
        const params = cleanSchema(t.function.parameters ?? { type: 'object', properties: {} });
        const hasProps = params.properties && Object.keys(params.properties).length > 0;
        return {
          name: t.function.name,
          description: t.function.description,
          // Gemini rejects an object schema with an empty `properties`: omit parameters entirely.
          ...(hasProps && { parameters: params }),
        };
      }),
    },
  ];
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? v : { value: v };
  } catch {
    return {};
  }
}

function parseToolContent(content) {
  try {
    const v = JSON.parse(content);
    // functionResponse.response must be an object.
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { result: v };
  } catch {
    return { result: String(content) };
  }
}

/**
 * OpenAI-style history -> { systemInstruction, contents } for Gemini.
 *  - system            -> systemInstruction
 *  - assistant         -> role "model" (text and/or functionCall parts)
 *  - tool              -> role "user" with functionResponse parts (consecutive results are merged into one turn)
 * Gemini 3+ requires the `thoughtSignature` of every function call to be sent back. We keep the real one
 * (tool_call.thought_signature) and, for calls that have none (history from another model), a documented
 * placeholder when `skipSignatureCheck` is set.
 * Exported for tests.
 */
export const SKIP_SIGNATURE = 'skip_thought_signature_validator';

export function toGeminiContents(messages, { skipSignatureCheck = false } = {}) {
  const names = new Map(); // tool_call_id -> function name (Gemini matches results by name, not by id)
  const system = [];
  const contents = [];

  for (const m of messages) {
    if (!m || !m.role) continue;
    if (m.role === 'system') {
      if (m.content) system.push(String(m.content));
    } else if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: String(m.content ?? '') }] });
    } else if (m.role === 'assistant') {
      const parts = [];
      if (m.content) parts.push({ text: String(m.content) });
      for (const tc of m.tool_calls ?? []) {
        names.set(tc.id, tc.function.name);
        const signature = tc.thought_signature ?? (skipSignatureCheck ? SKIP_SIGNATURE : undefined);
        parts.push({
          functionCall: { name: tc.function.name, args: parseArgs(tc.function.arguments) },
          ...(signature && { thoughtSignature: signature }),
        });
      }
      if (parts.length) contents.push({ role: 'model', parts });
    } else if (m.role === 'tool') {
      const part = {
        functionResponse: { name: names.get(m.tool_call_id) ?? 'unknown_tool', response: parseToolContent(m.content) },
      };
      const last = contents.at(-1);
      if (last && last.role === 'user' && last.parts.every((p) => p.functionResponse)) last.parts.push(part);
      else contents.push({ role: 'user', parts: [part] });
    }
  }
  return {
    systemInstruction: system.length ? { role: 'system', parts: [{ text: system.join('\n\n') }] } : undefined,
    contents,
  };
}

/** Gemini response -> { content, toolCalls, message } (same shape as the Puter provider). Exported for tests. */
export function normalizeGeminiResponse(response) {
  const candidate = response?.candidates?.[0];
  if (!candidate) {
    const reason = response?.promptFeedback?.blockReason;
    throw new AgentError(
      reason ? `Gemini blocked the prompt (${reason}).` : 'Gemini returned no candidates.',
      { kind: ErrorKind.BAD_REQUEST },
    );
  }
  const parts = candidate.content?.parts ?? [];
  const content = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
  const toolCalls = parts
    .filter((p) => p.functionCall)
    .map((p, i) => {
      const args = p.functionCall.args ?? {};
      return {
        id: `gemini_${Date.now()}_${i}`,
        name: p.functionCall.name,
        arguments: args,
        rawArguments: JSON.stringify(args),
        thoughtSignature: p.thoughtSignature ?? p.thought_signature,
      };
    });

  if (!content && !toolCalls.length && candidate.finishReason && candidate.finishReason !== 'STOP') {
    throw new AgentError(`Gemini stopped without an answer (${candidate.finishReason}).`, { kind: ErrorKind.BAD_REQUEST });
  }

  const message = { role: 'assistant', content };
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((t) => ({
      id: t.id,
      type: 'function',
      function: { name: t.name, arguments: t.rawArguments },
      ...(t.thoughtSignature && { thought_signature: t.thoughtSignature }),
    }));
  }
  return { content, toolCalls, message, usage: response.usageMetadata };
}

/**
 * Google Gemini provider with real function calling.
 * Options: apiKey (default GEMINI_API_KEY), modelId, baseUrl (default GEMINI_BASE_URL; for proxies and tests).
 */
export class GeminiProvider {
  name = 'gemini';
  #sdk = null;
  #apiKey;
  #baseUrl;

  constructor({
    apiKey = process.env.GEMINI_API_KEY,
    modelId,
    baseUrl = process.env.GEMINI_BASE_URL,
    timeoutMs = 120000,
    thinkingLevel = process.env.GEMINI_THINKING_LEVEL ?? 'low',
  } = {}) {
    if (!apiKey) {
      throw new AgentError('Missing GEMINI_API_KEY. Put it in .env (get one from Google AI Studio).', {
        kind: ErrorKind.AUTH,
      });
    }
    registerSecret(apiKey);
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl || undefined;
    this.modelId = modelId;
    this.timeoutMs = timeoutMs;
    // An empty value (e.g. a blank line copied from .env.example) means "not set", not "off".
    this.thinkingLevel = normalizeThinkingLevel(thinkingLevel === '' ? 'low' : thinkingLevel);
  }

  /** Change the thinking level at runtime ("low" | "medium" | "high" | "minimal" | "off"). Returns the level in effect (null = off). */
  setThinkingLevel(level) {
    this.thinkingLevel = normalizeThinkingLevel(level === '' ? 'low' : level);
    return this.thinkingLevel;
  }

  get hasToken() {
    return true;
  }

  async #client() {
    if (this.#sdk) return this.#sdk;
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    this.#sdk = new GoogleGenerativeAI(this.#apiKey);
    return this.#sdk;
  }

  async connect() {
    await this.#client();
  }

  async listModels() {
    const base = (this.#baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
    try {
      const res = await fetch(`${base}/v1beta/models?pageSize=200`, {
        headers: { 'x-goog-api-key': this.#apiKey },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const live = (data.models ?? [])
        .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
        .map((m) => ({ id: String(m.name).replace(/^models\//, ''), provider: 'gemini' }))
        .sort((a, b) => a.id.localeCompare(b.id));
      if (live.length) return live;
    } catch {
      /* fall through to the curated list */
    }
    return FALLBACK_MODELS.map((id) => ({ id, provider: 'gemini' }));
  }

  /** One model turn. Returns { content, toolCalls, message }; throws a classified AgentError. */
  async chat({ model, messages, tools = [], signal } = {}) {
    // The SDK only listens for a *future* abort event, so an already-cancelled request must be stopped here.
    if (signal?.aborted) throw new AgentError('Request cancelled.', { kind: ErrorKind.ABORTED });
    const sdk = await this.#client();
    const modelId = model || this.modelId || GEMINI_DEFAULT_MODEL;
    const modern = majorOf(modelId) >= 3;
    const { systemInstruction, contents } = toGeminiContents(messages, { skipSignatureCheck: modern });

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    const callOnce = async () => {
      const generationConfig = modern
        ? // Gemini 3+ is tuned for its default temperature; lowering it can cause loops.
          this.thinkingLevel
          ? { thinkingConfig: { thinkingLevel: this.thinkingLevel } }
          : undefined
        : { temperature: 0.2 };
      const genModel = sdk.getGenerativeModel(
        { model: modelId, systemInstruction, tools: toGeminiTools(tools), ...(generationConfig && { generationConfig }) },
        this.#baseUrl ? { baseUrl: this.#baseUrl } : undefined,
      );
      return (await genModel.generateContent({ contents }, { signal: combined })).response;
    };

    let response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await callOnce();
        break;
      } catch (err) {
        if (signal?.aborted) throw new AgentError('Request cancelled.', { kind: ErrorKind.ABORTED, cause: err });
        if (timeout.aborted) {
          throw new AgentError(`Request timed out after ${this.timeoutMs} ms.`, { kind: ErrorKind.TIMEOUT, cause: err });
        }
        // The SDK buries the useful part ("[503 Service Unavailable] ...") after a long URL: keep just that.
        const clean = String(err?.message ?? err).replace(/^\[GoogleGenerativeAI Error\]: Error fetching from \S+?:generateContent: /, '');
        // This model does not accept our thinking level: stop sending it (once) and retry right away.
        if (attempt === 0 && modern && this.thinkingLevel && err?.status === 400 && /thinking[\s_-]?level/i.test(clean)) {
          this.thinkingLevel = null;
          continue;
        }
        throw classifyError(Object.assign(new Error(clean), { status: err?.status, code: err?.code, cause: err }));
      }
    }
    return normalizeGeminiResponse(response);
  }
}
