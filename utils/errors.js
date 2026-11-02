// Error types and classification.
//
// Puter / network failures arrive in several shapes (Error objects, plain
// objects like { success:false, error:{ code, message } }, strings). This module
// turns all of them into an AgentError with a `kind` so the rest of the code can
// decide whether a retry makes sense.

export const ErrorKind = Object.freeze({
  AUTH: 'auth',
  PAYMENT: 'payment',
  RATE_LIMIT: 'rate_limit',
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  SERVER: 'server',
  BAD_REQUEST: 'bad_request',
  MODEL_NOT_FOUND: 'model_not_found',
  ABORTED: 'aborted',
  UNKNOWN: 'unknown',
});

// Only transient problems are retried. AUTH and PAYMENT need the user to act.
const RETRYABLE = new Set([
  ErrorKind.RATE_LIMIT,
  ErrorKind.TIMEOUT,
  ErrorKind.NETWORK,
  ErrorKind.SERVER,
]);

// Secrets (the Puter auth token) must never reach the terminal, logs or the model.
// Anything registered here is masked in every AgentError message.
const secrets = new Set();

export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) secrets.add(value);
}

export function scrub(text) {
  let out = String(text);
  for (const secret of secrets) out = out.split(secret).join('***');
  return out;
}

export class AgentError extends Error {
  constructor(message, { kind = ErrorKind.UNKNOWN, status, code, cause } = {}) {
    super(scrub(message), { cause });
    this.name = 'AgentError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.retryable = RETRYABLE.has(kind);
  }
}

/** Error raised by a tool for a problem the model can read and react to. */
export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}

export class PathError extends ToolError {
  constructor(message) {
    super(message);
    this.name = 'PathError';
  }
}

// Keys that may hold credentials or the full request (Puter's network errors embed both).
const SENSITIVE_KEYS = new Set(['_puterreq', 'auth_token', 'authtoken', 'token', 'authorization', 'headers', 'body']);

function safeJson(value, max = 300) {
  try {
    const text = JSON.stringify(value, (key, v) => (SENSITIVE_KEYS.has(key.toLowerCase()) ? '[redacted]' : v));
    return text.length > max ? `${text.slice(0, max)}...` : text;
  } catch {
    return String(value);
  }
}

function describe(err) {
  if (typeof err === 'string') return { message: err, code: '' };
  const inner = err && typeof err.error === 'object' && err.error ? err.error : null;
  const status =
    Number(
      err?.status ?? err?.statusCode ?? inner?.status ?? inner?.statusCode ?? err?.response?.status,
    ) || undefined;
  const code = String(inner?.code ?? err?.code ?? '').toLowerCase();
  const message =
    inner?.message ??
    (typeof err?.error === 'string' ? err.error : undefined) ??
    err?.message ??
    safeJson(err);
  return { status, code, message: String(message) };
}

export function classifyError(err) {
  if (err instanceof AgentError) return err;
  // Puter reports a failed network request as a raw XHR-like object with status 0 (no response).
  if (err && typeof err === 'object' && !(err instanceof Error) && err.status === 0) {
    return new AgentError('Could not reach Puter (the network request got no response).', {
      kind: ErrorKind.NETWORK,
      status: 0,
      cause: err,
    });
  }

  const { status, code, message } = describe(err);
  const text = `${code} ${message}`.toLowerCase();
  const make = (kind) => new AgentError(message, { kind, status, code, cause: err });

  if (err?.name === 'AbortError' || code === 'aborted') return make(ErrorKind.ABORTED);
  if (
    err?.name === 'TimeoutError' ||
    code === 'request_timeout' ||
    /\btime[- ]?d?[- ]?out\b|etimedout/.test(text)
  ) {
    return make(ErrorKind.TIMEOUT);
  }
  if (
    status === 402 ||
    /insufficient|out of credit|no credit|payment required|quota exceeded|usage_exceeded|balance/.test(text)
  ) {
    return make(ErrorKind.PAYMENT);
  }
  if (
    status === 401 ||
    status === 403 ||
    /unauthori|not authenticated|authentication|invalid (auth )?token|forbidden|auth_failed/.test(text)
  ) {
    return make(ErrorKind.AUTH);
  }
  if (status === 429 || /rate.?limit|too many requests|throttl/.test(text)) {
    return make(ErrorKind.RATE_LIMIT);
  }
  if (
    // APIConnectionError (OpenAI SDK, used by many providers) says only "Connection error.".
    err?.name === 'APIConnectionError' ||
    /network_error|invalid_stream_response|econnreset|econnrefused|enotfound|eai_again|fetch failed|socket hang up|network|connection (?:error|reset|refused|closed)|premature close|terminated/.test(
      text,
    )
  ) {
    return make(ErrorKind.NETWORK);
  }
  if (
    (status && status >= 500) ||
    /internal server error|bad gateway|service unavailable|overloaded/.test(text)
  ) {
    return make(ErrorKind.SERVER);
  }
  if (status === 404 && /model|no longer available|not found|not supported/.test(text)) return make(ErrorKind.MODEL_NOT_FOUND);
  if (status && status >= 400) return make(ErrorKind.BAD_REQUEST);
  return make(ErrorKind.UNKNOWN);
}

const HINTS = {
  [ErrorKind.AUTH]:
    'Authentication failed. Check PUTER_AUTH_TOKEN (create one at puter.com/dashboard) or restart to sign in again.',
  [ErrorKind.PAYMENT]:
    'Puter reports insufficient credits or quota (HTTP 402). Retrying will not help: wait for your allowance to reset, add credits, or switch model with /model.',
  [ErrorKind.RATE_LIMIT]:
    'Rate limit reached (HTTP 429) even after retrying with backoff. Wait a little, or switch model with /model, then resend your request (or type "continue" if work was already underway).',
  [ErrorKind.TIMEOUT]:
    'The request timed out. Raise "requestTimeoutMs" in config/settings.json, then resend your request (or type "continue").',
  [ErrorKind.NETWORK]:
    'Network problem while reaching Puter. Check your internet connection, then resend your request (or type "continue" if work was already underway).',
  [ErrorKind.SERVER]: 'Puter or the model provider had a server error. Try again shortly: resend your request or type "continue".',
  [ErrorKind.BAD_REQUEST]:
    'The request was rejected. The selected model may not support tools (function calling): try another with /model.',
  [ErrorKind.MODEL_NOT_FOUND]:
    'This model id does not exist or was retired by the provider. Pick a current one: /model (lists what the provider offers) or /connect <provider> <model>.',
  [ErrorKind.ABORTED]: 'Cancelled.',
  [ErrorKind.UNKNOWN]: '',
};

/** Human-readable explanation for the terminal. */
export function explainError(err) {
  const e = classifyError(err);
  const hint = HINTS[e.kind];
  return hint && e.kind !== ErrorKind.ABORTED ? `${e.message}\n  -> ${hint}` : e.message || hint;
}
