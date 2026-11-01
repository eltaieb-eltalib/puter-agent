import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { ToolError } from '../utils/errors.js';
import { display, requireApproval, resolvePath } from './helpers.js';

const URL_RE = /^https?:\/\//i;

/** Spawn the platform opener detached; resolves once it started (or failed to). */
export function launchOpener(target, { isDir = false, platform = process.platform } = {}) {
  let file;
  let args;
  if (platform === 'win32') {
    if (isDir) [file, args] = ['explorer.exe', [target]];
    else [file, args] = ['rundll32', ['url.dll,FileProtocolHandler', target]];
  } else if (platform === 'darwin') {
    [file, args] = ['open', [target]];
  } else {
    [file, args] = ['xdg-open', [target]];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', (err) => reject(new ToolError(`Could not launch "${file}": ${err.message}`)));
    child.once('spawn', () => {
      child.unref();
      resolve({ opener: file });
    });
  });
}

const openPathTool = {
  name: 'open_path',
  description:
    'Open a file or folder with the computer\'s default application (e.g. a PDF viewer, a browser for .html, File Explorer for a folder), or open an http(s) URL in the default browser. Use it when the user asks to "open" something. To read a file\'s text yourself use read_file instead.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File or folder (relative to the workspace, or absolute anywhere), or an http(s) URL.' },
    },
    required: ['path'],
  },
  async execute({ path: target }, ctx) {
    if (URL_RE.test(target)) {
      await requireApproval(ctx, 'openPath', `Open URL in the default browser:\n    ${target}`);
      const { opener } = await launchOpener(target);
      return { opened: target, opener, summary: `opened ${target}` };
    }
    const abs = await resolvePath(ctx, target, 'open');
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch (err) {
      if (err.code === 'ENOENT') throw new ToolError(`Not found: ${target}`);
      throw err;
    }
    await requireApproval(ctx, 'openPath', `Open with the default application:\n    ${display(ctx, abs)}`);
    const { opener } = await launchOpener(abs, { isDir: stat.isDirectory() });
    return { opened: abs, type: stat.isDirectory() ? 'folder' : 'file', opener, summary: `opened ${display(ctx, abs)}` };
  },
};

const listDrivesTool = {
  name: 'list_drives',
  readOnly: true,
  description:
    'List the top-level places on this computer: drive letters on Windows (C:\\, D:\\ ...) or "/" on Linux/macOS, plus the user\'s home, Desktop, Documents and Downloads folders when they exist. Use it to find where to look before list_files on an absolute path.',
  parameters: { type: 'object', properties: {} },
  async execute(_args, ctx) {
    const roots = [];
    if (process.platform === 'win32') {
      for (let c = 65; c <= 90; c++) {
        const drive = `${String.fromCharCode(c)}:\\`;
        try {
          fs.accessSync(drive);
          roots.push(drive);
        } catch {
          /* drive not present */
        }
      }
    } else {
      roots.push('/');
    }
    const home = os.homedir();
    const places = { home };
    for (const name of ['Desktop', 'Documents', 'Downloads']) {
      const p = `${home}${process.platform === 'win32' ? '\\' : '/'}${name}`;
      if (fs.existsSync(p)) places[name.toLowerCase()] = p;
    }
    return { drives: roots, places, workspace: ctx.guard.root, summary: `${roots.length} root(s)` };
  },
};

export const systemTools = [openPathTool, listDrivesTool];
