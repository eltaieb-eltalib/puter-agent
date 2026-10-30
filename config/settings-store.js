import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadSettingsJson(rootDir) {
  const file = path.join(rootDir, 'config', 'settings.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function saveSettings(rootDir, next) {
  const file = path.join(rootDir, 'config', 'settings.json');
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
}

export function updateSettings(rootDir, patch) {
  const current = loadSettingsJson(rootDir);
  const next = { ...current, ...patch };
  saveSettings(rootDir, next);
  return next;
}
