import fs from 'node:fs/promises';
import path from 'node:path';

const DIR = '.puter-agent';
const FILE = 'session.json';

export function sessionPath(workspace) {
  return path.join(workspace, DIR, FILE);
}

/** Save the conversation (without the system prompt, which is rebuilt on load). */
export async function saveSession(workspace, data) {
  const file = sessionPath(workspace);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), ...data }), 'utf8');
  return file;
}

export async function loadSession(workspace) {
  try {
    const data = JSON.parse(await fs.readFile(sessionPath(workspace), 'utf8'));
    return Array.isArray(data.messages) ? data : null;
  } catch {
    return null;
  }
}
