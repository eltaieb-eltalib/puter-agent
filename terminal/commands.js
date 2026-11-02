import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { color } from '../utils/logger.js';
import { runSearch } from '../tools/web.js';
import { CONFIG_ROOT as DEFAULT_CONFIG_ROOT, updateSettings } from '../config/settings-store.js';
import { PROVIDER_NAMES, createProvider, envKeyFor, readConnectFile } from '../providers/provider-manager.js';
import { saveEnvValue } from '../utils/env.js';
import { helpPage, menuPage, printCache, printContext, printHooks, printMcp, printPermissions, toolsPage } from './pages.js';
import { getProjectIndex } from '../core/project-index.js';
import { statusBar } from './components/panels.js';
import { ask, fail, hasTui, info, ok, page, pick, printPanel, warn, yesNo, G, dim, fg } from './ui-kit.js';
import { pickDefaultModel } from '../providers/gemini.js';
import { pickDefaultOpenAIModel } from '../providers/openai.js';
import { AGENTROUTER_DEFAULT_MODEL } from '../providers/agentrouter.js';
import { addMemory, clearMemory, forgetMemory, readMemoryText } from '../core/memory.js';

const MAX_SHOWN = 30;
// Where config/connect.json lives. AGENT_CONFIG_ROOT lets tests (or a portable setup) point somewhere else.
const configRoot = () => process.env.AGENT_CONFIG_ROOT || DEFAULT_CONFIG_ROOT;

function unquote(text) {
  const t = text.trim();
  return (t.startsWith('"') && t.endsWith('"') && t.length > 1) ||
    (t.startsWith("'") && t.endsWith("'") && t.length > 1)
    ? t.slice(1, -1)
    : t;
}

/**
 * /model [text] - pick a model. Exact id selects it; otherwise the text filters the list.
 * Puter lists hundreds of models, so we search instead of printing them all.
 */
