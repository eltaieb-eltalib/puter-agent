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
  -h, --help                 Show this help

Provider: puter (default), gemini or openai. Pick with AGENT_PROVIDER in .env, config/connect.json, or /connect inside the app.
Authentication: PUTER_AUTH_TOKEN (puter, or sign in through the browser) / GEMINI_API_KEY (gemini) / OPENAI_API_KEY (openai), all in .env.`;

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
  const choice = resolveProvider({
    rootDir: ROOT,
    cliModel: cli.model,
    settingsModel: settings.model,
  });
  if (choice.unknown) console.log(color.yellow(`Unknown provider "${choice.unknown}", using puter.`));
  settings.model = choice.model;
  const provider = createProvider(choice.name, {
    timeoutMs: settings.requestTimeoutMs,
    ...(choice.name === 'gemini' && !process.env.GEMINI_THINKING_LEVEL && { thinkingLevel: choice.thinking ?? settings.gemini?.thinkingLevel }),
    ...(choice.name === 'openai' && !process.env.OPENAI_REASONING_EFFORT && { reasoningLevel: choice.thinking ?? settings.openai?.reasoningLevel }),
    ...(choice.name === 'openai' && !process.env.OPENAI_REASONING_MODE && { reasoningMode: choice.reasoningMode ?? settings.openai?.reasoningMode }),
  });

  if (choice.name === 'puter') {
    console.log(
      provider.hasToken
        ? 'Connecting to Puter with PUTER_AUTH_TOKEN...'
        : 'Signing in to Puter: a browser window will open (or set PUTER_AUTH_TOKEN in .env to skip this)...',
    );
  } else {
    console.log(`Connecting to ${choice.name}...`);
  }
  await provider.connect();

  const agent = new Agent({ provider, registry, settings, guard, permissions, model: settings.model, mode: settings.mode });
  const ui = new TerminalUI({ agent, provider, settings, version, tui });
  permissions.setPrompt((description) => ui.confirm(description));
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
