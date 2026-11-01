import test from 'node:test';
import assert from 'node:assert/strict';
import { homePanel, logoLines, centre } from '../terminal/home.js';

test('premium home screen adapts to narrow and wide terminals', () => {
  const narrow = logoLines(40);
  const wide = logoLines(100);
  assert.ok(narrow.lines.length >= 1);
  assert.equal(wide.lines.length, 5);
  assert.match(homePanel({ cols: 100, version: '0.2.0', model: 'test-model', provider: 'AnyAPI', mode: 'build', folder: '~/project' }), /YOUR AI WORKSPACE/);
  assert.match(homePanel({ cols: 100, version: '0.2.0', model: 'test-model', provider: 'AnyAPI', mode: 'build', folder: '~/project' }), /AnyAPI/);
  assert.ok(centre('logo', 4, 80).startsWith(' '.repeat(38)));
});
