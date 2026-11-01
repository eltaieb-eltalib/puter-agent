import { ErrorKind, classifyError } from '../utils/errors.js';
import { withRetry } from '../utils/retry.js';
import { formatResult } from '../tools/registry.js';
import { extractTextToolCalls } from './text-tools.js';
import { VerifyTracker, resultHint } from './verify.js';
import { redactSecrets } from '../utils/redact.js';

const NUDGE =
  'You returned no text and no tool call. If the task is complete, reply with a short final summary; otherwise continue by calling the next tool.';
const STUCK_AFTER = 3; // identical failing calls in a row before we stop

export function usageTotals(usage = {}) {
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0) || 0;
  return { promptTokens: prompt, completionTokens: completion, cachedTokens: cached, totalTokens: Number(usage.total_tokens ?? (prompt + completion)) || 0 };
}

/** Keep recent tool outputs intact while replacing older bulky outputs with compact, deterministic notes. */
export function compressToolHistory(messages, { keep = 4, maxChars = 1200 } = {}) {
  const indexes = [];
  messages.forEach((message, index) => { if (message.role === 'tool') indexes.push(index); });
  for (const index of indexes.slice(0, Math.max(0, indexes.length - keep))) {
    const message = messages[index];
    if (typeof message.content !== 'string' || message.content.length <= maxChars) continue;
    let note = '';
    try {
      const parsed = JSON.parse(message.content);
      const payload = parsed?.result ?? parsed;
      const summary = payload?.summary ?? parsed?.summary;
      const error = parsed?.error;
      note = [error ? `error: ${error}` : '', summary ? `summary: ${summary}` : '', `original output: ${message.content.length} characters`, `preview: ${message.content.slice(0, 500)}`].filter(Boolean).join('\n');
    } catch {
      note = `Older tool output compressed (${message.content.length} characters). Preview: ${message.content.slice(0, 500)}`;
    }
    message.content = note.slice(0, maxChars) + '\n[Full earlier output omitted from model context; request the tool again if needed.]';
  }
}

/**
 * The agent loop:
 *   Model -> (tool calls -> execute -> tool results -> Model)* -> final answer
 *
 * `messages` is mutated in place. Invariant: every assistant tool_call always gets a
 * matching `tool` message before the next model call, even when a call fails, is denied
 * or is cancelled, so the history stays valid for the provider.
 *
 * Returns { content, stopReason: 'done' | 'max_steps' | 'stuck' | 'aborted', steps }.
 * Provider failures (after retries) are thrown as AgentError.
 */
