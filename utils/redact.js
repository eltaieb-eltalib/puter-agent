import { scrub } from './errors.js';

// Secrets must not reach the model, the terminal or the saved session.
const PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI-style keys
  /AIza[0-9A-Za-z_-]{30,}/g, // Google API keys
  /gh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub tokens
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
];
// KEY=value / TOKEN: "value" style lines (".env" files, "set" output, JSON config).
const ASSIGN =
  /(["']?\b[A-Za-z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_?KEY|AUTH)[A-Za-z0-9_]*["']?\s*[=:]\s*)("[^"\n]{6,}"|'[^'\n]{6,}'|[^\s"',;]{6,})/gi;
const ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD)/i;

function envSecretValues() {
  const out = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (ENV_NAME.test(name) && typeof value === 'string' && value.length >= 8) out.push(value);
  }
  return out;
}

/** Mask anything that looks like a credential (known key formats, secret-looking assignments, env values). */
export function redactSecrets(text) {
  let out = scrub(String(text));
  for (const value of envSecretValues()) out = out.split(value).join('***');
  for (const re of PATTERNS) out = out.replace(re, '***');
  return out.replace(ASSIGN, (_m, left) => `${left}***`);
}

const SAFE_ENV_SUFFIX = /\.(example|sample|template|dist)$/i;

/** Files that normally hold credentials: reading them needs the user's approval. */
export function isSensitivePath(file) {
  const base = String(file).split(/[\\/]/).pop().toLowerCase();
  if (/^\.env(\..+)?$/.test(base)) return !SAFE_ENV_SUFFIX.test(base);
  if (/\.(pem|key|p12|pfx|keystore)$/.test(base)) return true;
  return ['id_rsa', 'id_ed25519', 'id_ecdsa', '.npmrc', '.netrc', '.pypirc', 'credentials', 'credentials.json'].includes(base);
}
