import { AgentError, ErrorKind, classifyError, registerSecret } from '../utils/errors.js';

export class AnthropicProvider {
  name = 'anthropic';
  constructor({ apiKey = process.env.ANTHROPIC_API_KEY, timeoutMs = 120000 } = {}) {
    if (!apiKey) throw new AgentError('Missing ANTHROPIC_API_KEY. Add it to .env.', { kind: ErrorKind.AUTH });
    registerSecret(apiKey); this.apiKey = apiKey; this.timeoutMs = timeoutMs;
  }
  async connect() {}
  async listModels() { return ['claude-sonnet-4-5','claude-opus-4-1','claude-haiku-4-5'].map(id => ({ id, provider:this.name })); }
  async chat({ model = 'claude-sonnet-4-5', messages = [], tools = [], signal } = {}) {
    if (signal?.aborted) throw new AgentError('Request cancelled.', { kind: ErrorKind.ABORTED });
    const system = messages.filter(m => m.role === 'system').map(m => String(m.content ?? '')).join('\n\n');
    const body = { model, max_tokens:8192, ...(system ? { system } : {}), messages:messages.filter(m => m.role !== 'system').map(m => m.role === 'tool' ? ({ role:'user', content:[{ type:'tool_result', tool_use_id:m.tool_call_id, content:String(m.content ?? '') }] }) : ({ role:m.role === 'assistant' ? 'assistant' : 'user', content:Array.isArray(m.content) ? m.content : String(m.content ?? '') })), ...(tools.length ? { tools:tools.filter(t => t?.type === 'function').map(t => ({ name:t.function.name, description:t.function.description ?? '', input_schema:t.function.parameters ?? {type:'object',properties:{}} })) } : {}) };
    const timeout = AbortSignal.timeout(this.timeoutMs); const combined = signal ? AbortSignal.any([signal,timeout]) : timeout;
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages',{ method:'POST', headers:{ 'x-api-key':this.apiKey, 'anthropic-version':'2023-06-01', 'content-type':'application/json' }, body:JSON.stringify(body), signal:combined });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new AgentError(`Anthropic API error: ${payload.error?.message ?? `HTTP ${res.status}`}`, { kind:res.status === 401 || res.status === 403 ? ErrorKind.AUTH : res.status === 429 ? ErrorKind.RATE_LIMIT : res.status >= 500 ? ErrorKind.SERVER : ErrorKind.BAD_REQUEST });
      const content = (payload.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
      const toolCalls = (payload.content ?? []).filter(x => x.type === 'tool_use').map(x => ({ id:x.id, name:x.name, arguments:x.input ?? {}, rawArguments:JSON.stringify(x.input ?? {}) }));
      return { content, toolCalls, message:{ role:'assistant', content:payload.content ?? [{ type:'text', text:content }] }, usage:payload.usage ? { prompt_tokens:payload.usage.input_tokens, completion_tokens:payload.usage.output_tokens, total_tokens:(payload.usage.input_tokens ?? 0)+(payload.usage.output_tokens ?? 0) } : undefined };
    } catch(err) {
      if (signal?.aborted) throw new AgentError('Request cancelled.',{kind:ErrorKind.ABORTED,cause:err});
      if (timeout.aborted) throw new AgentError(`Anthropic request timed out after ${this.timeoutMs} ms.`,{kind:ErrorKind.TIMEOUT,cause:err});
      if (err instanceof AgentError) throw err; throw classifyError(err);
    }
  }
}
