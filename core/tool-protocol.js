// Tool-calling compatibility layer. Not every model supports native function calling, so the loop
// talks to the model through one of three protocols:
//
//   native - provider `tools` parameter + tool_calls/tool messages (default). Text-printed JSON tool
//            calls from weak models are still recovered (see text-tools.js).
//   json   - no `tools` parameter; the model must answer with ONE JSON object:
//              {"tool":"name","args":{...}}  |  {"tool_calls":[{"tool":..,"args":..}]}  |  {"final":"answer"}
//            Providers that support it are asked for JSON output (responseFormat: 'json').
//   prompt - like json, but the model may also reply in plain text (plain text = final answer).
//
// In json/prompt mode, tool results go back as user messages, so the history is valid for APIs
// that have no "tool" role at all.

import { extractTextToolCalls } from './text-tools.js';

export const PROTOCOLS = ['native', 'json', 'prompt'];

const typeLabel = (spec = {}) => (spec.enum ? spec.enum.map((v) => JSON.stringify(v)).join('|') : spec.type === 'array' ? `${spec.items?.type ?? 'any'}[]` : spec.type ?? 'any');

/** Very compact one-line-per-tool catalog for json/prompt mode. */
export function toolCatalog(defs) {
  return defs
    .map(({ function: f }) => {
      const props = f.parameters?.properties ?? {};
      const req = new Set(f.parameters?.required ?? []);
      const args = Object.entries(props).map(([k, s]) => `${k}${req.has(k) ? '' : '?'}:${typeLabel(s)}`).join(', ');
      return `- ${f.name}(${args}): ${f.description}`;
    })
    .join('\n');
}

function instructions(defs, strictJson) {
  return `\n\n# Tool protocol (your model has no native function calling)
To use a tool, reply with ONLY a JSON object, nothing else:
{"tool":"<name>","args":{...}}
Several independent tools at once: {"tool_calls":[{"tool":"<name>","args":{...}}, ...]}
${strictJson ? 'When you are done, reply {"final":"<your answer to the user>"}.' : 'When you are done, reply with your final answer as normal text (no JSON).'}
Tool results arrive in messages starting with [tool_result]. Available tools ("?" = optional):
${toolCatalog(defs)}`;
}

function parseFinal(content) {
  const text = String(content ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  if (!text.startsWith('{')) return null;
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && typeof (obj.final ?? obj.answer) === 'string') return obj.final ?? obj.answer;
  } catch {
    /* not a final object */
  }
  return null;
}

/** Flatten {"tool_calls":[...]} into separate {"tool":..} objects so extractTextToolCalls finds them. */
function expandToolCalls(content) {
  const text = String(content ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    const obj = JSON.parse(text);
    if (Array.isArray(obj?.tool_calls)) return obj.tool_calls.map((c) => JSON.stringify({ tool: c.tool ?? c.name, args: c.args ?? c.arguments ?? {} })).join('\n');
  } catch {
    /* plain text or single object */
  }
  return content;
}

export function createProtocol(name = 'native') {
  const mode = PROTOCOLS.includes(name) ? name : 'native';
  const native = mode === 'native';
  return {
    name: mode,

    /** What to send: tool definitions for native mode, or a catalog appended to the system prompt. */
    request(messages, defs) {
      if (native || !defs.length) return { messages, tools: native ? defs : [], responseFormat: undefined };
      const [system, ...rest] = messages;
      const withCatalog = system?.role === 'system' ? [{ ...system, content: `${system.content}${instructions(defs, mode === 'json')}` }, ...rest] : messages;
      return { messages: withCatalog, tools: [], responseFormat: mode === 'json' ? 'json' : undefined };
    },

    /** Normalise a provider reply into { content, toolCalls, message, textCalls }. */
    parse(reply, registry) {
      if (native) {
        if (reply.toolCalls.length || !reply.content) return { ...reply, textCalls: 0 };
        const found = extractTextToolCalls(reply.content, registry);
        if (!found.calls.length) return { ...reply, textCalls: 0 };
        return {
          ...reply,
          content: found.text,
          toolCalls: found.calls,
          textCalls: found.calls.length,
          message: {
            role: 'assistant',
            content: found.text,
            tool_calls: found.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArguments } })),
          },
        };
      }
      const final = parseFinal(reply.content);
      if (final !== null) return { ...reply, content: final, toolCalls: [], textCalls: 0, message: { role: 'assistant', content: final } };
      const found = extractTextToolCalls(expandToolCalls(reply.content), registry);
      return { ...reply, content: found.calls.length ? found.text : reply.content, toolCalls: found.calls, textCalls: 0, message: { role: 'assistant', content: String(reply.content ?? '') } };
    },

    /** History entry for one tool result. */
    resultMessage(call, content) {
      if (native) return { role: 'tool', tool_call_id: call.id, content };
      return { role: 'user', content: `[tool_result ${call.name} ${call.id}]\n${content}` };
    },
  };
}

/** Errors meaning "this model/endpoint does not support native tools" -> switch to prompt mode. */
export function isToolsUnsupported(err) {
  const msg = String(err?.message ?? err ?? '');
  return /(?:does not|doesn't|not) support (?:tools|tool[ _]?(?:use|calling|choice)|function[ _]?calling|functions)|tools? (?:is|are) not supported|unsupported (?:parameter|field)[^.]*\btools?\b|unknown (?:parameter|field)[^.]*\btools?\b|function calling is not (?:enabled|available)/i.test(msg);
}
