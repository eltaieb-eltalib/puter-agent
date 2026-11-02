import { AgentError, ErrorKind, classifyError } from '../utils/errors.js';
import { withRetry } from '../utils/retry.js';
import { formatResult } from '../tools/registry.js';
import { VerifyTracker, failureHint, resultHint } from './verify.js';
import { redactSecrets } from '../utils/redact.js';
import { compressToolResults } from './context-manager.js';
import { createProtocol, isToolsUnsupported } from './tool-protocol.js';
import { hashText, stableStringify } from './cache.js';
import { checkpointNote } from './planner.js';

const NUDGE =
  'You returned no text and no tool call. If the task is complete, reply with a short final summary; otherwise continue by calling the next tool.';
const STUCK_AFTER = 3; // identical failing calls in a row before we stop
const REPEAT_LIMIT = 4; // identical successful calls with identical results before we stop (loop guard)

export function usageTotals(usage = {}) {
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const cached =
    Number(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.cached_tokens ?? usage.cache_read_input_tokens ?? 0) || 0;
  return { promptTokens: prompt, completionTokens: completion, cachedTokens: cached, totalTokens: Number(usage.total_tokens ?? (prompt + completion)) || 0 };
}

/** Compatibility wrapper (older API): compress every old bulky result now, keeping the last `keep`. */
export function compressToolHistory(messages, { keep = 4, maxChars = 1200 } = {}) {
  return compressToolResults(messages, { keep, maxChars, triggerChars: 0 });
}

const callSignature = (call) => `${call.name}:${stableStringify(call.arguments ?? {})}`;

