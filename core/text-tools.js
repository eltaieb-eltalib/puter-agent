/**
 * Fallback for weaker models that print their tool calls as JSON text instead of using
 * native function calling, e.g.  {"tool":"web_search","args":{"query":"..."}}
 * We recognise those objects (only for tools that really exist), run them like normal
 * tool calls and remove them from the visible text.
 */

function balancedEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

export function extractTextToolCalls(content, registry) {
  if (!content || !content.includes('{')) return { calls: [], text: content ?? '' };
  const calls = [];
  const spans = [];
  let i = 0;
  while (i < content.length) {
    const open = content.indexOf('{', i);
    if (open === -1) break;
    const end = balancedEnd(content, open);
    if (end === -1) break;
    let obj = null;
    try {
      obj = JSON.parse(content.slice(open, end + 1));
    } catch {
      /* not JSON: keep scanning inside it */
    }
    const name = obj && (obj.tool ?? obj.name ?? obj.function?.name);
    if (obj && typeof name === 'string' && registry.has(name)) {
      let args = obj.args ?? obj.arguments ?? obj.parameters ?? obj.input ?? obj.function?.arguments ?? {};
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      const rawArguments = JSON.stringify(args);
      calls.push({ id: `txt_${Date.now()}_${calls.length}`, name, arguments: args, rawArguments });
      spans.push([open, end + 1]);
      i = end + 1;
    } else {
      i = open + 1;
    }
  }
  if (!calls.length) return { calls, text: content };
  let text = '';
  let last = 0;
  for (const [a, b] of spans) {
    text += content.slice(last, a);
    last = b;
  }
  text += content.slice(last);
  text = text.replace(/```[a-z]*\s*```/gi, '').replace(/\n{3,}/g, '\n\n').trim();
  return { calls, text };
}
