// Project-understanding tools backed by the incremental index (core/project-index.js).
// They return compact facts (paths, line numbers, counts), never whole files.

import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../utils/errors.js';
import { getProjectIndex } from '../core/project-index.js';
import { listZip, readZipEntry } from '../utils/zip.js';
import { display, resolvePath } from './helpers.js';
import { isInside } from '../security/path-guard.js';

const indexFor = (ctx) => getProjectIndex(ctx.guard.root);

const projectOverviewTool = {
  name: 'project_overview',
  readOnly: true,
  description: 'Index the workspace (incremental, skips node_modules/.git/build dirs) and return languages, folder tree with file counts, key files, entry points and most-imported modules. No file contents. Start here in an unfamiliar project.',
  parameters: { type: 'object', properties: {} },
  async execute(_args, ctx) {
    const index = indexFor(ctx);
    const scan = await index.scan({ signal: ctx.signal });
    const o = index.overview();
    const changed = scan.first ? null : scan.changes.added.length + scan.changes.modified.length + scan.changes.removed.length;
    return { ...o, root: undefined, changed_since_last_scan: changed, summary: `${o.files} files, ${o.languages.slice(0, 3).map((l) => l.name).join('/') || 'no code'}${changed ? `, ${changed} changed` : ''}` };
  },
};

const findSymbolTool = {
  name: 'find_symbol',
  readOnly: true,
  description: 'Find where a function/class/type/const is defined (file:line), from the project index. references=true also lists usages. Cheaper than reading files to locate code.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Symbol name (exact or part of it).' },
      kind: { type: 'string', enum: ['function', 'class', 'method', 'type', 'const'], description: 'Filter by kind.' },
      references: { type: 'boolean', description: 'Also list usages (word match). Default false.' },
    },
    required: ['name'],
  },
  async execute({ name, kind, references = false }, ctx) {
    if (!name.trim()) throw new ToolError('name must not be empty.');
    const index = indexFor(ctx);
    await index.scan({ signal: ctx.signal });
    const definitions = index.findSymbol(name.trim(), { kind });
    const out = { definitions, summary: `${definitions.length} definition(s)` };
    if (references) {
      const re = new RegExp(`(?<![\\w$])${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`);
      const refs = [];
      for (const [rel, f] of index.files) {
        if (refs.length >= 60) break;
        if (!f.lang || f.size > 512 * 1024) continue;
        const abs = path.join(index.root, rel);
        let text;
        try {
          text = ctx.cache?.enabled ? (await ctx.cache.files.read(abs)).text : await fs.readFile(abs, 'utf8');
        } catch {
          continue;
        }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length && refs.length < 60; i++) {
          if (!re.test(lines[i])) continue;
          if (definitions.some((d) => d.file === rel && d.line === i + 1)) continue;
          refs.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 140) });
        }
      }
      out.references = refs;
      out.summary += `, ${refs.length} reference(s)${refs.length >= 60 ? ' (capped)' : ''}`;
    }
    return out;
  },
};

const fileRelationsTool = {
  name: 'file_relations',
  readOnly: true,
  description: 'For one source file: what it imports, which files import it, and its definitions with line numbers (from the index). Use before changing a module to see what depends on it.',
  parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path (workspace-relative).' } }, required: ['path'] },
  async execute({ path: p }, ctx) {
    const abs = await resolvePath(ctx, p, 'inspect');
    if (!isInside(ctx.guard.root, abs)) throw new ToolError('file_relations only works inside the workspace.');
    const index = indexFor(ctx);
    await index.scan({ signal: ctx.signal });
    const rel = display(ctx, abs);
    const info = index.relations(rel);
    if (!info) throw new ToolError(`"${rel}" is not in the project index (missing, ignored or binary).`);
    return { ...info, summary: `${info.imports.length} import(s), imported by ${info.imported_by.length}` };
  },
};

const changedFilesTool = {
  name: 'changed_files',
  readOnly: true,
  description: 'Files added, modified or removed since the previous index scan (content-hash based, works without git). Use to re-check only what changed instead of re-reading the project.',
  parameters: { type: 'object', properties: {} },
  async execute(_args, ctx) {
    const index = indexFor(ctx);
    const scan = await index.scan({ signal: ctx.signal });
    if (scan.first) return { first_scan: true, files: scan.files, added: [], modified: [], removed: [], summary: `first scan: ${scan.files} files indexed` };
    const { added, modified, removed } = scan.changes;
    return { added: added.slice(0, 100), modified: modified.slice(0, 100), removed: removed.slice(0, 100), summary: `${added.length} added, ${modified.length} modified, ${removed.length} removed` };
  },
};

const readZipTool = {
  name: 'read_zip',
  readOnly: true,
  description: 'Inspect a .zip without extracting it: no entry = list contents (name, size); entry = read that file as text (start_line/end_line for slices).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'ZIP file path.' },
      entry: { type: 'string', description: 'File inside the archive to read.' },
      start_line: { type: 'integer', description: 'First line (1-based).' },
      end_line: { type: 'integer', description: 'Last line (inclusive).' },
    },
    required: ['path'],
  },
  async execute({ path: p, entry, start_line, end_line }, ctx) {
    const abs = await resolvePath(ctx, p, 'read');
    let entries;
    try {
      entries = await listZip(abs);
    } catch (err) {
      throw new ToolError(`${p}: ${err.message}`);
    }
    if (!entry) {
      const files = entries.filter((e) => !e.dir);
      const shown = files.slice(0, 300).map((e) => ({ name: e.name, size: e.size }));
      return { path: display(ctx, abs), entries: shown, total_files: files.length, total_bytes: files.reduce((n, e) => n + e.size, 0), truncated: files.length > shown.length, summary: `${files.length} file(s) in archive` };
    }
    const max = ctx.settings.limits.maxReadBytes;
    let res;
    try {
      res = await readZipEntry(abs, entry, { maxBytes: max });
    } catch (err) {
      throw new ToolError(err.code === 'ENTRY_NOT_FOUND' ? `${err.message} Call read_zip without "entry" to list the contents.` : err.message);
    }
    if (res.data.subarray(0, 8000).includes(0)) throw new ToolError(`"${entry}" is binary; only text entries can be read.`);
    const lines = res.data.toString('utf8').split(/\r?\n/);
    const from = Math.max(1, start_line ?? 1);
    const to = Math.min(lines.length, end_line ?? lines.length);
    return { path: display(ctx, abs), entry: res.entry.name, start_line: from, end_line: to, total_lines: lines.length, content: lines.slice(from - 1, to).join('\n'), truncated: res.truncated, summary: `${res.entry.name}: lines ${from}-${to}${res.truncated ? ' (truncated)' : ''}` };
  },
};

export const projectTools = [projectOverviewTool, findSymbolTool, fileRelationsTool, changedFilesTool, readZipTool];
