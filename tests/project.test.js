import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createZip, listZip, readZipEntry } from '../utils/zip.js';
import { ProjectIndex, extractImports, extractSymbols } from '../core/project-index.js';
import { CacheManager } from '../core/cache.js';
import { makeEnv } from './helpers.js';

describe('zip reader', () => {
  let env;
  beforeEach(async () => (env = await makeEnv()));
  afterEach(() => env.cleanup());

  test('lists entries and reads text files (UTF-8 names and Arabic content)', async () => {
    const zip = createZip({ 'src/app.js': 'console.log(1);\nconsole.log(2);\n', 'docs/اقرأني.md': 'مرحبا بالعالم', 'big.txt': 'x'.repeat(100000) });
    await fs.writeFile(path.join(env.dir, 'p.zip'), zip);
    const entries = await listZip(path.join(env.dir, 'p.zip'));
    assert.deepEqual(entries.map((e) => e.name), ['src/app.js', 'docs/اقرأني.md', 'big.txt']);
    const { data } = await readZipEntry(path.join(env.dir, 'p.zip'), 'docs/اقرأني.md');
    assert.equal(data.toString('utf8'), 'مرحبا بالعالم');

    const list = await env.run('read_zip', { path: 'p.zip' });
    assert.equal(list.result.total_files, 3);
    const slice = await env.run('read_zip', { path: 'p.zip', entry: 'src/app.js', start_line: 2, end_line: 2 });
    assert.equal(slice.result.content, 'console.log(2);');
    const missing = await env.run('read_zip', { path: 'p.zip', entry: 'nope.txt' });
    assert.match(missing.error, /not in the archive/);
  });

  test('inflated size is capped (zip-bomb guard) and non-zip files are rejected', async () => {
    await fs.writeFile(path.join(env.dir, 'bomb.zip'), createZip({ 'huge.txt': 'a'.repeat(3_000_000) }));
    const r = await readZipEntry(path.join(env.dir, 'bomb.zip'), 'huge.txt', { maxBytes: 1000 });
    assert.equal(r.data.length, 1000);
    assert.equal(r.truncated, true);
    await fs.writeFile(path.join(env.dir, 'fake.zip'), 'not a zip');
    assert.match((await env.run('read_zip', { path: 'fake.zip' })).error, /Not a ZIP file/);
  });
});

describe('symbol and import extraction', () => {
  test('JavaScript and Python definitions with line numbers', () => {
    const js = 'import a from "./a.js";\nconst b = require("./b");\nexport async function load() {}\nclass Store {\n  get(key) {\n  }\n}\nexport const run = async (x) => x;\n';
    assert.deepEqual(extractSymbols(js, 'x.js').map((s) => `${s.line}:${s.kind}:${s.name}`), ['3:function:load', '4:class:Store', '5:method:get', '8:function:run']);
    assert.deepEqual(extractImports(js, 'x.js').sort(), ['./a.js', './b']);
    const py = 'from .util import helper\nimport os\n\nclass Agent:\n    async def run(self):\n        pass\nMAX_STEPS = 3\n';
    assert.deepEqual(extractSymbols(py, 'a.py').map((s) => s.name), ['Agent', 'run', 'MAX_STEPS']);
    assert.deepEqual(extractImports(py, 'a.py'), ['.util', 'os']);
  });
});

describe('project index', () => {
  let env;
  beforeEach(async () => (env = await makeEnv()));
  afterEach(() => env.cleanup());

  const write = async (rel, text) => {
    await fs.mkdir(path.dirname(path.join(env.dir, rel)), { recursive: true });
    await fs.writeFile(path.join(env.dir, rel), text);
  };

  test('overview, relations, find_symbol and changed files (incremental)', async () => {
    await write('package.json', '{"name":"demo"}');
    await write('src/index.js', 'import { util } from "./util.js";\nexport function main() { return util(); }\n');
    await write('src/util.js', 'export function util() { return 1; }\n');
    await write('node_modules/dep/index.js', 'export function hidden() {}');
    await write('.git/HEAD', 'ref');

    const overview = await env.run('project_overview', {});
    assert.equal(overview.result.files, 3, 'node_modules and .git are excluded');
    assert.equal(overview.result.languages[0].name, 'JavaScript');
    assert.ok(overview.result.important.includes('package.json'));
    assert.ok(overview.result.entry_points.includes('src/index.js'));
    assert.match(overview.result.most_imported[0], /src\/util\.js/);

    const rel = await env.run('file_relations', { path: 'src/util.js' });
    assert.deepEqual(rel.result.imported_by, ['src/index.js']);

    const sym = await env.run('find_symbol', { name: 'util', references: true });
    assert.deepEqual(sym.result.definitions[0], { file: 'src/util.js', line: 1, kind: 'function', name: 'util' });
    assert.ok(sym.result.references.some((r) => r.file === 'src/index.js' && r.line === 2));

    const first = await env.run('changed_files', {});
    assert.equal(first.result.added.length + first.result.modified.length, 0);
    await write('src/util.js', 'export function util() { return 2; }\n');
    await write('src/new.js', 'export const x = 1;\n');
    await fs.rm(path.join(env.dir, 'package.json'));
    const changed = await env.run('changed_files', {});
    assert.deepEqual(changed.result.added, ['src/new.js']);
    assert.deepEqual(changed.result.modified, ['src/util.js']);
    assert.deepEqual(changed.result.removed, ['package.json']);
  });

  test('large project: incremental rescan reuses unchanged files and is persisted', async () => {
    const N = 3000;
    for (let d = 0; d < 30; d++) {
      await fs.mkdir(path.join(env.dir, `pkg${d}`), { recursive: true });
      await Promise.all(Array.from({ length: N / 30 }, (_, i) => fs.writeFile(path.join(env.dir, `pkg${d}`, `m${i}.js`), `import x from "./m${(i + 1) % 100}.js";\nexport function fn_${d}_${i}() { return ${i}; }\n`)));
    }
    const index = new ProjectIndex(env.dir);
    let t = Date.now();
    const full = await index.scan();
    const fullMs = Date.now() - t;
    assert.equal(full.files, N);
    await fs.writeFile(path.join(env.dir, 'pkg3', 'm7.js'), 'export function changed() {}\n');
    t = Date.now();
    const again = await new ProjectIndex(env.dir).scan(); // fresh instance: loads the saved index
    const incMs = Date.now() - t;
    assert.deepEqual(again.changes.modified, ['pkg3/m7.js']);
    assert.equal(again.changes.added.length, 0);
    const found = index.findSymbol('fn_29_99');
    assert.equal(found[0].file, 'pkg29/m99.js');
    console.log(`    [large project] ${N} files: full scan ${fullMs} ms, incremental rescan ${incMs} ms`);
  });

  test('project tools do not need the cache but use it for references', async () => {
    env.ctx.cache = new CacheManager();
    await write('a.js', 'export function a() {}\na();\n');
    const r = await env.run('find_symbol', { name: 'a', references: true });
    assert.equal(r.result.references.length, 1);
  });
});
