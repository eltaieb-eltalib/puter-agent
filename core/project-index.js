// Incremental project index: the agent understands a codebase without sending files to the model.
//
// One async walk records, per file: size, mtime, content hash, language, definitions (symbols with
// line numbers) and imports. The index is saved in <workspace>/.puter-agent/index.json; the next
// scan only re-reads files whose mtime/size changed, so re-scanning a large project is cheap, and
// the difference between two scans is exactly "what changed since last time".

import fs from 'node:fs/promises';
import path from 'node:path';
import { hashText } from './cache.js';

export const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.puter-agent', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.cache',
  '.turbo', '.parcel-cache', '__pycache__', '.pytest_cache', '.mypy_cache', '.venv', 'venv', 'env', 'target', '.idea', '.vscode', 'tmp', '.tmp',
]);
const IGNORED_FILES = /(?:^\.DS_Store$|\.log$|\.tmp$|\.swp$|~$|\.lock$|^package-lock\.json$|^yarn\.lock$|^pnpm-lock\.yaml$|\.min\.(?:js|css)$|\.map$)/i;
const MAX_PARSE_BYTES = 512 * 1024;
const MAX_FILES = 20000;
const CONCURRENCY = 16;
const INDEX_VERSION = 2;

const LANG = {
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript',
  py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', cs: 'C#', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++',
  php: 'PHP', rb: 'Ruby', swift: 'Swift', dart: 'Dart', scala: 'Scala', lua: 'Lua', sh: 'Shell', bash: 'Shell', ps1: 'PowerShell', bat: 'Batch',
  html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS', vue: 'Vue', svelte: 'Svelte', sql: 'SQL', md: 'Markdown', json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML',
};
const CODE_LANGS = new Set(['JavaScript', 'TypeScript', 'Python', 'Go', 'Rust', 'Java', 'Kotlin', 'C#', 'C', 'C++', 'PHP', 'Ruby', 'Swift', 'Dart', 'Scala', 'Lua', 'Shell', 'Vue', 'Svelte']);
const IMPORTANT = /^(?:package\.json|readme(?:\.\w+)?|agents\.md|claude\.md|tsconfig\.json|jsconfig\.json|pyproject\.toml|setup\.py|requirements\.txt|cargo\.toml|go\.mod|pom\.xml|build\.gradle|composer\.json|gemfile|dockerfile|docker-compose\.ya?ml|makefile|\.env\.example|vite\.config\.\w+|webpack\.config\.\w+|next\.config\.\w+)$/i;
const ENTRY = /^(?:index|main|app|server|cli|__main__|manage)\.\w+$/i;

export const langOf = (file) => LANG[path.extname(file).slice(1).toLowerCase()] ?? null;

// [regex, kind] - the first capture group is the symbol name.
const SYMBOL_RULES = {
  js: [
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/, 'function'],
    [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\w$]+)/, 'class'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>|[\w$]+\s*=>)/, 'function'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Z][\w$]*)\s*=/, 'const'],
    [/^\s*(?:export\s+)?(?:interface|type|enum)\s+([\w$]+)/, 'type'],
    [/^\s{2,}(?:static\s+|async\s+|get\s+|set\s+|#)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/, 'method'],
  ],
  py: [
    [/^\s*(?:async\s+)?def\s+(\w+)/, 'function'],
    [/^\s*class\s+(\w+)/, 'class'],
    [/^([A-Z][A-Z0-9_]+)\s*=/, 'const'],
  ],
  go: [[/^func\s+(?:\([^)]*\)\s*)?(\w+)/, 'function'], [/^type\s+(\w+)/, 'type']],
  rs: [[/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/, 'function'], [/^\s*(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)/, 'type']],
  java: [[/^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:class|interface|enum|record)\s+(\w+)/, 'class'], [/^\s*(?:public|private|protected)\s+(?:static\s+)?[\w<>[\],\s]+\s+(\w+)\s*\(/, 'method']],
  php: [[/^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+(\w+)/, 'function'], [/^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/, 'class']],
  rb: [[/^\s*def\s+(?:self\.)?(\w+[?!]?)/, 'function'], [/^\s*(?:class|module)\s+(\w+)/, 'class']],
};
SYMBOL_RULES.ts = SYMBOL_RULES.js;
SYMBOL_RULES.cs = SYMBOL_RULES.java;
SYMBOL_RULES.kt = [[/^\s*(?:fun)\s+(\w+)/, 'function'], [/^\s*(?:data\s+)?class\s+(\w+)/, 'class']];
const RULES_BY_EXT = { mjs: 'js', cjs: 'js', jsx: 'js', tsx: 'ts', mts: 'ts', vue: 'js', svelte: 'js' };

const NOT_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'constructor']);

