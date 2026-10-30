import { ToolError } from '../utils/errors.js';
import { addMemory, forgetMemory, readMemoryText } from '../core/memory.js';

const memoryWriteTool = {
  name: 'memory_write',
  description:
    'Save ONE short durable fact to long-term memory (kept between sessions in this workspace): a stable user preference, a project convention or a decision. Use it when the user says "remember ..." or states a lasting preference. Never store passwords, keys, tokens or temporary task details.',
  parameters: {
    type: 'object',
    properties: { note: { type: 'string', description: 'One short sentence (max ~400 chars).' } },
    required: ['note'],
  },
  async execute({ note }, ctx) {
    try {
      const res = await addMemory(ctx.guard.root, note);
      return { ...res, summary: res.added ? 'saved to memory' : 'already in memory' };
    } catch (err) {
      throw new ToolError(err.message);
    }
  },
};

const memoryReadTool = {
  name: 'memory_read',
  readOnly: true,
  description: 'Read the long-term memory notes of this workspace.',
  parameters: { type: 'object', properties: {} },
  async execute(_args, ctx) {
    const text = readMemoryText(ctx.guard.root);
    return { memory: text || '(empty)', summary: text ? `${text.split('\n').length} note(s)` : 'empty' };
  },
};

const memoryForgetTool = {
  name: 'memory_forget',
  description: 'Remove memory notes that contain the given text (use when the user asks you to forget something or a note is outdated).',
  parameters: {
    type: 'object',
    properties: { contains: { type: 'string', description: 'Text that identifies the note(s) to delete.' } },
    required: ['contains'],
  },
  async execute({ contains }, ctx) {
    const removed = await forgetMemory(ctx.guard.root, contains);
    return { removed, summary: `${removed} note(s) removed` };
  },
};

export const memoryTools = [memoryWriteTool, memoryReadTool, memoryForgetTool];
