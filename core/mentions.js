import fs from 'node:fs';
import path from 'node:path';
import { isSensitivePath } from '../utils/redact.js';

const MAX_FILE_CHARS = 12000;
const MAX_TOTAL_CHARS = 40000;
const MENTION_RE = /(^|\s)@([^\s@]+)/g;

/**
 * "@src/app.js explain this" -> the message plus the file's content, like opencode's @file references.
 * Only files/folders INSIDE the workspace are attached (no approval prompts here); secret files are skipped.
 * Returns { text, attached: [relative paths] }.
 */
export function expandMentions(text, guard) {
  const attached = [];
  const blocks = [];
  let total = 0;
  for (const m of String(text).matchAll(MENTION_RE)) {
    const token = m[2].replace(/[.,;:!?)\]]+$/, '');
    if (!token || attached.includes(token)) continue;
    let resolved;
    try {
      resolved = guard.resolve(token);
    } catch {
      continue;
    }
    if (!resolved.inside || isSensitivePath(resolved.abs)) continue;
    let stat;
    try {
      stat = fs.statSync(resolved.abs);
    } catch {
      continue;
    }
    let body;
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(resolved.abs, { withFileTypes: true }).slice(0, 200).map((e) => e.name + (e.isDirectory() ? '/' : ''));
      body = entries.join('\n');
    } else {
      const buf = fs.readFileSync(resolved.abs);
      if (buf.subarray(0, 8000).includes(0)) continue;
      body = buf.toString('utf8');
      if (body.length > MAX_FILE_CHARS) body = `${body.slice(0, MAX_FILE_CHARS)}\n...[truncated]`;
    }
    if (total + body.length > MAX_TOTAL_CHARS) break;
    total += body.length;
    attached.push(token);
    const rel = path.relative(guard.root, resolved.abs).split(path.sep).join('/') || '.';
    blocks.push(`<${stat.isDirectory() ? 'folder' : 'file'} path="${rel}">\n${body}\n</${stat.isDirectory() ? 'folder' : 'file'}>`);
  }
  if (!blocks.length) return { text, attached };
  return { text: `${text}\n\n[Attached by @-mention]\n${blocks.join('\n')}`, attached };
}