export function extractSymbols(text, file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const rules = SYMBOL_RULES[RULES_BY_EXT[ext] ?? ext];
  if (!rules) return [];
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < 400; i++) {
    const line = lines[i];
    if (line.length > 400) continue;
    for (const [re, kind] of rules) {
      const m = re.exec(line);
      if (!m) continue;
      if (kind === 'method' && NOT_METHOD.has(m[1])) break;
      out.push({ name: m[1], kind, line: i + 1 });
      break;
    }
  }
  return out;
}

export function extractImports(text, file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const found = new Set();
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'vue', 'svelte'].includes(ext)) {
    for (const re of [/\bimport\s+(?:[\s\S]{0,200}?\s+from\s+)?['"]([^'"]+)['"]/g, /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, /\bexport\s+[\s\S]{0,200}?\s+from\s+['"]([^'"]+)['"]/g]) {
      for (const m of text.matchAll(re)) found.add(m[1]);
    }
  } else if (ext === 'py') {
    for (const m of text.matchAll(/^\s*from\s+([\w.]+)\s+import\b/gm)) found.add(m[1]);
    for (const m of text.matchAll(/^\s*import\s+([\w.]+)/gm)) found.add(m[1]);
  } else if (ext === 'go') {
    for (const m of text.matchAll(/^\s*(?:import\s+)?"([\w./-]+)"/gm)) found.add(m[1]);
  }
  return [...found].slice(0, 100);
}

const JS_EXTS = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '/index.js', '/index.ts', '/index.mjs'];

