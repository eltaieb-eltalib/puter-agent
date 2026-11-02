import { ToolError } from '../utils/errors.js';
import { stableStringify } from '../core/cache.js';
import { isSensitivePath } from '../utils/redact.js';

// Arguments that name a path. Used to keep caching from bypassing outside-workspace / secret prompts,
// and to invalidate cached file content after a tool changes those paths.
const PATH_ARGS = ['path', 'cwd', 'from', 'to', 'file'];

function typeOk(value, type) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    default:
      return true;
  }
}

/** Minimal JSON-Schema check (required, type, enum). Returns an error string or null. */
export function validateArgs(schema, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return 'Arguments must be a JSON object.';
  }
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null) return `Missing required argument "${key}".`;
  }
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    if (spec.type && !typeOk(value, spec.type)) return `Argument "${key}" must be of type ${spec.type}.`;
    if (spec.enum && !spec.enum.includes(value)) {
      return `Argument "${key}" must be one of: ${spec.enum.join(', ')}.`;
    }
  }
  return null;
}

/** Serialise a tool result for the model, truncating very large output. */
export function formatResult(result, maxChars = 20000) {
  const { cached, ...rest } = result ?? {}; // "cached" is for the UI only
  const text = JSON.stringify(rest);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} characters]`;
}

/**
 * A tool is: { name, description, parameters (JSON Schema), execute(args, ctx) } plus optional:
 *   readOnly  - never changes anything (allowed in plan mode, may run in parallel)
 *   cache     - 'workspace' (result depends only on workspace files) | 'web' (time-limited) | undefined
 *   parallel  - false to force sequential execution even when readOnly
 * Adding a tool = one object with these fields; the registry handles validation, caching,
 * invalidation, audit logging and error conversion.
 * execute() returns a plain object (may include a `summary` string for the UI) or
 * throws. The registry converts every outcome into { ok, result | error } so a
 * failing tool never crashes the agent loop - the model just sees the error.
 */
export class ToolRegistry {
  #tools = new Map();

  register(tool) {
    const { name, description, execute } = tool;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name ?? '')) throw new Error(`Invalid tool name: ${name}`);
    if (typeof description !== 'string' || !description) throw new Error(`Tool ${name}: missing description`);
    if (typeof execute !== 'function') throw new Error(`Tool ${name}: missing execute()`);
    if (this.#tools.has(name)) throw new Error(`Duplicate tool: ${name}`);
    this.#tools.set(name, {
      ...tool,
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    });
    return this;
  }

  registerAll(tools) {
    for (const tool of tools) this.register(tool);
    return this;
  }

  has(name) {
    return this.#tools.has(name);
  }

  get(name) {
    return this.#tools.get(name);
  }

  /** Read-only tools may run concurrently (approval prompts are still asked one at a time). */
  isParallelSafe(name) {
    const tool = this.#tools.get(name);
    return Boolean(tool?.readOnly && tool.parallel !== false);
  }

  /**
   * Cache key for this call, or null when it must not be cached. A call that touches a path outside
   * the workspace or a secret file is never cached: it must go through its approval prompt every time.
   */
  cacheKey(tool, args, ctx) {
    const cache = ctx?.cache;
    if (!tool.cache || !cache?.enabled) return null;
    if (tool.cache === 'workspace') {
      for (const k of PATH_ARGS) {
        if (typeof args[k] !== 'string' || !ctx.guard) continue;
        try {
          const r = ctx.guard.resolve(args[k]);
          if (!r.inside || isSensitivePath(r.abs)) return null;
        } catch {
          return null;
        }
      }
      return `${tool.name}@${cache.generation}:${ctx.guard?.root ?? ''}:${ctx.mode ?? ''}:${stableStringify(args)}`;
    }
    return `${tool.name}:${stableStringify(args)}`;
  }

  /** After a tool that may change files: tool results computed before are stale. */
  #invalidate(args, ctx) {
    const cache = ctx?.cache;
    if (!cache) return;
    cache.bumpGeneration();
    for (const k of PATH_ARGS) {
      if (typeof args?.[k] !== 'string' || !ctx.guard) continue;
      try {
        const { abs, real } = ctx.guard.resolve(args[k]);
        cache.files.invalidate(abs);
        if (real !== abs) cache.files.invalidate(real);
      } catch {
        /* invalid path: nothing cached for it */
      }
    }
  }

  list() {
    return [...this.#tools.values()];
  }

  /** Tool definitions in the OpenAI / Puter `tools` format. */
  definitions({ readOnly = false, include = null } = {}) {
    const allowed = include ? new Set(include) : null;
    return this.list()
      .filter((t) => !readOnly || t.readOnly)
      .filter((t) => !allowed || allowed.has(t.name))
      .map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  async execute(name, args, ctx) {
    const tool = this.#tools.get(name);
    if (!tool) {
      return {
        ok: false,
        error: `Unknown tool "${name}". Available tools: ${[...this.#tools.keys()].join(', ')}.`,
      };
    }
    if (ctx?.mode === 'plan' && !tool.readOnly) {
      return {
        ok: false,
        error: `"${name}" is not available in PLAN mode (read-only). Finish the plan and tell the user to switch with /build.`,
      };
    }
    const invalid = validateArgs(tool.parameters, args);
    if (invalid) return { ok: false, error: invalid };

    const key = this.cacheKey(tool, args, ctx);
    if (key) {
      const hit = ctx.cache.tools.get(key);
      if (hit) return { ...hit, cached: true };
    }

    const started = Date.now();
    let outcome;
    try {
      const result = await tool.execute(args, ctx);
      outcome = { ok: true, result: result ?? {} };
    } catch (err) {
      if (err instanceof ToolError) outcome = { ok: false, error: err.message };
      // Unexpected failures (usually filesystem errors): keep Node's message, which names the path.
      else outcome = { ok: false, error: err?.code ? `${err.code}: ${err.message}` : String(err?.message ?? err) };
    }
    const ms = Date.now() - started;

    if (!tool.readOnly) {
      this.#invalidate(args, ctx);
      ctx?.audit?.record({ tool: name, args, ok: outcome.ok, ...(outcome.ok ? { exit: outcome.result?.exit_code } : { error: String(outcome.error).slice(0, 300) }), ms, depth: ctx?.depth ?? 0 });
    } else if (key && outcome.ok) {
      ctx.cache.tools.set(key, outcome, tool.cache === 'web' ? { ttlMs: ctx.cache.webTtlMs } : undefined);
    }
    return outcome;
  }
}
