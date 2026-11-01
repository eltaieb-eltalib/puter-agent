import fs from 'node:fs';

/**
 * Minimal .env loader (KEY=value lines, # comments, optional quotes).
 * Existing environment variables always win. Returns false if the file is missing.
 */
export function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
  return true;
}

/**
 * Save KEY=value into the .env file (replace the existing line or append) and into process.env.
 * The file is created readable only by you (mode 600) when it does not exist yet.
 */
export function saveEnvValue(file, key, value) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error('Invalid variable name.');
  if (/[\r\n]/.test(value)) throw new Error('The value must be a single line.');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    /* new file */
  }
  const line = `${key}=${value}`;
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  const next = re.test(text) ? text.replace(re, () => line) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
  fs.writeFileSync(file, next, { encoding: 'utf8', mode: 0o600 });
  process.env[key] = value;
}
