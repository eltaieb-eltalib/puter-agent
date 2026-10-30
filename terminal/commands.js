import fs from 'node:fs';
import path from 'node:path';
import { color } from '../utils/logger.js';
import { runSearch } from '../tools/web.js';
import { CONFIG_ROOT as DEFAULT_CONFIG_ROOT, updateSettings } from '../config/settings-store.js';
import { PROVIDER_NAMES, createProvider, readConnectFile } from '../providers/provider-manager.js';
import { pickDefaultModel } from '../providers/gemini.js';
import { pickDefaultOpenAIModel } from '../providers/openai.js';
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

async function changeWorkspace(ui, arg) {
  if (!arg) {
    console.log(`Workspace: ${ui.agent.guard.root}\nUsage: /workspace <folder>   (starts a new conversation)\n`);
    return;
  }
  const target = path.resolve(process.cwd(), unquote(arg));
  if (!fs.existsSync(target)) {
    const ok = await ui.confirm(`The folder does not exist. Create it?\n    ${target}`);
    if (!ok) return;
  }
  try {
    ui.agent.setWorkspace(target);
    console.log(`Workspace is now ${color.bold(ui.agent.guard.root)}\nConversation cleared.\n`);
  } catch (err) {
    console.log(color.red(`Could not use that folder: ${err.message}\n`));
  }
}

async function setMode(ui, mode) {
  ui.agent.setMode(mode);
  console.log(
    mode === 'plan'
      ? `Mode: ${color.yellow('PLAN')} - read-only: the agent can explore, search the web and plan, but cannot change anything. /build to execute.\n`
      : `Mode: ${color.green('BUILD')} - the agent can create, edit and run (risky actions still ask you).\n`,
  );
}

