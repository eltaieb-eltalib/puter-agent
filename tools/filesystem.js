import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../utils/errors.js';
import { isSensitivePath } from '../utils/redact.js';
import { display, recordChange, requireApproval, resolvePath } from './helpers.js';

const IGNORED_DIRS = new Set(['node_modules', '.git', '.hg', '.svn']);
const MAX_SEARCH_FILE_BYTES = 1_000_000;

const exists = async (p) => {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
};
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

const readFileTool = {
  name: 'read_file',
  readOnly: true,
  description:
    'Read a text file from the workspace. Returns its content. For big files use start_line/end_line (1-based, inclusive) to read a slice.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace root.' },
      start_line: { type: 'integer', description: 'First line to return (1-based).' },
      end_line: { type: 'integer', description: 'Last line to return (inclusive).' },
    },
    required: ['path'],
  },
  async execute({ path: p, start_line, end_line }, ctx) {
    const abs = await resolvePath(ctx, p, 'read');
    if (isSensitivePath(abs)) {
      await requireApproval(ctx, 'readSecret', `Read a file that may contain secrets: ${display(ctx, abs)}\n    (secret values are masked before the model sees them)`);
    }
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) throw new ToolError(`"${p}" is a directory. Use list_files instead.`);

    const max = ctx.settings.limits.maxReadBytes;
    const ranged = start_line !== undefined || end_line !== undefined;
    const cap = ranged ? max * 10 : max;
    const size = Math.min(stat.size, cap);
    const buf = Buffer.alloc(size);
    const handle = await fs.open(abs, 'r');
    try {
      await handle.read(buf, 0, size, 0);
    } finally {
      await handle.close();
    }
    if (isBinary(buf)) throw new ToolError(`"${p}" looks like a binary file; refusing to read it as text.`);

    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/);
    const truncated = stat.size > cap;
    if (!ranged) {
      return {
        path: display(ctx, abs),
        content: text,
        total_lines: lines.length,
        truncated,
        ...(truncated && {
          note: `File is ${stat.size} bytes; only the first ${cap} are shown. Use start_line/end_line for a specific section.`,
        }),
        summary: `${lines.length} lines${truncated ? ' (truncated)' : ''}`,
      };
    }
    const from = Math.max(1, start_line ?? 1);
    const to = Math.min(lines.length, end_line ?? lines.length);
    return {
      path: display(ctx, abs),
      start_line: from,
      end_line: to,
      content: lines.slice(from - 1, to).join('\n'),
      total_lines: lines.length,
      truncated,
      summary: `lines ${from}-${to}`,
    };
  },
};

const createFileTool = {
  name: 'create_file',
  description:
    'Create a new file with the given full content (parent folders are created automatically). Fails if the file already exists unless overwrite=true; prefer edit_file for changing existing files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace root.' },
      content: { type: 'string', description: 'Complete file content.' },
      overwrite: {
        type: 'boolean',
        description: 'Replace the file if it exists (needs user approval). Default false.',
      },
    },
    required: ['path', 'content'],
  },
  async execute({ path: p, content, overwrite = false }, ctx) {
    const abs = await resolvePath(ctx, p, 'create a file at');
    if (ctx.guard.isRoot(abs)) throw new ToolError('Cannot write to the workspace root itself.');
    const already = await exists(abs);
    if (already && !overwrite) {
      throw new ToolError(
        `"${display(ctx, abs)}" already exists. Use edit_file to modify it, or pass overwrite=true for a full rewrite.`,
      );
    }
    if (already) await requireApproval(ctx, 'overwriteFile', `Overwrite existing file: ${display(ctx, abs)}`);
    else await requireApproval(ctx, 'createFile', `Create file: ${display(ctx, abs)}`);

    await ctx.checkpoint?.protect(abs);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    recordChange(ctx, already ? 'overwritten' : 'created', abs);
    const bytes = Buffer.byteLength(content, 'utf8');
    return {
      path: display(ctx, abs),
      bytes,
      created: !already,
      summary: `${already ? 'overwritten' : 'created'} (${bytes} bytes)`,
    };
  },
};