export async function runAgentLoop({
  provider,
  model,
  messages,
  registry,
  ctx,
  maxSteps = 40,
  retry = {},
  maxResultChars = 20000,
  verify = false, // true: after code changes, make the model run something before it may finish
  verifyNudges = 2,
  signal,
  emit = () => {},
  toolNames = null,
  context = {},
}) {
  const tools = registry.definitions({ readOnly: ctx?.mode === 'plan', include: toolNames });
  const usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, modelCalls: 0, toolCalls: 0 };
  const failures = new Map();
  let steps = 0;
  let nudges = 0;
  const tracker = verify && ctx?.mode !== 'plan' ? new VerifyTracker({ maxNudges: verifyNudges }) : null;

  for (;;) {
    if (signal?.aborted) return { content: '', stopReason: 'aborted', steps, usage };
    if (steps >= maxSteps) return { content: '', stopReason: 'max_steps', steps, usage };
    steps++;
    emit({ type: 'thinking', step: steps });

    let reply;
    try {
      reply = await withRetry(() => provider.chat({ model, messages, tools, signal }), {
        ...retry,
        signal,
        onRetry: (info) => emit({ type: 'retry', ...info }),
      });
    } catch (err) {
      if (classifyError(err).kind === ErrorKind.ABORTED) return { content: '', stopReason: 'aborted', steps, usage };
      throw err;
    }

    usage.modelCalls++;
    const turnUsage = usageTotals(reply.usage);
    usage.promptTokens += turnUsage.promptTokens;
    usage.completionTokens += turnUsage.completionTokens;
    usage.cachedTokens += turnUsage.cachedTokens;
    usage.totalTokens += turnUsage.totalTokens;
    emit({ type: 'usage', ...turnUsage, totals: { ...usage } });

    // Weak models sometimes print tool calls as JSON text instead of calling them natively.
    if (reply.toolCalls.length === 0 && reply.content) {
      const found = extractTextToolCalls(reply.content, registry);
      if (found.calls.length) {
        emit({ type: 'text_tool_calls', count: found.calls.length });
        reply = {
          ...reply,
          content: found.text,
          toolCalls: found.calls,
          message: {
            role: 'assistant',
            content: found.text,
            tool_calls: found.calls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: c.rawArguments },
            })),
          },
        };
      }
    }

    messages.push(reply.message);

    if (reply.toolCalls.length === 0) {
      if (!reply.content.trim() && nudges < 1) {
        nudges++;
        messages.push({ role: 'user', content: NUDGE });
        continue;
      }
      const reminder = tracker?.nudge();
      if (reminder) {
        emit({ type: 'verify_nudge' });
        messages.push({ role: 'user', content: reminder });
        continue;
      }
      return { content: reply.content, stopReason: 'done', steps, usage };
    }

    if (reply.content.trim()) emit({ type: 'assistant_text', text: reply.content });

    // Several sub-agent (task) calls in one turn run in parallel; their results are still reported in order.
    const early = new Map();
    const parallel = reply.toolCalls.filter((c) => c.name === 'task' && !c.parseError);
    if (parallel.length > 1 && !(ctx?.hooks?.active)) {
      for (const c of parallel) early.set(c.id, registry.execute(c.name, c.arguments, ctx));
    }

    let stuck = false;
    for (const call of reply.toolCalls) {
      if (signal?.aborted) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ ok: false, error: 'Cancelled by the user before this tool ran.' }),
        });
        continue;
      }

      usage.toolCalls++;
      emit({ type: 'tool_call', name: call.name, args: call.arguments });
      let result;
      if (call.parseError) result = { ok: false, error: call.parseError };
      else {
        const gate = await ctx?.hooks?.pre(call.name, call.arguments);
        if (gate?.blocked) {
          result = { ok: false, error: `Blocked by a PreToolUse hook: ${gate.message}. Do not retry it unchanged.` };
        } else {
          result = await (early.get(call.id) ?? registry.execute(call.name, call.arguments, ctx));
          const note = await ctx?.hooks?.post(call.name, call.arguments, result);
          if (note) result = result.ok ? { ...result, result: { ...result.result, hook_output: note } } : { ...result, hook_output: note };
        }
      }
      emit({ type: 'tool_result', name: call.name, args: call.arguments, result });

      tracker?.observe(call.name, call.arguments, result);

      const signature = `${call.name}:${call.rawArguments}`;
      let count = 0;
      if (result.ok) failures.delete(signature);
      else {
        count = (failures.get(signature) ?? 0) + 1;
        failures.set(signature, count);
        if (count >= STUCK_AFTER) stuck = true;
      }

      // Hints travel with the result: weak results, and a push to change approach before we give up.
      let hint = resultHint(call.name, result);
      if (!result.ok && count === STUCK_AFTER - 1) {
        hint = 'This exact call has failed twice. Do NOT repeat it: change the arguments, read the error carefully, or use a different tool/approach.';
      }
      const shown = hint ? (result.ok ? { ...result, result: { ...result.result, hint } } : { ...result, hint }) : result;

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: redactSecrets(formatResult(shown, maxResultChars)),
      });
    }

    compressToolHistory(messages, { keep: context.keepRecentToolResults ?? 4, maxChars: context.compressedToolResultChars ?? 1200 });
    if (signal?.aborted) return { content: '', stopReason: 'aborted', steps, usage };
    if (stuck) return { content: '', stopReason: 'stuck', steps, usage };
  }
}
