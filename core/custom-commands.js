import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join('.puter-agent', 'commands');

/**
 * Custom slash commands, like opencode's command files: every .puter-agent/commands/<name>.md in the
 * workspace becomes /<name>. The file is a prompt template; $ARGUMENTS is replaced by what follows the
 * command (or appended when the template has no $ARGUMENTS). An optional first line "# description" is
 * shown in /help.
 */
export function listCustomCommands(workspace) {
  const dir = path.join(workspace, DIR);
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!/^[a-z0-9_-]+\.md$/i.test(f)) continue;
    const name = f.slice(0, -3).toLowerCase();
    try {
      const text = fs.readFileSync(path.join(dir, f), 'utf8').trim();
      if (!text) continue;
      const first = text.split('\n')[0];
      out.push({ name, template: text, description: first.startsWith('#') ? first.replace(/^#+\s*/, '') : `Custom command (${f})` });
    } catch {
      /* unreadable file: skip */
    }
  }
  return out;
}

/** Returns the prompt to send to the agent for "/name args", or null if no such custom command. */
export function expandCustomCommand(workspace, line) {
  const m = String(line).match(/^\/(\S+)\s*(.*)$/s);
  if (!m) return null;
  const cmd = listCustomCommands(workspace).find((c) => c.name === m[1].toLowerCase());
  if (!cmd) return null;
  const args = m[2].trim();
  return cmd.template.includes('$ARGUMENTS') ? cmd.template.replaceAll('$ARGUMENTS', args) : args ? `${cmd.template}\n\n${args}` : cmd.template;
}