/** Resolve an import specifier to an indexed file (relative JS/TS paths and dotted Python modules). */
function resolveImport(spec, fromFile, files) {
  if (spec.startsWith('.')) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
    for (const ext of JS_EXTS) if (files.has(base + ext)) return base + ext;
    if (/\.py$/.test(fromFile)) {
      const mod = path.posix.join(path.posix.dirname(fromFile), spec.replace(/^\.+/, '').replace(/\./g, '/'));
      if (files.has(`${mod}.py`)) return `${mod}.py`;
    }
    return null;
  }
  if (/\.py$/.test(fromFile) && /^[\w.]+$/.test(spec)) {
    const mod = spec.replace(/\./g, '/');
    for (const c of [`${mod}.py`, `${mod}/__init__.py`]) if (files.has(c)) return c;
  }
  return null;
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export class ProjectIndex {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, '.puter-agent', 'index.json');
    this.files = new Map(); // rel -> { size, mtimeMs, hash, lang, symbols, imports }
    this.scannedAt = 0;
    this.loaded = false;
    this.lastChanges = { added: [], modified: [], removed: [] };
    this.truncated = false;
    this.#scanning = null;
  }

  #scanning;

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (data.version === INDEX_VERSION && data.root === this.root) {
        this.files = new Map(data.files);
        this.scannedAt = data.scannedAt ?? 0;
      }
    } catch {
      /* no saved index yet */
    }
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify({ version: INDEX_VERSION, root: this.root, scannedAt: this.scannedAt, files: [...this.files] }), 'utf8');
  }

  /** Walk the tree; only changed files are re-read. Concurrent calls share one scan. */
  scan({ signal } = {}) {
    if (!this.#scanning) this.#scanning = this.#scan(signal).finally(() => (this.#scanning = null));
    return this.#scanning;
  }

  async #scan(signal) {
    await this.load();
    const found = [];
    this.truncated = false;
    const walk = async (dir, rel) => {
      if (signal?.aborted || found.length >= MAX_FILES) return;
      let items;
      try {
        items = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        if (found.length >= MAX_FILES) {
          this.truncated = true;
          return;
        }
        const r = rel ? `${rel}/${item.name}` : item.name;
        if (item.isDirectory()) {
          if (!IGNORED_DIRS.has(item.name) && !(item.name.startsWith('.') && item.name !== '.github')) await walk(path.join(dir, item.name), r);
        } else if (item.isFile() && !IGNORED_FILES.test(item.name)) found.push(r);
      }
    };
    await walk(this.root, '');

    const previous = this.files;
    const next = new Map();
    const changes = { added: [], modified: [], removed: [] };
    await mapLimit(found, CONCURRENCY, async (rel) => {
      const abs = path.join(this.root, rel);
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        return;
      }
      const old = previous.get(rel);
      if (old && old.mtimeMs === stat.mtimeMs && old.size === stat.size) {
        next.set(rel, old);
        return;
      }
      const entry = { size: stat.size, mtimeMs: stat.mtimeMs, hash: null, lang: langOf(rel), symbols: [], imports: [] };
      if (stat.size <= MAX_PARSE_BYTES) {
        try {
          const buf = await fs.readFile(abs);
          entry.hash = hashText(buf).slice(0, 16);
          if (!buf.subarray(0, 8000).includes(0) && entry.lang) {
            const text = buf.toString('utf8');
            entry.symbols = extractSymbols(text, rel);
            entry.imports = extractImports(text, rel);
          }
        } catch {
          /* unreadable: keep metadata only */
        }
      }
      if (old && old.hash && entry.hash && old.hash === entry.hash) {
        next.set(rel, { ...old, mtimeMs: stat.mtimeMs }); // touched but identical content
        return;
      }
      next.set(rel, entry);
      if (this.scannedAt) (old ? changes.modified : changes.added).push(rel);
    });
    if (this.scannedAt) for (const rel of previous.keys()) if (!next.has(rel)) changes.removed.push(rel);
    for (const k of Object.keys(changes)) changes[k].sort();
    this.files = new Map([...next].sort((a, b) => a[0].localeCompare(b[0])));
    const first = !this.scannedAt;
    this.scannedAt = Date.now();
    this.lastChanges = changes;
    await this.save().catch(() => {});
    return { files: this.files.size, first, changes, truncated: this.truncated };
  }

  /** Compact summary of the project for the model (no file contents). */
  overview({ maxTree = 60 } = {}) {
    const langs = {};
    let bytes = 0;
    let symbols = 0;
    const dirs = new Map();
    const important = [];
    const entries = [];
    for (const [rel, f] of this.files) {
      bytes += f.size;
      symbols += f.symbols.length;
      if (f.lang) langs[f.lang] = (langs[f.lang] ?? 0) + 1;
      const parts = rel.split('/');
      const top = parts.length > 1 ? `${parts[0]}/` : '.';
      const sub = parts.length > 2 ? `${parts[0]}/${parts[1]}/` : null;
      dirs.set(top, (dirs.get(top) ?? 0) + 1);
      if (sub) dirs.set(sub, (dirs.get(sub) ?? 0) + 1);
      const base = parts.at(-1);
      if (IMPORTANT.test(base) && parts.length <= 3) important.push(rel);
      if (ENTRY.test(base) && parts.length <= 3 && CODE_LANGS.has(f.lang)) entries.push(rel);
    }
    const languages = Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([name, files]) => ({ name, files }));
    const tree = [...dirs].sort((a, b) => a[0].localeCompare(b[0])).slice(0, maxTree).map(([d, n]) => `${d} (${n})`);
    const graph = this.graph();
    const hubs = [...graph.importedBy].map(([f, s]) => [f, s.size]).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f, n]) => `${f} (imported by ${n})`);
    return { root: this.root, files: this.files.size, bytes, symbols, languages, tree, important: important.slice(0, 25), entry_points: entries.slice(0, 15), most_imported: hubs, truncated: this.truncated };
  }

  /** Dependency edges between indexed files. */
  graph() {
    const imports = new Map();
    const importedBy = new Map();
    for (const [rel, f] of this.files) {
      for (const spec of f.imports ?? []) {
        const target = resolveImport(spec, rel, this.files);
        if (!target) continue;
        if (!imports.has(rel)) imports.set(rel, new Set());
        imports.get(rel).add(target);
        if (!importedBy.has(target)) importedBy.set(target, new Set());
        importedBy.get(target).add(rel);
      }
    }
    return { imports, importedBy };
  }

  relations(rel) {
    const f = this.files.get(rel);
    if (!f) return null;
    const g = this.graph();
    return {
      file: rel,
      language: f.lang,
      imports: [...(g.imports.get(rel) ?? [])],
      external_imports: (f.imports ?? []).filter((s) => !resolveImport(s, rel, this.files)).slice(0, 30),
      imported_by: [...(g.importedBy.get(rel) ?? [])],
      symbols: f.symbols.slice(0, 50).map((s) => `${s.line}: ${s.kind} ${s.name}`),
    };
  }

  /** Definitions matching `name` (exact first, then case-insensitive substring). */
  findSymbol(name, { kind, limit = 30 } = {}) {
    const exact = [];
    const partial = [];
    const needle = String(name).toLowerCase();
    for (const [rel, f] of this.files) {
      for (const s of f.symbols) {
        if (kind && s.kind !== kind) continue;
        if (s.name === name) exact.push({ file: rel, line: s.line, kind: s.kind, name: s.name });
        else if (s.name.toLowerCase().includes(needle)) partial.push({ file: rel, line: s.line, kind: s.kind, name: s.name });
      }
    }
    return [...exact, ...partial].slice(0, limit);
  }
}

const instances = new Map();
/** One shared index per workspace root. */
export function getProjectIndex(root) {
  if (!instances.has(root)) instances.set(root, new ProjectIndex(root));
  return instances.get(root);
}