export async function chooseModel(ui, arg) {
  const models = await ui.getModels();
  if (hasTui(ui)) return chooseModelTui(ui, arg, models);
  let query = arg;
  if (!query) {
    query = (await ui.rl.question('Search text or exact model id (Enter to cancel): ')).trim();
    if (!query) return;
  }

  const exact = models.find((m) => m.id === query);
  if (exact || models.length === 0) {
    if (!exact) console.log(color.yellow('Model list unavailable; using the id exactly as typed.'));
    ui.agent.setModel(query);
    console.log(`Model set to ${color.bold(query)}\n`);
    return;
  }

  const needle = query.toLowerCase();
  const matches = models.filter((m) => `${m.id} ${m.provider ?? ''}`.toLowerCase().includes(needle));
  if (matches.length === 0) {
    console.log(color.yellow(`No models match "${query}". Try /model again.\n`));
    return;
  }
  if (matches.length === 1) {
    ui.agent.setModel(matches[0].id);
    console.log(`Model set to ${color.bold(matches[0].id)}\n`);
    return;
  }

  matches.slice(0, MAX_SHOWN).forEach((m, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${m.id}${m.provider ? color.dim(` (${m.provider})`) : ''}`);
  });
  if (matches.length > MAX_SHOWN) {
    console.log(color.dim(`  ...and ${matches.length - MAX_SHOWN} more - refine the search text.`));
  }
  const pick = (await ui.rl.question('Number (Enter to cancel): ')).trim();
  const chosen = matches.slice(0, MAX_SHOWN)[Number(pick) - 1];
  if (!chosen) {
    console.log('Model unchanged.\n');
    return;
  }
  ui.agent.setModel(chosen.id);
  console.log(`Model set to ${color.bold(chosen.id)}\n`);
}

/** Searchable model list: type to filter, Enter selects, or type an exact id and press Enter. */
async function chooseModelTui(ui, arg, models) {
  const exact = arg && models.find((m) => m.id === arg);
  if (exact || (arg && models.length === 0)) {
    ui.agent.setModel(arg);
    ok(`Model: ${arg}`);
    return;
  }
  if (!models.length) {
    const typed = await ask(ui, { title: 'Model', label: 'id', placeholder: 'model id exactly as the provider names it', help: ['The model list is unavailable. Type the model id.'] });
    if (typed) {
      ui.agent.setModel(typed);
      ok(`Model: ${typed}`);
    }
    return;
  }
  const items = models.map((m) => ({ value: m.id, label: m.id, description: m.provider ?? '', current: m.id === ui.agent.model }));
  const chosen = await pick(ui, { title: 'Model', subtitle: `${ui.provider.name ?? 'puter'} · ${models.length} models`, items, current: ui.agent.model, filter: true, allowCustom: true, query: arg ?? '' });
  if (!chosen) return info('Model unchanged.');
  const id = typeof chosen === 'string' ? chosen : chosen.custom;
  ui.agent.setModel(id);
  ok(`Model: ${id}`);
}

async function changeWorkspace(ui, arg) {
  if (!arg) {
    if (!hasTui(ui)) {
      console.log(`Workspace: ${ui.agent.guard.root}\nUsage: /workspace <folder>   (starts a new conversation)\n`);
      return;
    }
    arg = await ask(ui, { title: 'Workspace folder', label: 'path', initial: ui.agent.guard.root, help: ['The agent works inside this folder. Changing it starts a new conversation.'] });
    if (!arg || arg === ui.agent.guard.root) return;
  }
  const target = path.resolve(process.cwd(), unquote(arg));
  if (!fs.existsSync(target)) {
    const create = await ui.confirm(`The folder does not exist. Create it?\n    ${target}`);
    if (!create) return;
  }
  try {
    ui.agent.setWorkspace(target);
    ok(`Workspace: ${ui.agent.guard.root}  ${dim('(conversation cleared)')}`);
  } catch (err) {
    fail(`Could not use that folder: ${err.message}`);
  }
}

async function setMode(ui, mode) {
  ui.agent.setMode(mode);
  if (mode === 'plan') ok(`${fg(215)('PLAN')} ${dim('read-only: explore, search and plan; nothing is changed. /build to execute.')}`);
  else ok(`${fg(43)('BUILD')} ${dim('create, edit and run; risky actions still ask you.')}`);
}

const git = (args, cwd) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 15000, windowsHide: true, maxBuffer: 2_000_000 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout ?? '').trimEnd(), err: String(stderr ?? err?.message ?? '').trim() }));
  });

const bar = (pct) => {
  const filled = Math.max(0, Math.min(20, Math.round(pct / 5)));
  return `[${'#'.repeat(filled)}${'.'.repeat(20 - filled)}]`;
};

export const COMMANDS = {
  menu: {
    usage: '/menu',
    description: 'Open the main menu (every page and setting)  [Ctrl+P]',
    run: (ui) => menuPage(ui, COMMANDS),
  },
  help: {
    usage: '/help',
    description: 'Commands and keyboard shortcuts',
    run: (ui) => helpPage(ui, COMMANDS),
  },
  model: {
    usage: '/model [text|id]',
    description: 'Pick the AI model (searchable list; keeps the conversation)',
    run: async (ui, arg) => {
      if (!arg && !hasTui(ui)) console.log(`Current model: ${color.bold(ui.agent.model)}`);
      await chooseModel(ui, arg);
    },
  },
  models: {
    usage: '/models',
    description: 'Refresh the model list from the current provider',
    run: async (ui) => {
      const list = await ui.getModels({ refresh: true });
      console.log(`${list.length} models available. Use /model <text> to search.\n`);
    },
  },
  connect: {
    usage: '/connect [provider] [model]',
    description: `Switch provider (${PROVIDER_NAMES.join(' | ')}) and/or model. Saved to config/connect.json`,
    run: async (ui, arg) => {
      const words = (arg ?? '').trim().split(/\s+/).filter(Boolean);
      const named0 = words[0] && PROVIDER_NAMES.includes(words[0].toLowerCase()) ? words.shift().toLowerCase() : null;
      let modelArg = words.join(' ');
      let named = named0;
      let viaPicker = false;
      if (!named && !modelArg && hasTui(ui)) {
        const saved = readConnectFile(configRoot());
        const nowName = ui.provider.name ?? 'puter';
        const chosenProvider = await pick(ui, {
          title: 'Provider',
          subtitle: `now: ${nowName} / ${ui.agent.model}`,
          items: PROVIDER_NAMES.map((name) => {
            const keyName = envKeyFor(name);
            const status = name === nowName ? 'connected' : keyName && !process.env[keyName] ? 'needs API key' : keyName ? 'key found' : 'no key needed';
            return { value: name, label: name, description: `${status}${saved.models?.[name]?.model ? ` · ${saved.models[name].model}` : ''}`, current: name === nowName };
          }),
          current: nowName,
          filter: true,
        });
        if (!chosenProvider) return info('Provider unchanged.');
        named = chosenProvider;
        viaPicker = true;
      }
      if (!named && !modelArg) {
        console.log(`Usage: /connect [${PROVIDER_NAMES.join('|')}] [modelId|text]\n`);
        console.log(`Current: ${color.bold(ui.provider.name ?? 'puter')} / ${color.bold(ui.agent.model)}`);
        const saved = readConnectFile(configRoot());
        console.log(`Saved choice: ${color.bold(saved.provider ?? 'none')}${saved.models?.[saved.provider]?.model ? ` / ${saved.models[saved.provider].model}` : ''}`);
        console.log('Examples:\n  /connect anyapi\n  /connect deepseek deepseek-chat\n  /connect openrouter deepseek/deepseek-chat-v3.1\n  /connect anthropic claude-sonnet-4-5\n  /connect ollama qwen2.5-coder:7b\n  /connect openai                    (GPT-6.1 Sol default)\n  /connect openai gpt-6-astra\n  /connect agentrouter              (AgentRouter / Responses API)\n  /connect agentrouter gpt-5.6-sol\n  /thinking high                     (OpenAI/Gemini reasoning effort)\n  /reasoning-mode pro                (GPT-5.6/GPT-6 only)\n  /connect gemini                      (newest Gemini flash model)\n  /connect gemini gemini-3.8-flash\n  /connect puter nano\n  /model                               (list what the current provider offers)\n');
        return;
      }

      const providerBefore = ui.provider.name ?? 'puter';
      const target = named ?? providerBefore;
      if (target !== providerBefore) {
        let next;
        const build = () => createProvider(target, {
            timeoutMs: ui.settings.requestTimeoutMs,
            ...(target === 'gemini' && !process.env.GEMINI_THINKING_LEVEL && { thinkingLevel: readConnectFile(configRoot()).models?.gemini?.thinking ?? ui.settings.gemini?.thinkingLevel }),
            ...(target === 'openai' && !process.env.OPENAI_REASONING_EFFORT && { reasoningLevel: readConnectFile(configRoot()).models?.openai?.thinking ?? ui.settings.openai?.reasoningLevel }),
            ...(target === 'openai' && !process.env.OPENAI_REASONING_MODE && { reasoningMode: readConnectFile(configRoot()).models?.openai?.reasoningMode ?? ui.settings.openai?.reasoningMode }),
          });
        try {
          try {
            next = build();
          } catch (err) {
            const keyName = envKeyFor(target);
            if (!keyName || !hasTui(ui) || !/Missing .*API_KEY|API key/i.test(err.message)) throw err;
            const key = await ask(ui, {
              title: `${target} API key`,
              label: keyName,
              mask: true,
              placeholder: 'paste the key',
              help: [`${target} needs an API key (${keyName}).`, 'It is saved in your .env file (readable only by you) and never shown again.'],
              validate: (v) => (v.length < 8 ? 'That looks too short for an API key.' : null),
            });
            if (!key) return info('Provider unchanged.');
            saveEnvValue(path.join(configRoot(), '.env'), keyName, key);
            next = build();
            ok(`Key saved to .env as ${keyName}`);
          }
          await next.connect();
        } catch (err) {
          fail(`Could not switch to ${target}: ${err.message}`);
          return;
        }
        ui.provider = next;
        ui.agent.provider = next;
        ui.models = [];
        // A model id from the previous provider is meaningless here: reset, then maybe pick below.
        const saved = readConnectFile(configRoot()).models?.[target]?.model;
        const models = await ui.getModels({ refresh: true });
        const fallback = target === 'gemini' ? pickDefaultModel(models) : target === 'openai' ? pickDefaultOpenAIModel(models) : target === 'agentrouter' ? AGENTROUTER_DEFAULT_MODEL : models[0]?.id;
        ui.agent.setModel(saved || fallback || ui.agent.model);
      }
      if (viaPicker && !modelArg) await chooseModel(ui, '');
      if (modelArg) {
        const before = ui.agent.model;
        await chooseModel(ui, modelArg);
        if (ui.agent.model === before && target === providerBefore) return; // nothing changed, nothing to save
      }

      const current = readConnectFile(configRoot());
      current.provider = target;
      current.models = current.models ?? {};
      current.models[target] = { ...(current.models[target] ?? {}), model: ui.agent.model };
      fs.writeFileSync(path.join(configRoot(), 'config', 'connect.json'), JSON.stringify(current, null, 2), 'utf8');
      if (target === 'puter') updateSettings(configRoot(), { model: ui.agent.model });
      ok(`Connected: ${target} / ${ui.agent.model}`);
    },
  },
  thinking: {
    usage: '/thinking [level]',
    description: 'Set provider reasoning/thinking effort (available values depend on the model)',
    run: async (ui, arg) => {
      const provider = ui.provider;
      if (typeof provider.setThinkingLevel !== 'function') {
        warn(`${provider.name ?? 'This provider'} does not expose a reasoning-effort setting.`);
        return;
      }
      const options = provider.name === 'openai'
        ? [
            ['none', 'no reasoning tokens (only on supported models)'],
            ['minimal', 'minimum reasoning (model-dependent)'],
            ['low', 'faster, lower token use'],
            ['medium', 'balanced'],
            ['high', 'deeper reasoning'],
            ['xhigh', 'very deep reasoning (model-dependent)'],
            ['max', 'maximum reasoning (model-dependent)'],
          ]
        : [
            ['low', 'fast, little thinking (default)'],
            ['medium', 'balanced'],
            ['high', 'slowest, most careful'],
            ['off', 'provider default'],
            ['minimal', 'minimum thinking (model-dependent)'],
          ];
      let choice = (arg ?? '').trim().toLowerCase();
      if (!choice) {
        const now = provider.reasoningLevel ?? provider.thinkingLevel ?? 'off';
        const picked = await pick(ui, {
          title: provider.name === 'openai' ? 'Reasoning effort' : 'Thinking level',
          subtitle: `${provider.name} · now: ${now}`,
          items: options.map(([value, description]) => ({ value, label: value, description })),
          current: now,
          filter: false,
        });
        if (!picked) return;
        choice = String(picked).toLowerCase();
      }
      if (!options.some(([name]) => name === choice)) {
        console.log(color.yellow(`Unknown level "${choice}". Available for ${provider.name}: ${options.map(([name]) => name).join(', ')}.\n`));
        return;
      }
      const level = provider.setThinkingLevel(choice);
      const current = readConnectFile(configRoot());
      current.models = current.models ?? {};
      current.models[provider.name] = { ...(current.models[provider.name] ?? {}), thinking: level ?? 'off' };
      fs.writeFileSync(path.join(configRoot(), 'config', 'connect.json'), JSON.stringify(current, null, 2), 'utf8');
      ok(`${provider.name === 'gemini' ? 'Thinking level' : 'Reasoning effort'}: ${level ?? 'off'}`);
    },
  },
  'reasoning-mode': {
    usage: '/reasoning-mode [standard|pro]',
    description: 'OpenAI GPT-5.6/GPT-6 Responses API reasoning mode',
    run: async (ui, arg) => {
      if (ui.provider.name !== 'openai' || typeof ui.provider.setReasoningMode !== 'function') {
        console.log(color.yellow('This command is available only with /connect openai.\n'));
        return;
      }
      let mode = (arg ?? '').trim().toLowerCase();
      if (!mode) {
        const picked = await pick(ui, {
          title: 'Reasoning mode',
          subtitle: `OpenAI · now: ${ui.provider.reasoningMode}`,
          items: [{ value: 'standard', label: 'standard', description: 'default' }, { value: 'pro', label: 'pro', description: 'deeper, slower (GPT-5.6 / GPT-6)' }],
          current: ui.provider.reasoningMode,
          filter: false,
          plainPrompt: 'Choose standard or pro (Enter to cancel): ',
        });
        if (!picked) return;
        mode = String(picked).toLowerCase();
      }
      try {
        mode = ui.provider.setReasoningMode(mode);
      } catch (err) {
        console.log(color.yellow(`${err.message}\n`));
        return;
      }
      const current = readConnectFile(configRoot());
      current.models = current.models ?? {};
      current.models.openai = { ...(current.models.openai ?? {}), reasoningMode: mode };
      fs.writeFileSync(path.join(configRoot(), 'config', 'connect.json'), JSON.stringify(current, null, 2), 'utf8');
      ok(`OpenAI reasoning mode: ${mode}`);
    },
  },
  workspace: {
    usage: '/workspace [folder]',
    description: 'Show or change the workspace folder',
    run: changeWorkspace,
  },
  mode: {
    usage: '/mode [plan|build]',
    description: 'Show or switch mode (plan = read-only, build = full access)',
    run: async (ui, arg) => {
      let mode = (arg ?? '').toLowerCase();
      if (!mode) {
        mode = await pick(ui, {
          title: 'Mode',
          subtitle: `now: ${ui.agent.mode}`,
          items: [
            { value: 'build', label: 'BUILD', description: 'create, edit and run (risky actions still ask)' },
            { value: 'plan', label: 'PLAN', description: 'read-only: explore, search the web, make a plan' },
          ],
          current: ui.agent.mode,
          filter: false,
          plainPrompt: 'plan or build (Enter to cancel): ',
        });
        if (!mode) return;
      }
      await setMode(ui, mode);
    },
  },
  plan: { usage: '/plan', description: 'Switch to PLAN mode (read-only)', run: (ui) => setMode(ui, 'plan') },
  build: { usage: '/build', description: 'Switch to BUILD mode (full access)', run: (ui) => setMode(ui, 'build') },
  search: {
    usage: '/search [text]',
    description: 'Quick web search yourself (shows results, does not use the AI)',
    run: async (ui, arg) => {
      let query = arg;
      if (!query) query = await ask(ui, { title: 'Web search', label: 'text', placeholder: 'what to look for', plainPrompt: 'Search text (Enter to cancel): ' });
      if (!query) return;
      const ctx = { settings: ui.settings, signal: undefined };
      let found;
      try {
        found = await runSearch(query, ctx);
      } catch (err) {
        fail(`Search failed: ${err.message}`);
        return;
      }
      const lines = [];
      found.results.forEach((r, i) => {
        lines.push(`${fg(141)(String(i + 1).padStart(2))}  ${color.bold(r.title)}`, `    ${fg(80)(r.url)}`, `    ${dim(r.snippet.slice(0, 200))}`, '');
      });
      await page(ui, `Search: ${query}`, lines.length ? lines : [dim('No results.')], `via ${found.provider}`);
    },
  },
  permissions: {
    usage: '/permissions [reset]',
    description: 'Show what you allowed with "always" (reset = ask again)',
    run: async (ui, arg) => {
      const perms = ui.agent.permissions;
      if (arg === 'reset') {
        perms.revokeAll();
        ok('All "always" permissions removed. The agent will ask again.');
        return;
      }
      printPermissions(ui);
      if (perms.granted.size && hasTui(ui)) {
        if (await yesNo(ui, { title: 'Revoke all "always" permissions?', lines: [`${[...perms.granted].join(', ')}`], yesLabel: 'Revoke', noLabel: 'Keep' })) {
          perms.revokeAll();
          ok('All "always" permissions removed.');
        }
      }
    },
  },
  access: {
    usage: '/access [workspace|ask|full]',
    description: 'Access level: workspace = this folder only, ask = outside asks, full = any folder + commands without asking',
    run: async (ui, arg) => {
      const perms = ui.agent.permissions;
      let level = (arg ?? '').trim().toLowerCase();
      if (!level) {
        level = await pick(ui, {
          title: 'Access level',
          subtitle: `now: ${perms.accessLevel}`,
          items: [
            { value: 'workspace', label: 'workspace', description: 'this folder only; commands ask' },
            { value: 'ask', label: 'ask', description: 'other folders ask first (default)' },
            { value: 'full', label: 'full', description: 'any folder on the computer; commands run without asking' },
          ],
          current: perms.accessLevel,
          filter: false,
          plainPrompt: 'workspace, ask or full (Enter to cancel): ',
        });
        if (!level) return;
      }
      if (level === 'full' && perms.accessLevel !== 'full') {
        const sure = await yesNo(ui, {
          title: 'FULL access',
          lines: ['The agent can run commands and read or write ANY folder without asking.', 'Deleting, overwriting, moving and reading secret files still ask. Catastrophic commands stay blocked.'],
          danger: true,
          yesLabel: 'Allow full access',
          noLabel: 'Cancel',
        });
        if (!sure) return info('Cancelled.');
      }
      try {
        perms.setAccess(level);
      } catch (err) {
        warn(err.message);
        return;
      }
      ok(`Access: ${level}  ${dim('(this session; make it permanent in config/settings.json)')}`);
    },
  },
  compact: {
    usage: '/compact',
    description: 'Summarise the conversation so far to free up context',
    run: async (ui) => {
      const done = await ui.agent.compactNow();
      (done ? ok('Conversation compacted.') : info('Nothing to compact yet (need more than one earlier message).'));
    },
  },
  export: {
    usage: '/export',
    description: 'Save this conversation as a Markdown file in .puter-agent/exports',
    run: async (ui) => {
      const dir = path.join(ui.agent.guard.root, '.puter-agent', 'exports');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `chat-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
      const body = ui.agent.messages
        .slice(1)
        .filter((m) => m.role === 'user' || (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()))
        .map((m) => `## ${m.role === 'user' ? 'User' : 'Assistant'}\n\n${m.content}`)
        .join('\n\n');
      if (!body) {
        info('Nothing to export yet.');
        return;
      }
      fs.writeFileSync(file, `# Puter Agent conversation\n\n${body}\n`, 'utf8');
      ok(`Saved ${file}`);
    },
  },
  context: {
    usage: '/context',
    description: 'How full the conversation is, and token usage this session',
    run: (ui) => printContext(ui),
  },
  diff: {
    usage: '/diff',
    description: 'Git status and the changed lines in the workspace (needs git)',
    run: async (ui) => {
      const cwd = ui.agent.guard.root;
      const status = await git(['status', '--short', '--branch'], cwd);
      if (!status.ok) {
        warn(`Not a git repository (or git is missing): ${status.err.split('\n')[0]}`);
        return;
      }
      const lines = [color.bold('Status'), ...(status.out || '(clean)').split('\n').map((l) => `  ${l}`), ''];
      const stat = await git(['diff', '--stat', 'HEAD'], cwd);
      if (stat.ok && stat.out) lines.push(color.bold('Summary'), ...stat.out.split('\n').map((l) => `  ${l}`), '');
      const patch = await git(['diff', 'HEAD', '--unified=2'], cwd);
      if (patch.ok && patch.out) {
        lines.push(color.bold('Changes'));
        for (const l of patch.out.split('\n').slice(0, 600)) {
          lines.push(l.startsWith('+') && !l.startsWith('+++') ? color.green(l) : l.startsWith('-') && !l.startsWith('---') ? color.red(l) : l.startsWith('@@') ? color.cyan(l) : color.dim(l));
        }
      }
      await page(ui, 'Git changes', lines, 'working tree vs HEAD');
    },
  },
  rewind: {
    usage: '/rewind',
    description: 'Go back to before an earlier task (restores every file changed since then)',
    run: async (ui) => {
      const list = (await ui.agent.checkpoints()).slice(0, 12);
      if (!list.length) {
        info('No checkpoints yet: nothing the agent changed is recorded.');
        return;
      }
      const items = list.map((c, i) => ({
        value: c.id,
        label: `${i === 0 ? 'latest  ' : ''}${c.id.replace('T', ' ').slice(0, 19)}`,
        description: `${c.files} file(s): ${c.paths.slice(0, 3).join(', ')}${c.paths.length > 3 ? ', …' : ''}`,
      }));
      const id = await pick(ui, { title: 'Rewind', subtitle: 'go back to BEFORE this task', items, filter: false, plainPrompt: 'Rewind to BEFORE number (Enter to cancel): ' });
      if (!id) return info('Cancelled.');
      const count = items.findIndex((i) => i.value === id) + 1;
      const sure = await yesNo(ui, { title: 'Rewind files?', lines: [`This undoes ${count} task(s) and restores every file they changed.`], danger: true, yesLabel: 'Rewind', noLabel: 'Cancel' });
      if (!sure) return info('Cancelled.');
      const undone = await ui.agent.rewind(id);
      const restored = undone?.reduce((n, u) => n + u.restored.length + u.removed.length, 0) ?? 0;
      ok(`Rewound ${undone?.length ?? 0} task(s), ${restored} file change(s) reverted.`);
    },
  },
  mcp: {
    usage: '/mcp',
    description: 'MCP servers and the tools they added',
    run: (ui) => printMcp(ui),
  },
  hooks: {
    usage: '/hooks',
    description: 'Active hooks and command allow/deny rules',
    run: (ui) => printHooks(ui),
  },
  todos: {
    usage: '/todos',
    description: 'Show the agent checklist',
    run: (ui) => {
      const list = ui.agent.state.todos;
      if (!list.length) console.log('No checklist yet.\n');
      else {
        ui.printTodos(list);
        console.log('');
      }
    },
  },
  resume: {
    usage: '/resume',
    description: 'Restore the last conversation saved in this workspace',
    run: async (ui) => {
      const restored = await ui.agent.resume();
      (restored ? ok(`Conversation restored (${ui.agent.messages.length - 1} messages).`) : info('No saved conversation in this workspace.'));
    },
  },
  init: {
    usage: '/init',
    description: 'Let the agent study the project and write AGENTS.md (project notes)',
    run: async (ui) => {
      await setMode(ui, 'build');
      await ui.runOnce(
        'Study this workspace (list files, read the main files) and create AGENTS.md at the workspace root: a short guide (max 40 lines) with what the project is, how to run/test it, folder structure and coding conventions. If AGENTS.md exists, improve it instead of replacing it blindly.',
      );
    },
  },
  undo: {
    usage: '/undo',
    description: 'Put back the files changed by the last task (restores edits, removes created files)',
    run: async (ui) => {
      const res = await ui.agent.undo();
      if (!res) {
        info('Nothing to undo.');
        return;
      }
      for (const f of res.restored) console.log(`  restored  ${f}`);
      for (const f of res.removed) console.log(`  removed   ${f}`);
      ok(`Undone (${res.restored.length} restored, ${res.removed.length} removed).`);
    },
  },
  memory: {
    usage: '/memory [add|forget|clear] [text]',
    description: 'Long-term notes kept between sessions (shown to the agent in every request)',
    run: async (ui, arg) => {
      const root = ui.agent.guard.root;
      let [sub, ...rest] = (arg ?? '').trim().split(/\s+/);
      let text = rest.join(' ');
      if (!sub && hasTui(ui)) {
        const mem = readMemoryText(root);
        const action = await pick(ui, {
          title: 'Memory',
          subtitle: mem ? `${mem.split('\n').filter(Boolean).length} note(s)` : 'empty',
          items: [
            { value: 'view', label: 'View notes', description: 'read what the agent remembers' },
            { value: 'add', label: 'Add a note', description: 'kept between sessions' },
            { value: 'forget', label: 'Forget a note', description: 'remove notes containing some text' },
            { value: 'clear', label: 'Clear everything', description: 'delete all notes' },
          ],
          filter: false,
        });
        if (!action) return;
        sub = action;
        if (action === 'view') {
          await page(ui, 'Memory', mem ? mem.split('\n') : [dim('Empty. Add a note, or ask the agent to "remember ...".')]);
          return;
        }
        if (action === 'add' || action === 'forget') {
          text = await ask(ui, { title: action === 'add' ? 'Add a note' : 'Forget notes containing', label: 'text', placeholder: action === 'add' ? 'something to remember' : 'part of the note' });
          if (!text) return;
        }
        if (action === 'clear' && !(await yesNo(ui, { title: 'Delete all notes?', danger: true, yesLabel: 'Delete', noLabel: 'Keep' }))) return;
      }
      if (sub === 'add' && text) {
        const r = await addMemory(root, text);
        (r.added ? ok(`Saved: ${r.note}`) : info('Already in memory.'));
      } else if (sub === 'forget' && text) {
        ok(`${await forgetMemory(root, text)} note(s) removed.`);
      } else if (sub === 'clear') {
        await clearMemory(root);
        ok('Memory cleared.');
      } else {
        const mem = readMemoryText(root);
        console.log(mem ? `${mem}\n` : 'Memory is empty. Use: /memory add <text>  (or ask the agent to "remember ...")\n');
      }
    },
  },
  history: {
    usage: '/history',
    description: 'Scroll back through this session (messages, answers, tool steps)',
    run: async (ui) => {
      const lines = ui.transcript?.lines({ rtl: ui.ui?.rtl }) ?? [];
      await page(ui, 'History', lines, `${ui.transcript?.size ?? 0} entries · ↑/↓ PgUp/PgDn scroll · q close`);
    },
  },
  last: {
    usage: '/last',
    description: 'Show the full diff / file / command output of the last change',
    run: async (ui) => {
      const lines = ui.lastPreviewLines?.();
      if (!lines) return info('No file change or command yet.');
      await page(ui, 'Last change', lines);
    },
  },
  preview: {
    usage: '/preview [smart|full|off] [lines]',
    description: 'How writes/commands are shown: smart (compact diff, default), full, off',
    run: (ui, arg) => {
      const [mode, n] = String(arg ?? '').split(/\s+/);
      if (!mode) return info(`Preview: ${ui.ui.preview} (${ui.ui.previewLines} lines max)`);
      if (!['smart', 'full', 'off'].includes(mode)) return warn('Use: /preview smart | full | off [lines]');
      ui.ui.preview = mode;
      if (Number(n) > 0) ui.ui.previewLines = Math.min(200, Number(n));
      ok(`Preview: ${mode}${Number(n) > 0 ? ` (${ui.ui.previewLines} lines max)` : ''}`);
    },
  },
  cache: {
    usage: '/cache [clear [files|tools|model]]',
    description: 'Local cache sizes and hit/miss counts; clear them',
    run: (ui, arg) => {
      const [sub, which = 'all'] = String(arg ?? '').split(/\s+/);
      if (sub === 'clear') {
        try {
          ui.agent.cache.clear(which);
        } catch (err) {
          warn(err.message);
          return;
        }
        ok(`Cache cleared: ${which}.`);
        return;
      }
      printCache(ui);
    },
  },
  stats: {
    usage: '/stats',
    description: 'Tokens, provider-cache share, calls, latency and memory for this session',
    run: (ui) => {
      const c = ui.agent.contextInfo();
      console.log(`\n${statusBar({ usage: c.session, context: { tokens: c.tokens, percent: c.tokenPercent }, cache: c.cache, steps: c.session.modelCalls, elapsedMs: c.session.latencyMs })}\n`);
    },
  },
  index: {
    usage: '/index',
    description: 'Scan the workspace (incremental) and show the project overview the agent uses',
    run: async (ui) => {
      const idx = getProjectIndex(ui.agent.guard.root);
      const t = Date.now();
      const scan = await idx.scan();
      const o = idx.overview();
      const ch = scan.changes;
      printPanel('Project index', [
        { rows: [['Files', `${o.files}${o.truncated ? ' (capped)' : ''} · ${o.symbols} definitions · scanned in ${Date.now() - t} ms`], ['Languages', o.languages.slice(0, 6).map((l) => `${l.name} ${dim(l.files)}`).join('  ') || dim('none')], ['Changed', scan.first ? dim('first scan') : `${ch.added.length} added · ${ch.modified.length} modified · ${ch.removed.length} removed`]] },
        { heading: 'Key files', rows: o.important.length ? o.important.slice(0, 12) : [dim('none found')] },
        { heading: 'Entry points', rows: o.entry_points.length ? o.entry_points.slice(0, 8) : [dim('none found')] },
        { heading: 'Most imported', rows: o.most_imported.length ? o.most_imported.slice(0, 6) : [dim('no internal imports')] },
      ], { hint: 'Saved in .puter-agent/index.json · only changed files are re-read next time' });
    },
  },
  audit: {
    usage: '/audit [n]',
    description: 'Recent executed operations and approval decisions (.puter-agent/audit.log)',
    run: async (ui, arg) => {
      const entries = await ui.agent.audit.tail(Number(arg) || 20);
      if (!entries.length) return info('No operations recorded yet.');
      const rows = entries.map((e) => `${dim(e.at.slice(11, 19))} ${e.ok ? fg(78)(G.ok) : fg(203)('✗')} ${e.tool}${e.answer ? ` ${dim(e.answer)}` : ''} ${dim(JSON.stringify(e.args).slice(0, 90))}`);
      printPanel('Audit log', [{ rows }], { hint: ui.agent.audit.file });
    },
  },
  tools: {
    usage: '/tools',
    description: 'List the tools the agent can use',
    run: (ui) => toolsPage(ui),
  },
  clear: {
    usage: '/clear',
    description: 'Start a fresh conversation',
    run: (ui) => {
      ui.agent.reset();
      ui.transcript?.clear();
      ok('Conversation cleared.');
    },
  },
  exit: {
    usage: '/exit',
    description: 'Quit',
    run: (ui) => ui.rl.close(),
  },
};
COMMANDS.quit = { ...COMMANDS.exit, usage: '/quit', description: 'Quit (same as /exit)', hidden: true };

export async function runCommand(ui, line) {
  const match = line.match(/^\/(\S+)\s*(.*)$/s);
  const name = match?.[1].toLowerCase();
  const command = name && COMMANDS[name];
  if (!command) {
    console.log(color.yellow(`Unknown command ${line.split(/\s/)[0]}. Type /help.\n`));
    return;
  }
  try {
    await command.run(ui, unquote(match[2] ?? ''));
  } catch (err) {
    console.log(color.red(`Command failed: ${err.message}\n`));
  }
}
