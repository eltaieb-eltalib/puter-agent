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
    maxToolResultChars: 10000,
    commandTimeoutMs: 60000,
    commandIdleMs: 30000,
    maxCommandOutputChars: 20000,
    readChunkLines: 250, // big files: read_file returns this many lines + an outline (0 = whole file)
  },
  approvals: {
    createFile: false,
    overwriteFile: true,
    editFile: false,
    deleteFile: true,
    moveFile: true,
    createDirectory: false,
    runCommand: true,
    openPath: true,
  },
  security: { outsideWorkspace: 'ask' },
  // Command rules for run_command (patterns use * as a wildcard). allow = no approval prompt (only for simple
  // commands without ; & | > < ` $( ), deny = always refused.
  rules: { allowCommands: [], denyCommands: [] },
  // Hooks and MCP servers are read from config/settings.json only (see README).
  hooks: {},
  mcpServers: {},
  // Token economy. dynamicTools: offer only the tool groups a request needs; stickyTools: never remove a
  // tool once offered in a conversation (keeps the provider's cached prompt prefix valid);
  // compressTriggerChars: old tool output is compressed in one batch once it exceeds this size.
  optimization: {
    dynamicTools: true,
    stickyTools: true,
    parallelTools: true,
    keepRecentToolResults: 4,
    compressedToolResultChars: 500,
    compressTriggerChars: 8000,
  },
  // verify: after changing code the agent must run something before it may finish (max `nudges` reminders).
  verify: { enabled: true, nudges: 2 },
  // compactAtChars: summarise old conversation parts when the history grows past this size.
  // summarizer: 'local' (from tool evidence, zero model tokens) or 'model' (one extra call, cached).
  // maxTokens: context size used for the % shown in the status bar and /context.
  context: { compactAtChars: 120000, keepTurns: 2, summarizer: 'local', manualSummarizer: 'model', maxTokens: 32000 },
  // Local request analysis (no model call): task frame + soft step budget with one checkpoint note.
  // budgets = soft step budget per complexity (the hard limit stays maxSteps).
  planning: { enabled: true, taskFrame: true, budgets: { simple: 8, moderate: 20 }, subagentMaxSteps: 20 },
  // Optional model tiers (null = use the main model): simple = simple requests, summary = /compact
  // summaries, subagent = the task tool. Use a smaller/cheaper model of the same provider.
  models: { simple: null, summary: null, subagent: null },
  // Output-token caps per model call (null = provider default): main loop, summaries, sub-agents.
  tokens: { maxOutput: null, summary: 700, subagent: null },
  // Tool calling protocol: auto (native, falls back to prompt mode if the model rejects tools) |
  // native | json | prompt.
  tools: { protocol: 'auto' },
  // Separate LRU caches. Sizes in MB. webTtlMs = how long web_search/web_fetch results stay valid.
  cache: {
    enabled: true,
    files: { maxEntries: 400, maxMB: 24 },
    tools: { maxEntries: 300, maxMB: 8, webTtlMs: 600000 },
    model: { maxEntries: 100, maxMB: 4 },
  },
  // JSONL log of executed write/delete/move/command operations and approval decisions.
  audit: { enabled: true },
  // Terminal UI: rtl = right-align Arabic/Hebrew paragraphs (auto | on | off); statusBar shows
  // tokens / context / cache / latency / memory after every request.
  ui: { rtl: 'auto', statusBar: true, showPhases: true, codeHighlight: true },
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
    else if (flag === '--output-format') cli.outputFormat = next();
    else if (flag === '--access') cli.access = next();
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

  if (cli.outputFormat && !['text', 'json'].includes(cli.outputFormat)) throw new Error('--output-format must be "text" or "json".');
  if (cli.access && !['workspace', 'ask', 'full'].includes(cli.access)) throw new Error('--access must be workspace, ask or full.');
  if (settings.tools?.protocol && !['auto', 'native', 'json', 'prompt'].includes(settings.tools.protocol)) {
    throw new Error('settings.tools.protocol must be auto, native, json or prompt.');
  }
  if (!Number.isInteger(settings.maxSteps) || settings.maxSteps < 1) {
    throw new Error('settings.maxSteps must be a positive integer.');
  }
  return { settings, cli };
}
