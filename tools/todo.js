import { ToolError } from '../utils/errors.js';

const STATUSES = ['pending', 'in_progress', 'completed'];

const todoWriteTool = {
  name: 'todo_write',
  readOnly: true,
  description:
    'Set the task checklist (send the COMPLETE list; it replaces the old one). For tasks with 3+ steps: one item in_progress, mark items completed when done. Not for simple questions.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'All items.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Short step.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content'],
        },
      },
    },
    required: ['todos'],
  },
  async execute({ todos }, ctx) {
    const clean = todos.map((t, i) => {
      const content = typeof t === 'string' ? t : t?.content;
      const status = typeof t === 'string' ? 'pending' : (t?.status ?? 'pending');
      if (typeof content !== 'string' || !content.trim()) throw new ToolError(`todos[${i}] needs a non-empty "content".`);
      if (!STATUSES.includes(status)) throw new ToolError(`todos[${i}].status must be one of: ${STATUSES.join(', ')}.`);
      return { content: content.trim(), status };
    });
    if (ctx.state) ctx.state.todos = clean;
    const done = clean.filter((t) => t.status === 'completed').length;
    return { todos: clean, summary: `${done}/${clean.length} done` };
  },
};

const todoReadTool = {
  name: 'todo_read',
  readOnly: true,
  description: 'Read the current task checklist (useful after a long conversation or when resuming).',
  parameters: { type: 'object', properties: {} },
  async execute(_args, ctx) {
    const todos = ctx.state?.todos ?? [];
    return { todos, summary: `${todos.length} item(s)` };
  },
};

const askUserTool = {
  name: 'ask_user',
  readOnly: true,
  description:
    'Ask the user ONE short question and wait for the answer. Only when truly ambiguous and a wrong guess is costly. Never for tool permission (the system asks itself) or things a sensible default settles.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question, in the user language.' },
      options: { type: 'array', items: { type: 'string' }, description: 'Suggested answers.' },
    },
    required: ['question'],
  },
  async execute({ question, options }, ctx) {
    if (!ctx.ask) throw new ToolError('Asking the user is not available in this session. Pick a sensible default and say so.');
    const opts = Array.isArray(options) ? options.filter((o) => typeof o === 'string') : [];
    const answer = await ctx.ask(question, opts);
    if (answer === null || answer === undefined || answer === '') {
      throw new ToolError('The user gave no answer. Continue with a sensible default and state your assumption.');
    }
    return { answer: String(answer), summary: 'answered' };
  },
};

export const todoTools = [todoWriteTool, todoReadTool, askUserTool];
