import { filesystemTools } from './filesystem.js';
import { terminalTools } from './terminal.js';
import { systemTools } from './system.js';
import { taskTools } from './task.js';
import { webTools } from './web.js';
import { todoTools } from './todo.js';
import { memoryTools } from './memory.js';
import { projectTools } from './project.js';
import { ToolRegistry } from './registry.js';

/** Registry with every built-in tool. */
export function createDefaultRegistry() {
  return new ToolRegistry().registerAll([...filesystemTools, ...webTools, ...todoTools, ...memoryTools, ...terminalTools, ...systemTools, ...taskTools, ...projectTools]);
}
