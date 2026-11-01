// Full TUI pages: main menu, help, context, MCP, hooks, tools, permissions.
import { listCustomCommands } from '../core/custom-commands.js';
import { listAgents } from '../core/agents.js';
import { G, bold, dim, fg, meter, page, panel, pick, printPanel } from './ui-kit.js';

const cyan = fg(80);
const green = fg(78);
const red = fg(203);
const yellow = fg(221);

const GROUPS = {
  Session: ['clear', 'resume', 'compact', 'export', 'undo', 'rewind', 'init', 'todos', 'exit'],
  'Model & provider': ['model', 'models', 'connect', 'thinking', 'reasoning-mode'],
  'Safety & access': ['mode', 'plan', 'build', 'access', 'permissions', 'hooks'],
  'Look around': ['context', 'diff', 'tools', 'mcp', 'memory', 'search', 'workspace'],
  Interface: ['menu', 'help'],
};

const SHORTCUTS = [
  ['Enter', 'send the message'],
  ['Ctrl+J / Alt+Enter', 'new line (or end a line with \\)'],
  ['Shift+Tab', 'switch PLAN / BUILD'],
  ['Ctrl+P', 'open the menu'],
  ['/', 'command list (type to filter, Tab to pick)'],
  ['↑ / ↓', 'history (or move in lists)'],
  ['@file', 'attach a file or folder to your message'],
  ['Esc', 'close a menu / go back'],
  ['Ctrl+C', 'stop the agent (twice to quit)'],
];

export function helpLines(commands, workspace) {
  const out = [];
  const seen = new Set();
  for (const [group, names] of Object.entries(GROUPS)) {
    out.push(bold(cyan(group)));
    for (const n of names) {
      const c = commands[n];
      if (!c || c.hidden) continue;
      seen.add(n);
      out.push(`  ${fg(250)(c.usage.padEnd(30))} ${dim(c.description)}`);
    }
    out.push('');
  }
  const rest = Object.entries(commands).filter(([n, c]) => !seen.has(n) && !c.hidden);
  if (rest.length) {
    out.push(bold(cyan('Other')));
    for (const [, c] of rest) out.push(`  ${fg(250)(c.usage.padEnd(30))} ${dim(c.description)}`);
    out.push('');
  }
  const custom = listCustomCommands(workspace);
  if (custom.length) {
    out.push(bold(cyan('Your commands (.puter-agent/commands)')));
    for (const c of custom) out.push(`  ${fg(250)(`/${c.name}`.padEnd(30))} ${dim(c.description)}`);
    out.push('');
  }
  const agents = listAgents(workspace);
  if (agents.length) {
    out.push(bold(cyan('Your sub-agents (.puter-agent/agents)')));
    for (const a of agents) out.push(`  ${fg(250)(a.name.padEnd(30))} ${dim(a.description)}`);
    out.push('');
  }
  out.push(bold(cyan('Shortcuts')));
  for (const [k, d] of SHORTCUTS) out.push(`  ${fg(250)(k.padEnd(30))} ${dim(d)}`);
  out.push('', dim('Anything else you type is sent to the agent as a task.'));
  return out;
}

export const helpPage = (ui, commands) => page(ui, 'Help', helpLines(commands, ui.agent.guard.root), 'commands & shortcuts');

export function contextSections(c) {
  const pct = Math.min(100, c.percent);
  const used = c.chars.toLocaleString();
  return [
    {
      heading: 'Conversation',
      rows: [
        ['Fill', `${meter(pct)} ${pct >= 90 ? red(`${c.percent}%`) : pct >= 60 ? yellow(`${c.percent}%`) : green(`${c.percent}%`)} ${dim('of the auto-compact limit')}`],
        ['Size', `${used} chars ${dim(`(about ${c.approxTokens.toLocaleString()} tokens, limit ${c.limit.toLocaleString()} chars)`)}`],
        ['Messages', `${c.messages}`],
      ],
    },
    {
      heading: 'Where the space goes (chars)',
      rows: [
        ['System prompt', c.byRole.system.toLocaleString()],
        ['Your messages', c.byRole.user.toLocaleString()],
        ['Agent replies', c.byRole.assistant.toLocaleString()],
        ['Tool results', c.byRole.tool.toLocaleString()],
      ],
    },
    {
      heading: 'This session',
      rows: [
        ['Requests', `${c.session.tasks}`],
        ['Tokens', `${c.session.totalTokens.toLocaleString()} ${dim(`(${c.session.cachedTokens.toLocaleString()} cached)`)}`],
        ['Calls', `${c.session.modelCalls} model · ${c.session.toolCalls} tool`],
        ['Tools offered', `${c.tools} registered ${dim('(only the ones a request needs are sent)')}`],
      ],
    },
  ];
}

export function printContext(ui) {
  const c = ui.agent.contextInfo();
  printPanel('Context', contextSections(c), { hint: c.percent >= 60 ? 'Tip: /compact summarises old messages, /clear starts fresh' : undefined });
}

export function printMcp(ui) {
  const reg = ui.agent.registry;
  const status = reg.mcpStatus ?? [];
  if (!status.length) {
    printPanel('MCP servers', [{ rows: [dim('None configured.'), dim('Add servers under "mcpServers" in config/settings.json (see README).')] }]);
    return;
  }
  const sections = status.map((s) => {
    const prefix = `mcp__${s.name.replace(/[^a-zA-Z0-9_-]/g, '_')}__`;
    const tools = reg.list().filter((t) => t.name.startsWith(prefix)).map((t) => t.name.slice(prefix.length));
    return {
      heading: s.name,
      rows: s.ok ? [['Status', green(`${G.dot} connected`)], ['Tools', tools.length ? tools.join(', ') : dim('(none)')]] : [['Status', red(`${G.off} failed`)], ['Error', red(s.error)]],
    };
  });
  printPanel('MCP servers', sections, { subtitle: `${status.filter((s) => s.ok).length}/${status.length} connected` });
}