export const COMMANDS = {
  help: {
    usage: '/help',
    description: 'Show this list',
    run: () => {
      console.log('\nCommands:');
      for (const c of Object.values(COMMANDS)) console.log(`  ${c.usage.padEnd(22)} ${c.description}`);
      console.log('\nAnything else you type is sent to the agent as a task.\n');
    },
  },
  model: {
    usage: '/model [text|id]',
    description: 'Show or change the AI model (keeps the conversation)',
    run: async (ui, arg) => {
      if (!arg) console.log(`Current model: ${color.bold(ui.agent.model)}`);
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
      const named = words[0] && PROVIDER_NAMES.includes(words[0].toLowerCase()) ? words.shift().toLowerCase() : null;
      const modelArg = words.join(' ');
      if (!named && !modelArg) {
        console.log(`Usage: /connect [${PROVIDER_NAMES.join('|')}] [modelId|text]\n`);
        console.log(`Current: ${color.bold(ui.provider.name ?? 'puter')} / ${color.bold(ui.agent.model)}`);
        const saved = readConnectFile(configRoot());
        console.log(`Saved choice: ${color.bold(saved.provider ?? 'none')}${saved.models?.[saved.provider]?.model ? ` / ${saved.models[saved.provider].model}` : ''}`);
        console.log('Examples:\n  /connect openai                    (GPT-6.1 Sol default)\n  /connect openai gpt-6-astra\n  /thinking high                     (OpenAI/Gemini reasoning effort)\n  /reasoning-mode pro                (GPT-5.6/GPT-6 only)\n  /connect gemini                      (newest Gemini flash model)\n  /connect gemini gemini-3.8-flash\n  /connect puter nano\n  /model                               (list what the current provider offers)\n');
        return;
      }

      const providerBefore = ui.provider.name ?? 'puter';
      const target = named ?? providerBefore;
      if (target !== providerBefore) {
        let next;
        try {
          next = createProvider(target, {
            timeoutMs: ui.settings.requestTimeoutMs,
            ...(target === 'gemini' && !process.env.GEMINI_THINKING_LEVEL && { thinkingLevel: readConnectFile(configRoot()).models?.gemini?.thinking ?? ui.settings.gemini?.thinkingLevel }),
            ...(target === 'openai' && !process.env.OPENAI_REASONING_EFFORT && { reasoningLevel: readConnectFile(configRoot()).models?.openai?.thinking ?? ui.settings.openai?.reasoningLevel }),
            ...(target === 'openai' && !process.env.OPENAI_REASONING_MODE && { reasoningMode: readConnectFile(configRoot()).models?.openai?.reasoningMode ?? ui.settings.openai?.reasoningMode }),
          });
          await next.connect();
        } catch (err) {
          console.log(color.red(`Could not switch to ${target}: ${err.message}\n`));
          return;
        }
        ui.provider = next;
        ui.agent.provider = next;
        ui.models = [];
        // A model id from the previous provider is meaningless here: reset, then maybe pick below.
        const saved = readConnectFile(configRoot()).models?.[target]?.model;
        const models = await ui.getModels({ refresh: true });
        const fallback = target === 'gemini' ? pickDefaultModel(models) : target === 'openai' ? pickDefaultOpenAIModel(models) : models[0]?.id;
        ui.agent.setModel(saved || fallback || ui.agent.model);
      }
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
      console.log(`Connected (${target}). Model: ${color.bold(ui.agent.model)}\n`);
    },
  },
  thinking: {
    usage: '/thinking [level]',
    description: 'Set provider reasoning/thinking effort (available values depend on the model)',
    run: async (ui, arg) => {
      const provider = ui.provider;
      if (typeof provider.setThinkingLevel !== 'function') {
        console.log(color.yellow(`${provider.name ?? 'This provider'} does not expose a reasoning-effort setting.\n`));
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
        console.log(`Current ${provider.name === 'openai' ? 'reasoning effort' : 'thinking level'}: ${color.bold(provider.reasoningLevel ?? provider.thinkingLevel ?? 'off')}`);
        options.forEach(([name, note], i) => console.log(`  ${i + 1}. ${name.padEnd(7)} ${color.dim(note)}`));
        const pick = (await ui.rl.question('Number or name (Enter to cancel): ')).trim().toLowerCase();
        if (!pick) return;
        choice = options[Number(pick) - 1]?.[0] ?? pick;
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
      console.log(`${provider.name === 'gemini' ? 'Thinking level' : 'Reasoning effort'}: ${color.bold(level ?? 'off')}\n`);
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
        console.log(`Current OpenAI reasoning mode: ${color.bold(ui.provider.reasoningMode)}\n`);
        mode = (await ui.rl.question('Choose standard or pro (Enter to cancel): ')).trim().toLowerCase();
        if (!mode) return;
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
      console.log(`OpenAI reasoning mode: ${color.bold(mode)}\n`);
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
      if (!arg) {
        console.log(`Current mode: ${color.bold(ui.agent.mode)}\n`);
        return;
      }
      await setMode(ui, arg.toLowerCase());
    },
  },
  plan: { usage: '/plan', description: 'Switch to PLAN mode (read-only)', run: (ui) => setMode(ui, 'plan') },
  build: { usage: '/build', description: 'Switch to BUILD mode (full access)', run: (ui) => setMode(ui, 'build') },
  search: {
    usage: '/search <text>',
    description: 'Quick web search yourself (shows results, does not use the AI)',
    run: async (ui, arg) => {
      if (!arg) {
        console.log('Usage: /search <text>\n');
        return;
      }
      const ctx = { settings: ui.settings, signal: undefined };
      const { provider, results } = await runSearch(arg, ctx);
      console.log(color.dim(`via ${provider}`));
      results.forEach((r, i) => {
        console.log(`  ${i + 1}. ${color.bold(r.title)}\n     ${color.cyan(r.url)}\n     ${color.dim(r.snippet.slice(0, 160))}`);
      });
      console.log('');
    },
  },
  permissions: {
    usage: '/permissions [reset]',
    description: 'Show what you allowed with "always" (reset = ask again)',
    run: (ui, arg) => {
      const perms = ui.agent.permissions;
      if (arg === 'reset') {
        perms.revokeAll();
        console.log('All "always" permissions removed. The agent will ask again.\n');
        return;
      }
      const list = [...perms.granted];
      console.log(list.length ? `Allowed for this session: ${list.join(', ')}\n(/permissions reset to revoke)\n` : 'Nothing is set to "always". Every risky action asks first.\n');
    },
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
      const ok = await ui.agent.resume();
      console.log(ok ? `Conversation restored (${ui.agent.messages.length - 1} messages).\n` : 'No saved conversation in this workspace.\n');
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
        console.log('Nothing to undo.\n');
        return;
      }
      for (const f of res.restored) console.log(`  restored  ${f}`);
      for (const f of res.removed) console.log(`  removed   ${f}`);
      console.log(color.green(`Undone (${res.restored.length} restored, ${res.removed.length} removed).\n`));
    },
  },
  memory: {
    usage: '/memory [add|forget|clear] [text]',
    description: 'Long-term notes kept between sessions (shown to the agent in every request)',
    run: async (ui, arg) => {
      const root = ui.agent.guard.root;
      const [sub, ...rest] = (arg ?? '').trim().split(/\s+/);
      const text = rest.join(' ');
      if (sub === 'add' && text) {
        const r = await addMemory(root, text);
        console.log(r.added ? `Saved: ${r.note}\n` : 'Already in memory.\n');
      } else if (sub === 'forget' && text) {
        console.log(`${await forgetMemory(root, text)} note(s) removed.\n`);
      } else if (sub === 'clear') {
        await clearMemory(root);
        console.log('Memory cleared.\n');
      } else {
        const mem = readMemoryText(root);
        console.log(mem ? `${mem}\n` : 'Memory is empty. Use: /memory add <text>  (or ask the agent to "remember ...")\n');
      }
    },
  },
  tools: {
    usage: '/tools',
    description: 'List the tools the agent can use',
    run: (ui) => {
      console.log('');
      for (const t of ui.agent.registry.list()) {
        const first = t.description.split(/(?<=\.)\s/)[0];
        console.log(`  ${color.cyan(t.name.padEnd(18))} ${first}`);
      }
      console.log('');
    },
  },
  clear: {
    usage: '/clear',
    description: 'Start a fresh conversation',
    run: (ui) => {
      ui.agent.reset();
      console.log('Conversation cleared.\n');
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
