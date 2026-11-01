import { ToolError } from '../utils/errors.js';
import { buildSystemPrompt } from '../core/context.js';
import { runAgentLoop } from '../core/agent-loop.js';
import { getAgent } from '../core/agents.js';

const MAX_SUB_STEPS = 20;
const EXCLUDED = new Set(['task', 'ask_user', 'todo_write', 'todo_read', 'memory_write', 'memory_forget']);

const taskTool = {
  name: 'task',
  readOnly: true,
  description:
    'Delegate a self-contained research job to a sub-agent with its own clean context (like opencode\'s "explore" agent). The sub-agent can read, search and browse but cannot change anything, and returns a written report. Use it for broad questions ("find where X is handled and summarise", "compare these 3 modules") so your own context stays small. Give it a complete prompt: it does not see this conversation.',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short title (3-6 words).' },
      prompt: { type: 'string', description: 'Full instructions and the exact question to answer. State what the report must contain.' },
      agent: { type: 'string', description: 'Optional: name of a custom sub-agent listed in the system prompt (its role instructions are added). Default: general explorer.' },
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
      model: ctx.model,
      messages,
      registry: ctx.registry,
      ctx: subCtx,
      maxSteps: MAX_SUB_STEPS,
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
