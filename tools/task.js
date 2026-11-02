import { ToolError } from '../utils/errors.js';
import { buildSystemPrompt } from '../core/context.js';
import { runAgentLoop } from '../core/agent-loop.js';
import { getAgent } from '../core/agents.js';

const MAX_SUB_STEPS = 20;
const EXCLUDED = new Set(['task', 'ask_user', 'todo_write', 'todo_read', 'memory_write', 'memory_forget']);

const taskTool = {
  name: 'task',
  readOnly: true,
  cache: 'workspace',
  description:
    'Delegate a self-contained read-only research job to a sub-agent with a clean context; returns a report. Use for broad questions so your context stays small. The prompt must be complete: it does not see this chat.',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short title (3-6 words).' },
      prompt: { type: 'string', description: 'Full instructions, the exact question and what the report must contain.' },
      agent: { type: 'string', description: 'Custom sub-agent name from the system prompt (optional).' },
    },
    required: ['description', 'prompt'],
  },
  async execute({ description, prompt, agent }, ctx) {
    if (!ctx.provider || !ctx.registry) throw new ToolError('Sub-agents are not available in this context.');
    if (ctx.depth >= 1) throw new ToolError('A sub-agent cannot start another sub-agent.');
    const custom = agent ? getAgent(ctx.guard.root, agent) : null;
    if (agent && !custom) throw new ToolError(`Unknown sub-agent "${agent}". Omit "agent" or use one listed in the system prompt.`);
    const system = `${buildSystemPrompt({ workspace: ctx.guard.root, mode: 'plan' })}\n\n# You are a sub-agent\nYou were started by another agent for one job: "${description}". Investigate with read-only tools, then reply with a complete, concrete report (file paths, names, short evidence). Do not ask questions; make reasonable assumptions and say so.${custom ? `\n\n# Your role (${custom.name})\n${custom.instructions}` : ''}`;
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ];
    const names = ctx.registry.list().filter((t) => t.readOnly && !EXCLUDED.has(t.name)).map((t) => t.name);
    const subCtx = { ...ctx, mode: 'plan', depth: (ctx.depth ?? 0) + 1, changes: [], checkpoint: undefined, ask: undefined };
    const res = await runAgentLoop({
      provider: ctx.provider,
      model: ctx.settings.models?.subagent ?? ctx.model,
      messages,
      registry: ctx.registry,
      ctx: subCtx,
      maxSteps: ctx.settings.planning?.subagentMaxSteps ?? MAX_SUB_STEPS,
      protocol: ctx.settings.tools?.protocol ?? 'auto',
      maxTokens: ctx.settings.tokens?.subagent ?? ctx.settings.tokens?.maxOutput ?? undefined,
      retry: ctx.settings.retry,
      maxResultChars: ctx.settings.limits.maxToolResultChars,
      toolNames: names,
      context: ctx.settings.optimization ?? {},
      verify: false,
      signal: ctx.signal,
    });
    if (res.stopReason === 'aborted') throw new ToolError('The sub-agent was cancelled.');
    const report = res.content?.trim() || '(the sub-agent finished without a report)';
    return { report, steps: res.steps, summary: `sub-agent done (${res.steps} steps)` };
  },
};

export const taskTools = [taskTool];
