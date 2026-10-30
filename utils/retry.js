import { AgentError, ErrorKind, classifyError } from './errors.js';

/** Sleep that wakes up early (and rejects) if the signal aborts. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AgentError('Cancelled.', { kind: ErrorKind.ABORTED }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AgentError('Cancelled.', { kind: ErrorKind.ABORTED }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run `fn`, retrying transient failures with exponential backoff.
 * Auth, payment, bad-request and abort errors are never retried.
 */
export async function withRetry(
  fn,
  {
    retries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 15000,
    factor = 2,
    jitter = true,
    signal,
    onRetry,
    sleep: sleepFn = sleep,
  } = {},
) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      const error = classifyError(err);
      if (!error.retryable || attempt >= retries || signal?.aborted) throw error;
      const base = Math.min(maxDelayMs, baseDelayMs * factor ** attempt);
      const delayMs = jitter ? Math.round(base * (0.5 + Math.random() * 0.5)) : base;
      onRetry?.({ attempt: attempt + 1, retries, delayMs, error });
      await sleepFn(delayMs, signal);
      attempt++;
    }
  }
}
