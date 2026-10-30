#!/usr/bin/env node
// Tiny regression suite for the AGENT itself: runs each task through `node index.js -p` in a fresh
// workspace and checks the result. Run it before and after you change prompts/tools and compare.
//   npm run eval                 all tasks
//   npm run eval -- fix-bug      one task (id)
//   npm run eval -- --model X    pass options through to index.js
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Returns an array of failure strings (empty = passed). */
export function checkTask(task, { dir, reply }) {
  const failures = [];
  for (const c of task.checks ?? []) {
    if (c.file) {
      const file = path.join(dir, c.file);
      const exists = fs.existsSync(file);
      if (!exists) failures.push(`missing file ${c.file}`);
      else if (c.matches && !new RegExp(c.matches, 'm').test(fs.readFileSync(file, 'utf8'))) failures.push(`${c.file} does not match /${c.matches}/`);
    }
    if (c.reply && !new RegExp(c.reply, 'i').test(reply)) failures.push(`reply does not match /${c.reply}/`);
    if (c.replyAbsent && new RegExp(c.replyAbsent).test(reply)) failures.push(`reply contains forbidden /${c.replyAbsent}/`);
    if (c.replyNotEmpty && !reply.trim()) failures.push('empty reply');
    if (c.run) {
      const r = spawnSync(c.run, { cwd: dir, shell: true, encoding: 'utf8', timeout: 30000 });
      if (r.status !== 0) failures.push(`"${c.run}" exited ${r.status}`);
      else if (c.stdoutMatches && !new RegExp(c.stdoutMatches).test(r.stdout)) failures.push(`"${c.run}" output does not match /${c.stdoutMatches}/`);
    }
  }
  return failures;
}

function main() {
  const args = process.argv.slice(2);
  const ids = args.filter((a) => !a.startsWith('-') && !args[args.indexOf(a) - 1]?.startsWith('--'));
  const passthrough = args.filter((a, i) => a.startsWith('-') || args[i - 1]?.startsWith('--'));
  const all = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals', 'tasks.json'), 'utf8'));
  const tasks = ids.length ? all.filter((t) => ids.includes(t.id)) : all;
  let passed = 0;
  for (const task of tasks) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pa-eval-${task.id}-`));
    for (const [name, content] of Object.entries(task.setup ?? {})) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), content);
    }
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(ROOT, 'index.js'), '-w', dir, '-p', task.prompt, ...passthrough], {
      cwd: ROOT, encoding: 'utf8', timeout: 300000, input: 'o\n'.repeat(20), env: { ...process.env, NO_COLOR: '1' },
    });
    const reply = `${r.stdout ?? ''}`;
    const failures = checkTask(task, { dir, reply });
    if (!failures.length) passed++;
    console.log(`${failures.length ? 'FAIL' : 'PASS'}  ${task.id.padEnd(20)} ${((Date.now() - t0) / 1000).toFixed(0)}s${failures.length ? `\n      - ${failures.join('\n      - ')}` : ''}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${passed}/${tasks.length} passed`);
  process.exit(passed === tasks.length ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
