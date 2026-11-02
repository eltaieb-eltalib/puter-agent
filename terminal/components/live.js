// The single animated line at the bottom while the agent works:
//   ⠹ Editing src/app.js · 3.2s · step 4 · writing 812 chars
// Re-measured on every frame, so resizing the terminal never leaves wrapped fragments behind.
// No-op when stdout is not a terminal (pipes, CI, -p mode logs).

import { colorEnabled, icons, paint } from './style.js';
import { clipCells } from './text.js';
import { fmtMs } from './panels.js';

export class LiveLine {
  constructor(stream = process.stdout) {
    this.stream = stream;
    this.timer = null;
    this.label = '';
    this.detail = '';
    this.step = 0;
    this.startedAt = 0;
    this.labelSince = 0;
    this.frame = 0;
    this.tty = Boolean(stream.isTTY) && colorEnabled();
  }

  get active() {
    return this.timer !== null;
  }

  start(label, { detail = '' } = {}) {
    this.label = label;
    this.detail = detail;
    this.labelSince = Date.now();
    if (!this.tty) return;
    if (this.timer) return;
    this.startedAt = Date.now();
    this.stream.write('\x1b[?25l');
    this.#draw();
    this.timer = setInterval(() => this.#draw(), 90);
    this.timer.unref?.();
  }

  update(label, detail) {
    if (label !== undefined && label !== this.label) {
      this.label = label;
      this.labelSince = Date.now();
    }
    if (detail !== undefined) this.detail = detail;
  }

  #draw() {
    const now = Date.now();
    const f = icons.frames[this.frame++ % icons.frames.length];
    const took = now - this.labelSince;
    const slow = took > 15000 ? paint.warn(' still working') : '';
    const parts = [`${paint.accent(f)} ${this.label}`, paint.muted(fmtMs(took))];
    if (this.step) parts.push(paint.faint(`step ${this.step}`));
    if (this.detail) parts.push(paint.faint(this.detail));
    const width = (this.stream.columns || 80) - 3;
    this.stream.write(`\r\x1b[2K  ${clipCells(parts.join(paint.faint(` ${icons.sep} `)) + slow, width)}`);
  }

  /** Stop and erase the line. Returns elapsed milliseconds since start(). */
  stop() {
    const elapsed = this.startedAt ? Date.now() - this.startedAt : 0;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.stream.write('\r\x1b[2K\x1b[?25h');
    }
    this.startedAt = 0;
    return elapsed;
  }
}
