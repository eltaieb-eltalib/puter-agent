import { spawn } from 'node:child_process';
import { ToolError } from '../utils/errors.js';
import { redactSecrets } from '../utils/redact.js';
import { requireApproval } from '../tools/helpers.js';

const PROTOCOL = '2024-11-05';
const SECRET_ENV = ['PUTER_AUTH_TOKEN', 'GEMINI_API_KEY', 'OPENAI_API_KEY'];

/**
 * Minimal MCP client over stdio (newline-delimited JSON-RPC 2.0): initialize, tools/list, tools/call.
 * Enough to plug in the many existing MCP servers (filesystem, git, databases, browsers...).
 */
export class McpClient {
  constructor(name, config, { requestTimeoutMs = 30000, callTimeoutMs = 120000 } = {}) {
    this.name = name;
    this.config = config;
    this.requestTimeoutMs = requestTimeoutMs;
    this.callTimeoutMs = callTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.child = null;
    this.closed = false;
  }

  async connect(cwd) {
    const { command, args = [], env = {} } = this.config;
    if (typeof command !== 'string' || !command.trim()) throw new Error('missing "command"');
    const childEnv = { ...process.env, ...env };
    for (const k of SECRET_ENV) if (!(k in env)) delete childEnv[k];
    this.child = spawn(command, args.map(String), { cwd, env: childEnv, shell: process.platform === 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (d) => this.#onData(d));
    this.child.stderr.on('data', (d) => {
      this.stderr = (this.stderr + d.toString('utf8')).slice(-2000);
    });
    this.child.stdin.on('error', () => {});
    const failAll = (why) => {
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(why));
      }
      this.pending.clear();
    };
    this.child.on('error', (err) => failAll(`could not start: ${err.message}`));
    this.child.on('close', (code) => failAll(`server exited (code ${code})${this.stderr ? `: ${this.stderr.trim().slice(-300)}` : ''}`));

    await this.#request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'puter-agent', version: '0.2' } });
    this.#send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  #send(msg) {
    if (this.closed || !this.child?.stdin?.writable) throw new Error('server is not running');
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  #request(method, params, timeoutMs = this.requestTimeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('server is not running'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.#send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  #onData(chunk) {
    this.buffer += chunk.toString('utf8');
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not JSON (a stray log line)
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      } else if (msg.id !== undefined && msg.method) {
        // The server asks us something (ping, roots/list...): answer so it never waits for us.
        try {
          if (msg.method === 'ping') this.#send({ jsonrpc: '2.0', id: msg.id, result: {} });
          else this.#send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not supported by puter-agent' } });
        } catch {
          /* closed */
        }
      }
    }
  }

  async listTools() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const res = await this.#request('tools/list', cursor ? { cursor } : {});
      tools.push(...(res.tools ?? []));
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  callTool(name, args) {
    return this.#request('tools/call', { name, arguments: args ?? {} }, this.callTimeoutMs);
  }

  close() {
    this.closed = true;
    try {
      this.child?.kill();
    } catch {
      /* gone */
    }
  }
}

const safe = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');

export function mcpToolName(server, tool) {
  return `mcp__${safe(server)}__${safe(tool)}`.slice(0, 64);
}

function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object' || schema.type !== 'object') return { type: 'object', properties: {} };
  return { ...schema, properties: schema.properties ?? {} };
}

function resultText(res) {
  const parts = (res?.content ?? []).map((c) => {
    if (c.type === 'text') return c.text;
    if (c.type === 'image') return `[image ${c.mimeType ?? ''} omitted]`;
    if (c.type === 'resource') return c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`;
    return `[${c.type} content omitted]`;
  });
  return parts.join('\n').trim() || (res?.structuredContent ? JSON.stringify(res.structuredContent) : '');
}

function makeTool(server, client, def, trust) {
  const name = mcpToolName(server, def.name);
  return {
    name,
    description: `[MCP server "${server}"] ${def.description || def.name}`.slice(0, 900),
    parameters: normalizeSchema(def.inputSchema),
    async execute(args, ctx) {
      if (!trust) {
        const shown = JSON.stringify(args);
        await requireApproval(ctx, 'mcp', `Call MCP tool ${server} / ${def.name}\n    ${shown.length > 300 ? `${shown.slice(0, 300)}…` : shown}`);
      }
      let res;
      try {
        res = await client.callTool(def.name, args);
      } catch (err) {
        throw new ToolError(`MCP "${server}" failed: ${err.message}`);
      }
      const text = redactSecrets(resultText(res));
      if (res?.isError) throw new ToolError(text || `MCP tool ${def.name} reported an error.`);
      return { output: text.slice(0, 20000), truncated: text.length > 20000, summary: `${server}/${def.name} ok` };
    },
  };
}

/**
 * Start every server in settings.mcpServers and register its tools. Never throws: a server that fails
 * to start is reported and skipped. Returns [{ name, ok, tools, error? }].
 */
export async function connectMcpServers(settings, registry, cwd) {
  const servers = settings.mcpServers && typeof settings.mcpServers === 'object' ? settings.mcpServers : {};
  const status = [];
  const clients = [];
  await Promise.all(
    Object.entries(servers).map(async ([name, config]) => {
      if (config?.disabled) return;
      const client = new McpClient(name, config ?? {});
      try {
        await client.connect(cwd);
        const defs = await client.listTools();
        let count = 0;
        for (const def of defs) {
          const tool = makeTool(name, client, def, config.trust === true);
          if (registry.has(tool.name)) continue;
          registry.register(tool);
          count++;
        }
        clients.push(client);
        status.push({ name, ok: true, tools: count });
      } catch (err) {
        client.close();
        status.push({ name, ok: false, tools: 0, error: err.message });
      }
    }),
  );
  if (clients.length) process.on('exit', () => clients.forEach((c) => c.close()));
  registry.mcpStatus = status;
  registry.closeMcp = () => clients.forEach((c) => c.close());
  return status;
}
