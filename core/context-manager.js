// Context management: keeps what is sent to the model small without losing the facts it needs.
//
// Old tool outputs are the biggest source of context bloat. They are replaced by short,
// tool-aware notes (what was read/run/found), never by blind truncation. Compression runs in
// BATCHES (only when old uncompressed output exceeds a budget) so the message prefix stays
// byte-identical between steps; providers with prompt caching (OpenAI, Anthropic, Gemini) can
// then keep reusing the cached prefix instead of re-billing it on every step.

export const SHORTENED_MARK = '[older tool output shortened';

/** Rough token estimate: ~4 chars/token for ASCII, ~1.5 chars/token for other scripts (e.g. Arabic). */
export function estimateTokens(text) {
  const s = String(text ?? '');
  let ascii = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 128) ascii++;
  return Math.ceil(ascii / 4 + (s.length - ascii) / 1.5);
}

export const messageText = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')) + (m.tool_calls ? JSON.stringify(m.tool_calls) : '');

export function estimateMessagesTokens(messages) {
  return messages.reduce((n, m) => n + estimateTokens(messageText(m)) + 4, 0);
}

/** Map tool_call_id -> { name, args } from the assistant messages. */
export function toolCallIndex(messages) {
  const index = new Map();
  for (const m of messages) {
    for (const c of m.tool_calls ?? []) {
      let args = {};
      try {
        args = JSON.parse(c.function?.arguments ?? '{}');
      } catch {
        /* keep {} */
      }
      index.set(c.id, { name: c.function?.name ?? c.name, args });
    }
  }
  return index;
}

const tail = (text, lines = 3, width = 160) =>
  String(text ?? '')
    .trimEnd()
    .split(/\r?\n/)
    .slice(-lines)
    .map((l) => l.slice(0, width))
    .join(' | ');

/**
 * A compact note that keeps the facts of an old tool result (exit codes, paths, counts, errors)
 * and drops the bulk (file bodies, page text, long logs).
 */
export function summarizeToolOutput(name, args, content, maxChars = 500) {
  const original = String(content ?? '');
  let parsed = null;
  try {
    parsed = JSON.parse(original);
  } catch {
    /* not JSON */
  }
  const head = `${SHORTENED_MARK}: ${original.length} chars]`;
  if (!parsed || typeof parsed !== 'object') return `${head} preview: ${original.slice(0, Math.max(80, maxChars - 120))}`.slice(0, maxChars);
  if (parsed.ok === false) return `${head} ${name ?? 'tool'} failed: ${String(parsed.error ?? '').slice(0, maxChars - 80)}`.slice(0, maxChars);
  const r = parsed.result ?? parsed;
  const parts = [];
  switch (name) {
    case 'read_file':
      parts.push(`read ${r.path ?? args?.path} ${r.start_line ? `lines ${r.start_line}-${r.end_line} of ` : ''}${r.total_lines ?? '?'} lines${r.hash ? ` (hash ${String(r.hash).slice(0, 8)})` : ''}. Body omitted: call read_file again (with start_line/end_line) if you need exact text.`);
      break;
    case 'run_command':
    case 'run_node':
    case 'run_python':
      parts.push(`ran ${args?.command ?? args?.file ?? ''} -> exit ${r.exit_code}${r.timed_out ? ' (timed out)' : ''}`);
      if (r.stderr?.trim()) parts.push(`stderr: ${tail(r.stderr)}`);
      if (r.stdout?.trim()) parts.push(`stdout: ${tail(r.stdout)}`);
      break;
    case 'search_files':
      parts.push(`${(r.matches ?? []).length} match(es): ${(r.matches ?? []).slice(0, 5).map((m) => `${m.file}:${m.line}`).join(', ')}`);
      break;
    case 'find_symbol':
      parts.push(`${(r.definitions ?? []).length} definition(s): ${(r.definitions ?? []).slice(0, 5).map((m) => `${m.file}:${m.line}`).join(', ')}`);
      break;
    case 'glob':
    case 'list_files':
      parts.push(`${(r.files ?? r.entries ?? []).length} entries: ${(r.files ?? r.entries ?? []).slice(0, 8).map((e) => (typeof e === 'string' ? e : e.name ?? e.path)).join(', ')}`);
      break;
    case 'web_search':
      parts.push(`results: ${(r.results ?? []).slice(0, 4).map((x) => x.url).join(' , ')}`);
      break;
    case 'web_fetch':
      parts.push(`fetched ${r.url ?? args?.url} "${String(r.title ?? '').slice(0, 80)}": ${String(r.content ?? '').slice(0, 200)}`);
      break;
    case 'task':
      parts.push(`sub-agent report: ${String(r.report ?? '').slice(0, maxChars - 120)}`);
      break;
    default:
      if (r.summary) parts.push(`summary: ${r.summary}`);
      else parts.push(`preview: ${original.slice(0, 200)}`);
  }
  if (r.hint) parts.push(`hint was: ${String(r.hint).slice(0, 120)}`);
  return `${head} ${parts.join(' ; ')}`.slice(0, maxChars);
}

const isShortened = (m) => typeof m.content === 'string' && m.content.startsWith(SHORTENED_MARK);

/**
 * Replace bulky old tool results with notes.
 * - keep:        the most recent N tool results stay untouched
 * - maxChars:    results at or below this size are left alone; others become notes of this size
 * - triggerChars: only act when the old, still-uncompressed output exceeds this (batching keeps
 *                 the prompt prefix stable for provider-side caching). 0 = always compress.
 * Returns the number of messages rewritten.
 */
export function compressToolResults(messages, { keep = 4, maxChars = 500, triggerChars = 8000 } = {}) {
  const idx = [];
  messages.forEach((m, i) => m.role === 'tool' && idx.push(i));
  const old = idx.slice(0, Math.max(0, idx.length - keep)).filter((i) => {
    const m = messages[i];
    return typeof m.content === 'string' && m.content.length > maxChars && !isShortened(m);
  });
  if (!old.length) return 0;
  const pending = old.reduce((n, i) => n + messages[i].content.length, 0);
  if (pending < triggerChars) return 0;
  const calls = toolCallIndex(messages);
  for (const i of old) {
    const m = messages[i];
    const call = calls.get(m.tool_call_id) ?? {};
    m.content = summarizeToolOutput(call.name, call.args, m.content, maxChars);
  }
  return old.length;
}

/** Size report used by /context and the status bar. */
export function contextReport(messages, { limitTokens = 32000 } = {}) {
  const byRole = { system: 0, user: 0, assistant: 0, tool: 0 };
  let chars = 0;
  for (const m of messages) {
    const n = messageText(m).length;
    chars += n;
    byRole[m.role] = (byRole[m.role] ?? 0) + n;
  }
  const tokens = estimateMessagesTokens(messages);
  return { messages: messages.length, chars, tokens, byRole, limitTokens, percent: Math.min(999, Math.round((tokens / limitTokens) * 100)) };
}
