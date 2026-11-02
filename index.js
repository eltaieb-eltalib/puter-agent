#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSettings } from './config/load.js';
import { loadTuiConfig } from './config/load-tui.js';
import { Agent } from './core/agent.js';
import { createProvider, resolveProvider } from './providers/provider-manager.js';
import { Permissions } from './security/permissions.js';
import { PathGuard } from './security/path-guard.js';
import { TerminalUI } from './terminal/interface.js';
import { createDefaultRegistry } from './tools/index.js';
import { connectMcpServers } from './core/mcp.js';
import { loadEnvFile } from './utils/env.js';
import { explainError } from './utils/errors.js';
import { color } from './utils/logger.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const USAGE = `Puter Agent v${version}

Usage: node index.js [options]

  -w, --workspace <folder>   Folder the agent may read and write (default: ./workspace)
  -m, --model <id>           Model to use (default from config/settings.json)
      --mode <plan|build>    plan = read-only (explore/search/plan), build = full access (default)
  -p, --prompt <text>        Run ONE request non-interactively, then exit
      --output-format <fmt>  With -p: text (default) or json ({ result, stop_reason, steps, usage, changes })
      --access <level>       workspace | ask | full (full = any folder, commands run without asking)
  -h, --help                 Show this help

Provider: puter (default), gemini, openai, agentrouter, anthropic, anyapi, deepseek, openrouter, groq, mistral, xai, cerebras, together, fireworks, nvidia, perplexity, zai, moonshot, qwen, ollama or lmstudio. Pick with AGENT_PROVIDER in .env, config/connect.json, or /connect.
Authentication: set the matching provider API key in .env; local Ollama/LM Studio can run without a key.`;

async function main() {
  loadEnvFile(path.join(ROOT, '.env'));

  const { settings, cli } = loadSettings({ rootDir: ROOT, argv: process.argv.slice(2) });
  const tui = loadTuiConfig(path.join(ROOT, 'config'));
  if (cli.help) {
    console.log(USAGE);
    return;
  }

  const guard = new PathGuard(settings.workspace);
  const permissions = new Permissions({
    approvals: settings.approvals,
    outsideWorkspace: settings.security.outsideWorkspace,
  });
  const registry = createDefaultRegistry();
  if (cli.access) permissions.setAccess(cli.access);
  const jsonMode = cli.prompt && cli.outputFormat === 'json';
  const mcpStatus = await connectMcpServers(settings, registry, settings.workspace);
  if (!jsonMode) {
    for (const m of mcpStatus) console.log(m.ok ? color.dim(`MCP ${m.name}: ${m.tools} tool(s)`) : color.yellow(`MCP ${m.name} failed: ${m.error}`));
  }
  const say = (m) => (jsonMode ? console.error(m) : console.log(m));
  const choice = resolveProvider({
    rootDir: ROOT,
    cliModel: cli.model,
    settingsModel: settings.model,
  });
  if (choice.unknown) say(color.yellow(`Unknown provider "${choice.unknown}", using puter.`));
  settings.model = choice.model;
  const provider = createProvider(choice.name, {
    timeoutMs: settings.requestTimeoutMs,
    ...(choice.name === 'gemini' && !process.env.GEMINI_THINKING_LEVEL && { thinkingLevel: choice.thinking ?? settings.gemini?.thinkingLevel }),
    ...(choice.name === 'openai' && !process.env.OPENAI_REASONING_EFFORT && { reasoningLevel: choice.thinking ?? settings.openai?.reasoningLevel }),
    ...(choice.name === 'openai' && !process.env.OPENAI_REASONING_MODE && { reasoningMode: choice.reasoningMode ?? settings.openai?.reasoningMode }),
  });

  if (choice.name === 'puter') {
    say(
      provider.hasToken
        ? 'Connecting to Puter with PUTER_AUTH_TOKEN...'
        : 'Signing in to Puter: a browser window will open (or set PUTER_AUTH_TOKEN in .env to skip this)...',
    );
  } else {
    say(`Connecting to ${choice.name}...`);
  }
  await provider.connect();

  const agent = new Agent({ provider, registry, settings, guard, permissions, model: settings.model, mode: settings.mode });
  if (jsonMode) {
    // Scriptable run: no UI, nothing is asked (approvals are denied unless --access full / settings allow them).
    // SIGINT/SIGTERM cancel the request cleanly: the loop stops, history stays valid, JSON is still printed.
    const abort = new AbortController();
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => abort.abort());
    try {
      const res = await agent.run(cli.prompt, { signal: abort.signal });
      console.log(JSON.stringify({ result: res.content, stop_reason: res.stopReason, steps: res.steps, usage: res.usage, changes: res.changes, elapsed_ms: res.elapsedMs, cache: agent.cache.stats().total, is_error: res.stopReason !== 'done' }));
      process.exit(res.stopReason === 'done' ? 0 : 1);
    } catch (err) {
      console.log(JSON.stringify({ result: '', is_error: true, error: explainError(err) }));
      process.exit(1);
    }
  }
  const ui = new TerminalUI({ agent, provider, settings, version, tui });
  permissions.setPrompt((description, action) => ui.confirm(description, action));
  if (cli.prompt) {
    await ui.startOnce(cli.prompt);
    return;
  }
  await ui.start();
}

main().catch((err) => {
  console.error(color.red(`\n${explainError(err)}`));
  process.exit(1);
});
