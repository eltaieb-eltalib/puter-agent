import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { commandPreview, editPreview, fullPreview, langOfPath, lineDiff, multiEditPreview, previewBudget, renderDiff, writePreview } from '../terminal/components/preview.js';
import { stringWidth, stripAnsi } from '../terminal/components/text.js';

const plain = (lines) => lines.map(stripAnsi);

describe('line diff', () => {
  test('minimal diff with removals before additions and correct line numbers', () => {
    const d = lineDiff('a\nb\nc\nd', 'a\nB\nB2\nc\nd');
    assert.deepEqual(d.map((x) => `${x.op}${x.text}`), [' a', '-b', '+B', '+B2', ' c', ' d']);
    assert.equal(d.find((x) => x.op === '-').a, 2);
    assert.deepEqual(d.filter((x) => x.op === '+').map((x) => x.b), [2, 3]);
  });

  test('huge inputs fall back without blowing up', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `x${i}`).join('\n');
    const b = Array.from({ length: 3000 }, (_, i) => `y${i}`).join('\n');
    const d = lineDiff(a, b);
    assert.equal(d.length, 6000);
  });
});

describe('previews', () => {
  test('edit preview: header with +/- counts, real line numbers, context kept short', () => {
    const lines = plain(editPreview({ path: '.env', oldText: 'X=1\nDEBUG=FlTrue\nY=2', newText: 'X=1\nDEBUG=True\nSECRET=dev\nY=2', startLine: 10, width: 60, maxLines: 10 }));
    assert.match(lines[0], /Edit \.env\s+\+2 -1/);
    assert.match(lines.join('\n'), /11 - DEBUG=FlTrue/);
    assert.match(lines.join('\n'), /11 \+ DEBUG=True/);
    assert.match(lines.join('\n'), /12 \+ SECRET=dev/);
    assert.match(lines.join('\n'), /10\s+X=1/);
  });

  test('long unchanged runs collapse and the line budget is respected', () => {
    const before = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[2] = 'changed 2';
    after[45] = 'changed 45';
    const out = plain(renderDiff(lineDiff(before.join('\n'), after.join('\n')), { width: 60, maxLines: 6 }));
    assert.ok(out.some((l) => /⋯ \d+ unchanged lines/.test(l)));
    assert.ok(out.length <= 7);
    assert.match(out.at(-1), /more changed line.*\/last/);
  });

  test('every preview line fits the terminal width (phone and desktop)', () => {
    const long = `const value = "${'x'.repeat(200)}"; // ${'مرحبا '.repeat(20)}`;
    for (const width of [30, 45, 80, 120]) {
      const blocks = [
        editPreview({ path: 'a.js', oldText: 'a', newText: long, width }),
        writePreview({ path: 'a.py', content: `${long}\n`.repeat(30), width }),
        commandPreview({ command: `npm run ${'x'.repeat(200)}`, stdout: long, exitCode: 1, width }),
        multiEditPreview({ path: 'a.js', edits: [{ old_string: 'a', new_string: long }, { old_string: 'b', new_string: 'c' }], width }),
      ];
      for (const l of blocks.flat()) assert.ok(stringWidth(l) <= width, `width ${width}: ${stripAnsi(l)}`);
    }
  });

  test('write preview shows a glimpse and how much is hidden; command preview shows output tail and failure', () => {
    const w = plain(writePreview({ path: 'views.py', content: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n'), width: 60, maxLines: 10 }));
    assert.match(w[0], /Write views\.py\s+40 lines/);
    assert.match(w.at(-1), /\+34 more lines/);
    const c = plain(commandPreview({ command: 'npm test', stdout: Array.from({ length: 20 }, (_, i) => `out ${i}`).join('\n'), exitCode: 2, width: 60, maxLines: 6 }));
    assert.equal(c[0].trim(), '$ npm test');
    assert.match(c.join('\n'), /… 14 earlier line\(s\)/);
    assert.match(c.at(-1), /exited with code 2/);
    assert.match(plain(commandPreview({ command: 'true', width: 40 })).join('\n'), /\(no output\)/);
  });

  test('full preview (for /last) is not truncated', () => {
    const content = Array.from({ length: 300 }, (_, i) => `l${i}`).join('\n');
    const full = plain(fullPreview('write', { path: 'a.txt', content }, 80));
    assert.equal(full.length, 301);
  });

  test('budget adapts to terminal height; language from path', () => {
    assert.equal(previewBudget({ max: 14, rows: 80 }), 14);
    assert.equal(previewBudget({ max: 14, rows: 30 }), 9);
    assert.equal(previewBudget({ max: 14, rows: 10 }), 4);
    assert.equal(langOfPath('src/app.tsx'), 'ts');
    assert.equal(langOfPath('.env.local'), 'sh');
  });
});