const editFileTool = {
  name: 'edit_file',
  description:
    'Edit an existing file by replacing exact text. old_string must match the file exactly (including whitespace) and be unique unless replace_all=true. Read the file first.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace root.' },
      old_string: { type: 'string', description: 'Exact text to replace.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute({ path: p, old_string, new_string, replace_all = false }, ctx) {
    if (old_string === '') throw new ToolError('old_string must not be empty (use create_file for new files).');
    if (old_string === new_string) throw new ToolError('old_string and new_string are identical; nothing to change.');

    const abs = await resolvePath(ctx, p, 'edit a file at');
    let original;
    try {
      original = await fs.readFile(abs, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') throw new ToolError(`File not found: ${p}. Use create_file to create it.`);
      throw err;
    }
    if (original.includes('\0')) throw new ToolError(`"${p}" looks like a binary file.`);

    // Match on LF-normalised text, then restore the file's original CRLF endings (Windows).
    const crlf = original.includes('\r\n');
    const text = crlf ? original.replace(/\r\n/g, '\n') : original;
    const oldText = old_string.replace(/\r\n/g, '\n');
    const newText = new_string.replace(/\r\n/g, '\n');

    const count = text.split(oldText).length - 1;
    if (count === 0) {
      throw new ToolError(
        'old_string was not found in the file. Re-read it with read_file and copy the exact text, including indentation.',
      );
    }
    if (count > 1 && !replace_all) {
      throw new ToolError(
        `old_string matches ${count} places. Include more surrounding context to make it unique, or set replace_all=true.`,
      );
    }

    let updated = replace_all ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
    if (crlf) updated = updated.replace(/\n/g, '\r\n');

    const replacements = replace_all ? count : 1;
    await requireApproval(ctx, 'editFile', `Edit file: ${display(ctx, abs)} (${replacements} replacement(s))`);
    await ctx.checkpoint?.protect(abs);
    await fs.writeFile(abs, updated, 'utf8');
    recordChange(ctx, 'edited', abs);
    return {
      path: display(ctx, abs),
      replacements,
      summary: `edited (${replacements} replacement${replacements === 1 ? '' : 's'})`,
    };
  },
};

const deleteFileTool = {
  name: 'delete_file',
  description:
    'Delete ONE file. Always requires user approval. Directories and wildcards are not supported.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'File path, relative to the workspace root.' } },
    required: ['path'],
  },
  async execute({ path: p }, ctx) {
    const abs = await resolvePath(ctx, p, 'delete a file at');
    let stat;
    try {
      stat = await fs.lstat(abs);
    } catch (err) {
      if (err.code === 'ENOENT') throw new ToolError(`File not found: ${p}`);
      throw err;
    }
    if (stat.isDirectory()) throw new ToolError('delete_file only removes single files, not directories.');
    await requireApproval(ctx, 'deleteFile', `DELETE file: ${display(ctx, abs)}`);
    await ctx.checkpoint?.protect(abs);
    await fs.unlink(abs);
    recordChange(ctx, 'deleted', abs);
    return { path: display(ctx, abs), summary: 'deleted' };
  },
};

const listFilesTool = {
  name: 'list_files',
  readOnly: true,
  description:
    'List files and folders in a directory (folders end with "/"). Use recursive=true to walk subfolders (node_modules and .git are skipped).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory, relative to the workspace root. Default ".".' },
      recursive: { type: 'boolean', description: 'Include subfolders. Default false.' },
      max_entries: { type: 'integer', description: 'Maximum entries to return (default 300, max 1000).' },
    },
  },
  async execute({ path: p = '.', recursive = false, max_entries = 300 }, ctx) {
    const abs = await resolvePath(ctx, p, 'list');
    const limit = Math.min(Math.max(1, max_entries), 1000);
    const entries = [];
    let truncated = false;

    async function walk(dir, prefix, depth) {
      const items = await fs.readdir(dir, { withFileTypes: true });
      items.sort((a, b) => a.name.localeCompare(b.name));
      for (const item of items) {
        if (entries.length >= limit) {
          truncated = true;
          return;
        }
        const isDir = item.isDirectory();
        entries.push(`${prefix}${item.name}${isDir ? '/' : ''}`);
        if (recursive && isDir && !IGNORED_DIRS.has(item.name) && depth < 8) {
          await walk(path.join(dir, item.name), `${prefix}${item.name}/`, depth + 1);
          if (truncated) return;
        }
      }
    }
    await walk(abs, '', 0);
    return {
      path: display(ctx, abs),
      entries,
      truncated,
      summary: `${entries.length} entries${truncated ? ' (truncated)' : ''}`,
    };
  },
};