/**
 * The agent loop:
 *   Model -> (tool calls -> execute -> tool results -> Model)* -> final answer
 *
 * `messages` is mutated in place. Invariant: every assistant tool_call always gets a
 * matching result message before the next model call, even when a call fails, is denied
 * or is cancelled, so the history stays valid for the provider.
 *
 * Token/context economy built in:
 *   - read-only calls in one turn run in parallel (wall-clock), results stay in order
 *   - a call that returns exactly what an identical earlier call returned (still in context) is
 *     answered with a one-line "unchanged" note instead of the full output again
 *   - failed calls get a local diagnosis (no extra model call)
 *   - old tool outputs are compressed in batches so the prompt prefix stays cacheable
 *   - one checkpoint note when the soft step budget is spent; hard limit = maxSteps
 *
 * Returns { content, stopReason: 'done' | 'max_steps' | 'stuck' | 'aborted', steps, usage }.
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
  protocol: protocolName = 'native',
  analysis = null, // from planner.analyzeRequest: enables the soft-budget checkpoint
  ledger = null,
}) {
  const defs = registry.definitions({ readOnly: ctx?.mode === 'plan', include: toolNames });
  let protocol = createProtocol(protocolName === 'auto' ? 'native' : protocolName);
  const usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, modelCalls: 0, toolCalls: 0, cachedToolCalls: 0, dedupedResults: 0, latencyMs: 0 };
  const failures = new Map();
  const seen = new Map(); // signature -> { hash, msg, count }
  let steps = 0;
  let nudges = 0;
  let checkpointSent = false;
  const tracker = verify && ctx?.mode !== 'plan' ? new VerifyTracker({ maxNudges: verifyNudges }) : null;
  const compression = {
    keep: context.keepRecentToolResults ?? 4,
    maxChars: context.compressedToolResultChars ?? 500,
    triggerChars: context.compressTriggerChars ?? 8000,
  };

  for (;;) {
    if (signal?.aborted) return { content: '', stopReason: 'aborted', steps, usage };
    if (steps >= maxSteps) return { content: '', stopReason: 'max_steps', steps, usage };
    steps++;
    emit({ type: 'thinking', step: steps });

    let reply;
    const started = Date.now();
    try {
      reply = await withRetry(
        async () => {
          const req = protocol.request(messages, defs);
          try {
            return await provider.chat({ model, messages: req.messages, tools: req.tools, responseFormat: req.responseFormat, signal, onDelta: ctx?.onDelta });
          } catch (err) {
            // Model/endpoint without native tools: switch this run to prompt-mode tools and retry at once.
            if (protocol.name === 'native' && defs.length && protocolName === 'auto' && isToolsUnsupported(err)) {
              protocol = createProtocol('prompt');
              emit({ type: 'protocol', name: 'prompt' });
              const again = protocol.request(messages, defs);
              return provider.chat({ model, messages: again.messages, tools: again.tools, signal, onDelta: ctx?.onDelta });
            }
            throw err;
          }
        },
        { ...retry, signal, onRetry: (info) => emit({ type: 'retry', ...info }) },
      );
    } catch (err) {
      if (classifyError(err).kind === ErrorKind.ABORTED) return { content: '', stopReason: 'aborted', steps, usage };
      throw err;
    }
    const latencyMs = Date.now() - started;

    usage.modelCalls++;
    usage.latencyMs += latencyMs;
    const turnUsage = usageTotals(reply.usage);
    usage.promptTokens += turnUsage.promptTokens;
    usage.completionTokens += turnUsage.completionTokens;
    usage.cachedTokens += turnUsage.cachedTokens;
    usage.totalTokens += turnUsage.totalTokens;
    emit({ type: 'usage', ...turnUsage, latencyMs, totals: { ...usage } });

    reply = protocol.parse(reply, registry);
    if (reply.textCalls) emit({ type: 'text_tool_calls', count: reply.textCalls });

    messages.push(reply.message);

    if (reply.toolCalls.length === 0) {
      if (!String(reply.content ?? '').trim() && nudges < 1) {
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

    if (String(reply.content ?? '').trim()) emit({ type: 'assistant_text', text: reply.content });

    // Read-only calls of this turn start together (hooks force sequential execution so a
    // PreToolUse hook always sees calls in order). Results are still recorded in order.
    const early = new Map();
    const parallelOk = !ctx?.hooks?.active && context.parallelTools !== false;
    const parallel = parallelOk ? reply.toolCalls.filter((c) => !c.parseError && registry.isParallelSafe(c.name)) : [];
    if (parallel.length > 1) {
      emit({ type: 'parallel', count: parallel.length });
      for (const c of parallel) {
        emit({ type: 'tool_call', name: c.name, args: c.arguments, id: c.id, parallel: true });
        const t0 = Date.now();
        early.set(c.id, registry.execute(c.name, c.arguments, ctx).then((result) => ({ result, ms: Date.now() - t0 })));
      }
    }

    let stuck = false;
    for (const call of reply.toolCalls) {
      if (signal?.aborted) {
        messages.push(protocol.resultMessage(call, JSON.stringify({ ok: false, error: 'Cancelled by the user before this tool ran.' })));
        continue;
      }

      usage.toolCalls++;
      let result;
      let ms = 0;
      if (!early.has(call.id)) emit({ type: 'tool_call', name: call.name, args: call.arguments, id: call.id });
      if (call.parseError) result = { ok: false, error: call.parseError };
      else if (early.has(call.id)) ({ result, ms } = await early.get(call.id));
      else {
        const t0 = Date.now();
        const gate = await ctx?.hooks?.pre(call.name, call.arguments);
        if (gate?.blocked) {
          result = { ok: false, error: `Blocked by a PreToolUse hook: ${gate.message}. Do not retry it unchanged.` };
        } else {
          result = await registry.execute(call.name, call.arguments, ctx);
          const note = await ctx?.hooks?.post(call.name, call.arguments, result);
          if (note) result = result.ok ? { ...result, result: { ...result.result, hook_output: note } } : { ...result, hook_output: note };
        }
        ms = Date.now() - t0;
      }
      if (result.cached) usage.cachedToolCalls++;
      emit({ type: 'tool_result', name: call.name, args: call.arguments, result, id: call.id, ms });

      tracker?.observe(call.name, call.arguments, result);
      ledger?.observe(call.name, call.arguments, result);

      const signature = callSignature(call);
      let count = 0;
      if (result.ok) failures.delete(signature);
      else {
        count = (failures.get(signature) ?? 0) + 1;
        failures.set(signature, count);
        if (count >= STUCK_AFTER) stuck = true;
      }

      // Hints travel with the result: weak results, local failure diagnosis, and a push to change
      // approach before we give up.
      let hint = resultHint(call.name, result) ?? failureHint(call.name, call.arguments, result);
      if (!result.ok && count === STUCK_AFTER - 1) {
        hint = 'This exact call has failed twice. Do NOT repeat it: change the arguments, read the error carefully, or use a different tool/approach.';
      }
      if (!checkpointSent && analysis && steps >= analysis.softBudget && steps < maxSteps) {
        checkpointSent = true;
        hint = hint ? `${hint} ${checkpointNote(steps, analysis)}` : checkpointNote(steps, analysis);
        emit({ type: 'checkpoint', steps, budget: analysis.softBudget });
      }
      const shown = hint ? (result.ok ? { ...result, result: { ...result.result, hint } } : { ...result, hint }) : result;
      let content = redactSecrets(formatResult(shown, maxResultChars));

      // Same call, same output, and the earlier output is still in context: do not send it twice.
      if (result.ok && !hint) {
        const digest = hashText(content);
        const prev = seen.get(signature);
        if (prev && prev.hash === digest && prev.msg.content === prev.full) {
          prev.count++;
          usage.dedupedResults++;
          content = JSON.stringify({ ok: true, result: { unchanged: true, summary: `Same result as your identical earlier ${call.name} call (still above in this conversation). Nothing changed; use that output instead of calling again.` } });
          if (prev.count >= REPEAT_LIMIT) stuck = true;
          emit({ type: 'deduped', name: call.name });
          messages.push(protocol.resultMessage(call, content));
          continue;
        }
        const msg = protocol.resultMessage(call, content);
        messages.push(msg);
        seen.set(signature, { hash: digest, msg, full: content, count: 1 });
        continue;
      }
      messages.push(protocol.resultMessage(call, content));
    }

    if (compressToolResults(messages, compression)) emit({ type: 'context_compressed' });
    if (signal?.aborted) return { content: '', stopReason: 'aborted', steps, usage };
    if (stuck) return { content: '', stopReason: 'stuck', steps, usage };
  }
}

export { AgentError };
