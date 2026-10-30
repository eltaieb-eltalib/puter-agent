import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

const DIR = '.puter-agent';
const FILE = 'memory.md';
const MAX_PROMPT_CHARS = 4000;
const MAX_NOTE = 400;

export const memoryPath = (workspace) => path.join(workspace, DIR, FILE);

export function readMemoryText(workspace) {
  try {
    return fsSync.readFileSync(memoryPath(workspace), 'utf8').trim();
  } catch {
    return '';
  }
}

/** Long-term notes for the system prompt (newest last, trimmed from the old end). */
export function loadMemory(workspace) {
  const text = readMemoryText(workspace);
  if (!text) return null;
  return text.length > MAX_PROMPT_CHARS ? `...${text.slice(-MAX_PROMPT_CHARS)}` : text;
}

export async function addMemory(workspace, note, now = new Date()) {
  const clean = String(note).replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);
  if (!clean) throw new Error('The note is empty.');
  const file = memoryPath(workspace);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const existing = readMemoryText(workspace).split('\n');
  if (existing.some((l) => l.endsWith(`] ${clean}`))) return { added: false, note: clean };
  await fs.appendFile(file, `- [${now.toISOString().slice(0, 10)}] ${clean}\n`, 'utf8');
  return { added: true, note: clean };
}

/** Delete every note that contains `text` (case-insensitive). Returns how many were removed. */
export async function forgetMemory(workspace, text) {
  const needle = String(text).toLowerCase().trim();
  if (!needle) return 0;
  const lines = readMemoryText(workspace).split('\n').filter(Boolean);
  const kept = lines.filter((l) => !l.toLowerCase().includes(needle));
  await fs.writeFile(memoryPath(workspace), kept.length ? `${kept.join('\n')}\n` : '', 'utf8');
  return lines.length - kept.length;
}

export async function clearMemory(workspace) {
  await fs.rm(memoryPath(workspace), { force: true });
}