const createDirectoryTool = {
  name: 'create_directory',
  description: 'Create a directory (and any missing parents). Succeeds quietly if it already exists.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory, relative to the workspace root.' } },
    required: ['path'],
  },
  async execute({ path: p }, ctx) {
    const abs = await resolvePath(ctx, p, 'create a directory at');
    const already = await exists(abs);
    if (!already) {
      await requireApproval(ctx, 'createDirectory', `Create directory: ${display(ctx, abs)}`);
      await fs.mkdir(abs, { recursive: true });
      recordChange(ctx, 'created-dir', abs);
    }
    return { path: display(ctx, abs), created: !already, summary: already ? 'already exists' : 'created' };
  },
};

const moveFileTool = {
  name: 'move_file',
  description:
    'Move or rename a file or folder. Fails if the destination already exists. Requires user approval.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Existing path, relative to the workspace root.' },
      to: { type: 'string', description: 'New path, relative to the workspace root.' },
    },
    required: ['from', 'to'],
  },
  async execute({ from, to }, ctx) {
    const src = await resolvePath(ctx, from, 'move');
    const dest = await resolvePath(ctx, to, 'move into');
    if (ctx.guard.isRoot(src)) throw new ToolError('Cannot move the workspace root.');
    if (!(await exists(src))) throw new ToolError(`Source not found: ${from}`);
    if (await exists(dest)) {
      throw new ToolError(`Destination already exists: ${to}. Choose another name; moving never overwrites.`);
    }
    await requireApproval(ctx, 'moveFile', `Move: ${display(ctx, src)}  ->  ${display(ctx, dest)}`);
    await ctx.checkpoint?.protect(src);
    await ctx.checkpoint?.protect(dest);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(src, dest);
    recordChange(ctx, 'moved', dest);
    return { from: display(ctx, src), to: display(ctx, dest), summary: 'moved' };
  },
};

const searchFilesTool = {
  name: 'search_files',
  readOnly: true,
  description:
    'Search text inside files under a directory (skips node_modules, .git, binary and very large files). Returns file, line number and the matching line.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text to find (or a regular expression if regex=true).' },
      path: { type: 'string', description: 'Directory or file to search. Default ".".' },
      regex: { type: 'boolean', description: 'Treat query as a regular expression. Default false.' },
      case_sensitive: { type: 'boolean', description: 'Default false.' },
      max_results: { type: 'integer', description: 'Maximum matches (default 100, max 500).' },
    },
    required: ['query'],
  },
  async execute({ query, path: p = '.', regex = false, case_sensitive = false, max_results = 100 }, ctx) {
    if (query === '') throw new ToolError('query must not be empty.');
    const abs = await resolvePath(ctx, p, 'search');
    const limit = Math.min(Math.max(1, max_results), 500);

    let test;
    if (regex) {
      let re;
      try {
        re = new RegExp(query, case_sensitive ? '' : 'i');
      } catch (err) {
        throw new ToolError(`Invalid regular expression: ${err.message}`);
      }
      test = (line) => re.test(line);
    } else {
      const needle = case_sensitive ? query : query.toLowerCase();
      test = (line) => (case_sensitive ? line : line.toLowerCase()).includes(needle);
    }

    const matches = [];
    let truncated = false;

    async function searchFile(file, explicit = false) {
      if (!explicit && isSensitivePath(file)) return; // never grep credentials files by accident
      const stat = await fs.stat(file);
      if (stat.size > MAX_SEARCH_FILE_BYTES) return;
      const buf = await fs.readFile(file);
      if (isBinary(buf)) return;
      const lines = buf.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!test(lines[i])) continue;
        if (matches.length >= limit) {
          truncated = true;
          return;
        }
        matches.push({ file: display(ctx, file), line: i + 1, text: lines[i].trim().slice(0, 200) });
      }
    }

    async function walk(dir) {
      const items = await fs.readdir(dir, { withFileTypes: true });
      items.sort((a, b) => a.name.localeCompare(b.name));
      for (const item of items) {
        if (truncated) return;
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          if (!IGNORED_DIRS.has(item.name)) await walk(full);
        } else if (item.isFile()) {
          await searchFile(full);
        }
      }
    }

    const stat = await fs.stat(abs);
    if (stat.isDirectory()) await walk(abs);
    else await searchFile(abs, true);
    return { matches, truncated, summary: `${matches.length} match(es)${truncated ? ' (truncated)' : ''}` };
  },
};

export const filesystemTools = [
  readFileTool,
  createFileTool,
  editFileTool,
  deleteFileTool,
  listFilesTool,
  createDirectoryTool,
  moveFileTool,
  searchFilesTool,
];
