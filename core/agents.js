import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join('.puter-agent', 'agents');

/**
 * Custom sub-agents: .puter-agent/agents/<name>.md in the workspace. The file is the sub-agent's role
 * instructions; an optional first line "# description" says when to use it. Sub-agents are always read-only
 * (they can look and research but never change anything), so a project cannot grant them extra power.
 */
export function listAgents(workspace) {
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
    try {
      const text = fs.readFileSync(path.join(dir, f), 'utf8').trim().slice(0, 6000);
      if (!text) continue;
      const first = text.split('\n')[0];
      out.push({ name: f.slice(0, -3).toLowerCase(), instructions: text, description: first.startsWith('#') ? first.replace(/^#+\s*/, '') : `Custom agent (${f})` });
    } catch {
      /* unreadable: skip */
    }
  }
  return out;
}

export const getAgent = (workspace, name) => listAgents(workspace).find((a) => a.name === String(name ?? '').toLowerCase()) ?? null;
