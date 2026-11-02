// Text layout for the terminal: cell-width aware wrapping of styled (ANSI) text, and RTL handling.
//
// RTL: terminals differ in how they shape and order Arabic/Hebrew. We never reverse characters
// (terminals with bidi support - VTE/GNOME, Konsole, iTerm2, mintty, recent Windows Terminal - would
// then show them backwards). Instead, paragraphs that are mostly right-to-left are wrapped by cell
// width and RIGHT-ALIGNED (the terminal's own bidi engine keeps mixed Arabic/English runs in order).

import { stringWidth, stripAnsi, charWidth } from '../input.js';

export { stringWidth, stripAnsi };

const RTL_RE = /[֐-׿؀-ۿݐ-ݿࢠ-ࣿיִ-﷿ﹰ-﻿]/g;
const LTR_RE = /[A-Za-zÀ-ɏЀ-ӿ]/g;

/** True when strong right-to-left letters outnumber left-to-right letters. */
export function isRtl(text) {
  const plain = stripAnsi(String(text ?? '')).replace(/`[^`]*`|https?:\/\/\S+/g, '');
  const rtl = (plain.match(RTL_RE) ?? []).length;
  if (!rtl) return false;
  return rtl >= (plain.match(LTR_RE) ?? []).length;
}

const SGR = /\x1b\[[0-9;]*m/y;
const RESET = '\x1b[0m';

/**
 * Wrap text that may contain SGR colour codes to `width` cells. Breaks at spaces when possible,
 * hard-breaks long words. Styles open at a break are closed at the line end and re-opened on the
 * next line, so colours never bleed into margins or prefixes.
 */
export function wrapAnsi(text, width) {
  const w = Math.max(4, width);
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    if (stringWidth(para) <= w) {
      out.push(para);
      continue;
    }
    // tokenise: [{ ansi } | { ch, cw }]
    const tokens = [];
    for (let i = 0; i < para.length; ) {
      SGR.lastIndex = i;
      const m = SGR.exec(para);
      if (m) {
        tokens.push({ ansi: m[0] });
        i += m[0].length;
        continue;
      }
      const cp = para.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      tokens.push({ ch, cw: charWidth(cp) });
      i += ch.length;
    }
    let active = []; // currently open SGR codes
    let line = '';
    let lineW = 0;
    let lastSpace = -1; // index in `line` (string) right after a space, and widths
    let widthAtSpace = 0;
    let activeAtSpace = [];
    const flush = (cutAt = null) => {
      let head = line;
      let tail = '';
      let tailW = 0;
      if (cutAt !== null) {
        head = line.slice(0, cutAt);
        tail = line.slice(cutAt);
        tailW = lineW - widthAtSpace;
      }
      const opened = cutAt !== null ? activeAtSpace : active;
      out.push(head.replace(/\s+$/, '') + (opened.length ? RESET : ''));
      line = (cutAt !== null ? activeAtSpace : active).join('') + tail;
      lineW = tailW;
      lastSpace = -1;
    };
    for (const t of tokens) {
      if (t.ansi) {
        line += t.ansi;
        if (/^\x1b\[0?m$/.test(t.ansi)) active = [];
        else active.push(t.ansi);
        continue;
      }
      if (lineW + t.cw > w) {
        if (t.ch === ' ') {
          flush();
          continue;
        }
        if (lastSpace > 0) flush(lastSpace);
        else flush();
      }
      if (t.ch === ' ' && lineW === 0 && out.length) continue; // no leading space on continuation lines
      line += t.ch;
      lineW += t.cw;
      if (t.ch === ' ') {
        lastSpace = line.length;
        widthAtSpace = lineW;
        activeAtSpace = [...active];
      }
    }
    out.push(line);
  }
  return out;
}

/** Pad a line on the left so it ends at `width` cells (right alignment). */
export function alignRight(line, width) {
  const pad = Math.max(0, width - stringWidth(line));
  return ' '.repeat(pad) + line;
}

/**
 * Lay out a paragraph for display: wraps to `width`, and when it is RTL (rtl: 'auto' detects,
 * 'on' forces, 'off' never) right-aligns each line.
 */
export function layout(text, width, { rtl = 'auto' } = {}) {
  const lines = wrapAnsi(text, width);
  const right = rtl === 'on' || (rtl === 'auto' && isRtl(text));
  if (!right) return lines;
  return lines.map((l) => alignRight(l, width));
}

/** Clip to `max` cells (ANSI-safe), adding an ellipsis. */
export function clipCells(text, max) {
  const s = String(text ?? '');
  if (stringWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  for (let i = 0; i < s.length; ) {
    SGR.lastIndex = i;
    const m = SGR.exec(s);
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return `${out}…${/\x1b\[/.test(out) ? RESET : ''}`;
}

export const oneLine = (value, max = 100) => clipCells(String(value ?? '').replace(/\s+/g, ' ').trim(), max);
