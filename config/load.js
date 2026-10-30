import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = Object.freeze({
  model: 'gpt-5.4-nano',
  workspace: './workspace',
  mode: 'build',
  maxSteps: 60,
  search: {
    providers: ['searxng', 'duckduckgo', 'wikipedia'],
    searxngUrls: ['https://searx.be', 'https://search.inetol.net', 'https://priv.au', 'https://searx.tiekoetter.com'],
    searxngEngines: '',
    maxResults: 8,
    timeoutMs: 10000,
    fetchTimeoutMs: 20000,
    allowPrivateFetch: false, // true lets web_fetch reach localhost / LAN (not recommended)
  },
  // Gemini 3+ thinks before answering: low = fast (default), medium/high = slower but more careful, off = provider default.
  gemini: { thinkingLevel: 'low' },
  // OpenAI Responses API reasoning settings. Availability is model-dependent.
  openai: { reasoningLevel: 'medium', reasoningMode: 'standard' },
  routing: { forceSearch: true }, // run web_search in code first for clear "search the web" requests
  requestTimeoutMs: 120000,
  retry: { retries: 3, baseDelayMs: 1000, maxDelayMs: 15000 },
  limits: {
    maxReadBytes: 200000,
    maxToolResultChars: 20000,
    commandTimeoutMs: 60000,
    commandIdleMs: 30000,
    maxCommandOutputChars: 20000,
  },
  approvals: {
    createFile: false,
    overwriteFile: true,
    editFile: false,
    deleteFile: true,
    moveFile: true,
    createDirectory: false,
    runCommand: true,
  },
  security: { outsideWorkspace: 'ask' },
  // verify: after changing code the agent must run something before it may finish (max `nudges` reminders).
  verify: { enabled: true, nudges: 2 },
  // compactAtChars: summarise old conversation parts when the history grows past this size.
  context: { compactAtChars: 120000, keepTurns: 2 },
});

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra ?? {})) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

export function parseArgs(argv) {
  const cli = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.split(/=(.*)/s);
    const next = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--workspace' || flag === '-w') cli.workspace = next();
    else if (flag === '--model' || flag === '-m') cli.model = next();
    else if (flag === '--mode') cli.mode = next();
    else if (flag === '--prompt' || flag === '-p') cli.prompt = next();
    else if (flag === '--help' || flag === '-h') cli.help = true;
    else throw new Error(`Unknown argument: ${arg} (try --help)`);
  }
  return cli;
}

/** Defaults < config/settings.json < environment < command-line flags. */
export function loadSettings({ rootDir, argv = [] }) {
  const file = path.join(rootDir, 'config', 'settings.json');
  let fromFile = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Cannot read ${file}: ${err.message}`);
  }

  const settings = deepMerge(DEFAULTS, fromFile);
  const cli = parseArgs(argv);

  if (cli.model) settings.model = cli.model;
  if (cli.mode) {
    if (!['build', 'plan'].includes(cli.mode)) throw new Error('--mode must be "build" or "plan".');
    settings.mode = cli.mode;
  }
  // SEARXNG_URL (your own SearXNG instance) is tried before the public ones.
  if (process.env.SEARXNG_URL) {
    const own = process.env.SEARXNG_URL.trim().replace(/\/+$/, '');
    settings.search = { ...settings.search, searxngUrls: [own, ...settings.search.searxngUrls.filter((u) => u !== own)] };
  }
  if (cli.workspace) settings.workspace = path.resolve(process.cwd(), cli.workspace);
  else if (process.env.PUTER_AGENT_WORKSPACE) {
    settings.workspace = path.resolve(process.cwd(), process.env.PUTER_AGENT_WORKSPACE);
  } else settings.workspace = path.resolve(rootDir, settings.workspace);

  if (!Number.isInteger(settings.maxSteps) || settings.maxSteps < 1) {
    throw new Error('settings.maxSteps must be a positive integer.');
  }
  return { settings, cli };
}
