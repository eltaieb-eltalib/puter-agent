import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderInline } from '../terminal/components/markdown.js';
import { highlight } from '../terminal/components/highlight.js';
import { alignRight, clipCells, isRtl, layout, stringWidth, stripAnsi, wrapAnsi } from '../terminal/components/text.js';
import { PhaseTracker, header, statusBar, toolCallLine, toolResultLine, outputTail } from '../terminal/components/panels.js';
import { LiveLine } from '../terminal/components/live.js';
import { Transcript } from '../terminal/components/transcript.js';
import { CacheManager } from '../core/cache.js';

const SAMPLE = `# Title

Some **bold** text, *italic*, \`code\` and a [link](https://example.org).

## قسم عربي

هذا نص عربي طويل يجب أن يلتف بشكل صحيح داخل عرض الطرفية ويُحاذى إلى اليمين لأن أغلب حروفه عربية.

| Name | Value | Notes |
|------|-------|-------|
| alpha | 1 | first row with a longer note |
| beta | 22 | second |

\`\`\`js
// # not a heading inside code
const x = "- not a list"; // 42
function f(a) { return a * 2; }
\`\`\`

- item one
  - nested item
- [x] done task
- [ ] open task
1. first
2. second

> a quote line

---
`;

describe('markdown renderer', () => {
  test('code fences are not reinterpreted and get line numbers', () => {
    const out = stripAnsi(renderMarkdown(SAMPLE, { width: 80 }));
    assert.match(out, /│ \/\/ # not a heading inside code/);
    const numbered = stripAnsi(renderMarkdown('```py\na = 1\nb = 2\nc = 3\n# d\n```', { width: 40 }));
    assert.match(numbered, /│ 4 # d/, 'blocks longer than 3 lines are numbered; "#" stays code');
    assert.match(out, /const x = "- not a list";/);
    assert.match(out, /╭─ js/);
  });

  test('inline styles, tables, lists, task lists and quotes', () => {
    const out = stripAnsi(renderMarkdown(SAMPLE, { width: 80 }));
    assert.match(out, /link \(https:\/\/example\.org\)/);
    assert.match(out, /│ alpha │ 1/);
    assert.match(out, /• item one/);
    assert.match(out, /  ◦ nested item/);
    assert.match(out, /☑ done task/);
    assert.match(out, /☐ open task/);
    assert.match(out, /1\. first/);
    assert.match(out, /▌ a quote line/);
    assert.doesNotMatch(out, /\*\*bold\*\*/);
  });

  test('no rendered line is wider than the terminal, at any width (resize-safe)', () => {
    for (const width of [20, 32, 40, 57, 64, 80, 101, 140]) {
      const lines = renderMarkdown(SAMPLE, { width }).split('\n');
      for (const l of lines) assert.ok(stringWidth(l) <= width, `width ${width}: "${stripAnsi(l)}" is ${stringWidth(l)} cells`);
    }
  });

  test('a table too wide for the terminal becomes key/value rows', () => {
    const out = stripAnsi(renderMarkdown('| a | b |\n|---|---|\n| very long cell content here | another long value |', { width: 30 }));
    assert.match(out, /a: very long cell content here/);
  });

  test('RTL paragraphs are right-aligned; rtl=off keeps them left', () => {
    const ar = 'هذا سطر عربي قصير';
    const right = renderMarkdown(ar, { width: 50 });
    assert.equal(stringWidth(right), 50);
    assert.ok(right.startsWith(' '));
    assert.equal(renderMarkdown(ar, { width: 50, rtl: 'off' }), ar);
    assert.ok(!renderMarkdown('English text with one كلمة', { width: 50 }).startsWith(' '));
  });

  test('inline code is protected from other inline rules', () => {
    assert.equal(stripAnsi(renderInline('use `a*b*c` and **x**')), 'use a*b*c and x');
  });
});

describe('text layout', () => {
  test('wrapAnsi respects cell width (CJK, Arabic, emoji) and re-opens styles', () => {
    const coloured = `\x1b[38;5;141m${'word '.repeat(12)}\x1b[39m`;
    const lines = wrapAnsi(coloured, 20);
    assert.ok(lines.length > 1);
    for (const l of lines) {
      assert.ok(stringWidth(l) <= 20);
      assert.ok(l.startsWith('\x1b[38;5;141m'), 'style re-opened on every line');
    }
    for (const l of wrapAnsi('漢字漢字漢字漢字漢字漢字', 7)) assert.ok(stringWidth(l) <= 7);
    assert.deepEqual(wrapAnsi('a\nb', 10), ['a', 'b']);
  });

  test('isRtl / alignRight / clipCells', () => {
    assert.ok(isRtl('مرحبا بالعالم'));
    assert.ok(!isRtl('hello world مرحبا'));
    assert.ok(isRtl('افتح الملف `index.js` الآن'), 'code spans do not count');
    assert.equal(alignRight('ab', 5), '   ab');
    assert.equal(stringWidth(clipCells('\x1b[1mhello world\x1b[22m', 6)), 6);
    assert.deepEqual(layout('مرحبا', 10).map((l) => stringWidth(l)), [10]);
  });
});

describe('syntax highlighting', () => {
  test('keeps the text and colours tokens', () => {
    const src = 'const a = "x"; // note\nfunction f() { return 42; }';
    const lines = highlight(src, 'javascript');
    assert.equal(stripAnsi(lines.join('\n')), src);
    for (const lang of ['py', 'go', 'rust', 'bash', 'json', 'html', 'css', 'sql', 'diff', 'unknown']) {
      const code = 'x = "1" # c\n/* b */ y = 2';
      assert.equal(stripAnsi(highlight(code, lang).join('\n')), code, lang);
    }
    // block comments and python triple quotes carry over lines
    assert.equal(stripAnsi(highlight('/* a\nb */ c', 'js').join('\n')), '/* a\nb */ c');
    assert.equal(stripAnsi(highlight('"""doc\nstring"""\nx=1', 'py').join('\n')), '"""doc\nstring"""\nx=1');
  });
});

describe('panels', () => {
  const usage = { promptTokens: 12000, completionTokens: 800, cachedTokens: 9000, totalTokens: 12800, modelCalls: 4, toolCalls: 7, latencyMs: 4000, cachedToolCalls: 2, dedupedResults: 1 };

  test('status bar shows tokens, cache share, context, cache and memory, and always fits', () => {
    const cache = new CacheManager().stats();
    const full = stripAnsi(statusBar({ usage, context: { tokens: 5000, percent: 15 }, cache, elapsedMs: 3200, steps: 4, width: 200 }));
    assert.match(full, /4 steps/);
    assert.match(full, /tok 12k↑ 800↓ 75%⚡/);
    assert.match(full, /calls 4\/7 tools/);
    assert.match(full, /llm 1\.0s\/call/);
    assert.match(full, /ctx/);
    assert.match(full, /cache/);
    assert.match(full, /mem \d/);
    for (const width of [40, 60, 80, 120]) assert.ok(stringWidth(statusBar({ usage, context: { tokens: 5000, percent: 15 }, cache, elapsedMs: 1, steps: 4, width })) < width);
  });

  test('provider without usage data says so instead of showing zeros', () => {
    assert.match(stripAnsi(statusBar({ usage: { modelCalls: 2 }, steps: 2, width: 120 })), /usage n\/a/);
  });

  test('phase tracker follows tool events', () => {
    const p = new PhaseTracker();
    p.fromTool('read_file');
    p.fromTool('edit_file');
    p.fromTool('run_command');
    p.enter('done');
    const out = stripAnsi(p.render());
    assert.match(out, /✔ Explore/);
    assert.match(out, /✔ Edit/);
    assert.match(out, /✔ Verify/);
    assert.match(out, /○ Plan/);
    assert.match(out, /● Done/);
  });

  test('tool lines: icon by category, args, timing, cached and failure states', () => {
    assert.match(stripAnsi(toolCallLine('run_command', { command: 'npm test' })), /▶ run_command npm test/);
    assert.match(stripAnsi(toolCallLine('read_file', { path: 'a.js' }, { parallel: true })), /◇ read_file ⇉ a\.js/);
    assert.match(stripAnsi(toolResultLine({ ok: true, cached: true, result: { summary: '3 files' } }, { ms: 12 })), /✔ 3 files · 12ms · ⚡cached/);
    assert.match(stripAnsi(toolResultLine({ ok: true, result: { exit_code: 1, summary: 'exit code 1' } })), /✖ exit code 1/);
    assert.match(stripAnsi(toolResultLine({ ok: false, error: 'nope' }, { label: 'read_file' })), /✖ read_file: nope/);
    const tail = outputTail(Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n'), { lines: 3 }).map(stripAnsi);
    assert.deepEqual(tail.map((l) => l.trim()), ['│ … 7 earlier line(s)', '│ line 7', '│ line 8', '│ line 9']);
  });

  test('header fits narrow terminals', () => {
    const h = header({ version: '1.0.0', model: 'some-very-long-model-name-for-testing', provider: 'openai', mode: 'plan', folder: '/a/very/long/path/to/the/workspace/folder', width: 50 });
    for (const l of h.split('\n')) assert.ok(stringWidth(l) <= 50, stripAnsi(l));
    assert.match(stripAnsi(h), /PLAN/);
  });
});

describe('live line and transcript', () => {
  test('live line is a no-op without a TTY', () => {
    const writes = [];
    const live = new LiveLine({ isTTY: false, write: (s) => writes.push(s) });
    live.start('Working');
    live.update('Still working', '10 chars');
    assert.equal(live.active, false);
    live.stop();
    assert.equal(writes.length, 0);
  });

  test('live line clips to the current width on every frame', async () => {
    const writes = [];
    const stream = { isTTY: true, columns: 30, write: (s) => writes.push(s) };
    const live = new LiveLine(stream);
    live.tty = true;
    live.start('A very long label that would wrap in a narrow terminal window');
    stream.columns = 20; // resize while running
    await new Promise((r) => setTimeout(r, 200));
    live.stop();
    const frames = writes.filter((w) => w.startsWith('\r\x1b[2K  ')).map((w) => w.slice(7));
    assert.ok(frames.length >= 2);
    assert.ok(stringWidth(frames.at(-1)) <= 17, 'last frame fits the new width');
  });

  test('transcript keeps a bounded history and renders for the pager', () => {
    const t = new Transcript({ maxEntries: 3 });
    t.add('user', 'one');
    t.add('assistant', '**two**');
    t.add('tool', 'read_file a.js');
    t.add('user', 'four');
    assert.equal(t.size, 3);
    const text = stripAnsi(t.lines({ width: 40 }).join('\n'));
    assert.doesNotMatch(text, /one/);
    assert.match(text, /Agent/);
    assert.match(text, /two/);
    assert.match(text, /four/);
  });
});
