import { filesystemTools } from './filesystem.js';
import { terminalTools } from './terminal.js';
import { webTools } from './web.js';
import { todoTools } from './todo.js';
import { memoryTools } from './memory.js';
import { ToolRegistry } from './registry.js';

/** Registry with every built-in tool. */
export function createDefaultRegistry() {
  return new ToolRegistry().registerAll([...filesystemTools, ...webTools, ...todoTools, ...memoryTools, ...terminalTools]);
}