export function printHooks(ui) {
  const cfg = ui.settings.hooks ?? {};
  const rules = ui.settings.rules ?? {};
  const hookRows = [];
  for (const event of ['PreToolUse', 'PostToolUse']) {
    for (const h of cfg[event] ?? []) hookRows.push([event, `${dim(h.matcher || '*')}  ${G.sel}  ${h.command}`]);
  }
  const sections = [
    { heading: 'Hooks', rows: hookRows.length ? hookRows : [dim('None. Add "hooks" in config/settings.json.')] },
    { heading: 'Auto-allowed commands', rows: (rules.allowCommands ?? []).length ? rules.allowCommands.map((p) => `${green(G.ok)} ${p}`) : [dim('None')] },
    { heading: 'Always-refused commands', rows: (rules.denyCommands ?? []).length ? rules.denyCommands.map((p) => `${red('✗')} ${p}`) : [dim('None')] },
  ];
  printPanel('Hooks & command rules', sections, { hint: 'Edit them in config/settings.json' });
}

export function toolLines(ui) {
  const reg = ui.agent.registry.list();
  const w = Math.min(30, Math.max(...reg.map((t) => t.name.length)) + 2);
  return reg.map((t) => `  ${cyan(t.name.padEnd(w))} ${dim(t.description.split(/(?<=\.)\s/)[0])}${t.readOnly ? dim('  [read-only]') : ''}`);
}

export const toolsPage = (ui) => page(ui, 'Tools', toolLines(ui), `${ui.agent.registry.list().length} available to the agent`);

export function printPermissions(ui) {
  const perms = ui.agent.permissions;
  const levelText = { workspace: 'workspace only', ask: 'ask outside the workspace', full: 'FULL: any folder, commands run without asking', custom: 'custom (from settings)' };
  const granted = [...perms.granted];
  printPanel('Permissions', [
    {
      rows: [
        ['Mode', ui.agent.mode === 'plan' ? yellow('PLAN (read-only)') : green('BUILD')],
        ['Access level', perms.accessLevel === 'full' ? red(levelText.full) : levelText[perms.accessLevel] ?? perms.accessLevel],
      ],
    },
    { heading: 'Allowed with "always" this session', rows: granted.length ? granted.map((g) => `${green(G.dot)} ${g}`) : [dim('Nothing. Every risky action asks first.')] },
    { heading: 'Always asks (even in full access)', rows: [dim('delete · overwrite · move · reading secret files')] },
  ], { hint: '/access changes the level · /permissions reset revokes "always"' });
}

/** The main menu: every page and setting, with its current value. */
export async function menuPage(ui, commands) {
  const a = ui.agent;
  const provider = ui.provider?.name ?? 'puter';
  const items = [];
  const add = (group, label, description, value) => items.push({ group, label, description, value });
  add('Session', 'New conversation', 'clear the context', '/clear');
  add('Session', 'Resume last conversation', 'restore the saved chat of this folder', '/resume');
  add('Session', 'Compact context', 'summarise old messages', '/compact');
  add('Session', 'Undo last task', 'put back changed files', '/undo');
  add('Session', 'Rewind…', 'go back to before an earlier task', '/rewind');
  add('Session', 'Export conversation', 'save as Markdown', '/export');
  add('Model & provider', 'Model', a.model, '/model');
  add('Model & provider', 'Provider', provider, '/connect');
  if (typeof ui.provider?.setThinkingLevel === 'function') add('Model & provider', 'Reasoning effort', ui.thinkingLabel().replace(/^ \(|\)$/g, '') || 'change', '/thinking');
  add('Safety & access', 'Mode', a.mode === 'plan' ? 'PLAN (read-only)' : 'BUILD', '/mode');
  add('Safety & access', 'Access level', a.permissions.accessLevel, '/access');
  add('Safety & access', 'Permissions', `${a.permissions.granted.size} allowed with "always"`, '/permissions');
  add('Safety & access', 'Hooks & command rules', 'what runs around tool calls', '/hooks');
  add('Look around', 'Context usage', 'how full the conversation is', '/context');
  add('Look around', 'Git changes', 'status and changed lines', '/diff');
  add('Look around', 'Tools', `${a.registry.list().length} available`, '/tools');
  add('Look around', 'MCP servers', `${(a.registry.mcpStatus ?? []).filter((s) => s.ok).length} connected`, '/mcp');
  add('Look around', 'Memory', 'notes kept between sessions', '/memory');
  add('Look around', 'Checklist', `${a.state.todos.length} item(s)`, '/todos');
  add('Project', 'Workspace folder', a.guard.root, '/workspace');
  add('Project', 'Study this project', 'write AGENTS.md', '/init');
  add('Project', 'Search the web', 'quick search, no AI', '/search');
  add('Help', 'Help & shortcuts', 'all commands and keys', '/help');
  add('Help', 'Quit', '', '/exit');
  const choice = await pick(ui, { title: 'Menu', subtitle: 'every page and setting', items, filter: true });
  if (!choice) return;
  const [name, ...rest] = choice.slice(1).split(' ');
  await commands[name].run(ui, rest.join(' '));
}
