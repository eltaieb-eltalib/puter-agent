// Long conversations: summarise the old part instead of silently losing it.

const SUMMARY_PROMPT =
  'You compress an agent conversation. Write a compact summary (max 350 words, same language as the user) with: the user goals, decisions made, files created/changed (with paths), commands run and their outcome, open problems, and facts the user stated. Keep exact names, paths, numbers. No filler.';

const size = (m) => (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
export const totalChars = (messages) => messages.reduce((n, m) => n + size(m), 0);

function transcript(messages, perMessage = 700) {
  return messages
    .map((m) => {
      const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      const calls = m.tool_calls?.map((c) => `${c.function.name}(${String(c.function.arguments).slice(0, 160)})`).join('; ');
      const text = `${body.slice(0, perMessage)}${body.length > perMessage ? '…' : ''}${calls ? ` [calls: ${calls}]` : ''}`;
      return `${m.role.toUpperCase()}: ${text}`;
    })
    .join('\n');
}

/**
 * If the history is bigger than `limit` characters, replace everything before the last `keepTurns`
 * user messages with a summary (merged into the first kept user message, so the history stays valid).
 * messages[0] is the system prompt and is untouched. Returns true when something was compacted.
 */
export async function compactHistory({ messages, provider, model, limit = 120000, keepTurns = 2, signal }) {
  if (totalChars(messages) <= limit) return false;
  const userIdx = [];
  messages.forEach((m, i) => i > 0 && m.role === 'user' && userIdx.push(i));
  if (userIdx.length <= keepTurns) return false;
  const cut = userIdx[userIdx.length - keepTurns];
  const old = messages.slice(1, cut);
  if (!old.length) return false;

  let summary;
  try {
    const reply = await provider.chat({
      model,
      messages: [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: transcript(old) },
      ],
      tools: [],
      signal,
    });
    summary = String(reply.content ?? '').trim();
  } catch {
    summary = '';
  }
  if (!summary) summary = `(automatic summary unavailable; ${old.length} older messages were dropped)\n${transcript(old, 160).slice(-3000)}`;

  const first = messages[cut];
  const merged = { ...first, content: `[Summary of the earlier conversation]\n${summary}\n\n[Current request]\n${first.content}` };
  messages.splice(1, cut - 1, merged);
  // `merged` replaced messages[1..cut]; remove the now-duplicated original user message that followed
  messages.splice(2, 1);
  return true;
}
