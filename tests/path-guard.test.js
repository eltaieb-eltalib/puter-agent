import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { PathGuard, isInside } from '../security/path-guard.js';

describe('PathGuard', () => {
  let base;
  let ws;
  let guard;

  before(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'puter-agent-guard-'));
    ws = path.join(base, 'ws');
    await fs.mkdir(ws);
    await fs.mkdir(path.join(base, 'outside'));
    await fs.writeFile(path.join(base, 'outside', 'secret.txt'), 'secret');
    guard = new PathGuard(ws);
  });
  after(() => fs.rm(base, { recursive: true, force: true }));

  test('relative paths inside the workspace are allowed', () => {
    assert.equal(guard.resolve('a/b.txt').inside, true);
    assert.equal(guard.resolve('.').inside, true);
    assert.equal(guard.resolve('./x/../y.txt').inside, true);
  });

  test('".." traversal is flagged as outside', () => {
    assert.equal(guard.resolve('../outside/secret.txt').inside, false);
    assert.equal(guard.resolve('a/../../outside').inside, false);
  });

  test('absolute paths outside are flagged', () => {
    assert.equal(guard.resolve(path.join(base, 'outside', 'secret.txt')).inside, false);
  });

  test('a sibling folder sharing the workspace name prefix is outside', async () => {
    const evil = `${guard.root}-evil`;
    await fs.mkdir(evil, { recursive: true });
    assert.equal(guard.resolve(path.join(evil, 'x.txt')).inside, false);
  });

  test('a symlink inside the workspace cannot be used to escape', async (t) => {
    const link = path.join(ws, 'escape');
    try {
      await fs.symlink(path.join(base, 'outside'), link, 'dir');
    } catch {
      t.skip('symlinks not permitted on this system');
      return;
    }
    assert.equal(guard.resolve('escape/secret.txt').inside, false);
    assert.equal(guard.resolve('escape/new-file.txt').inside, false);
  });

  test('empty paths and NUL bytes are rejected', () => {
    assert.throws(() => guard.resolve(''), /non-empty/);
    assert.throws(() => guard.resolve('a\0b'), /NUL/);
    assert.throws(() => guard.resolve(42), /non-empty/);
  });

  test('isInside handles the root itself and look-alike prefixes', () => {
    assert.equal(isInside('/a/b', '/a/b'), true);
    assert.equal(isInside('/a/b', '/a/b/c'), true);
    assert.equal(isInside('/a/b', '/a/bc'), false);
    assert.equal(isInside('/a/b', '/a'), false);
  });

  test('Windows: alternate data streams are rejected', { skip: process.platform !== 'win32' }, () => {
    assert.throws(() => guard.resolve('file.txt:hidden'), /alternate data streams/);
  });
});
