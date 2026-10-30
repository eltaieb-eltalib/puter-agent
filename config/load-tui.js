import fs from 'node:fs';
import path from 'node:path';

export function loadTuiConfig(baseDir) {
  const candidates = [
    path.join(baseDir, 'tui.json'),
    path.join(baseDir, 'tui.jsonc'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, 'utf8');
      // jsonc is not supported; keep it strict.
      return JSON.parse(raw);
    } catch {
      // ignore parse errors
    }
  }
  return { theme: 'default' };
}
