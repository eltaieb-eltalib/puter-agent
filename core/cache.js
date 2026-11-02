// Caching layer. Three SEPARATE caches, each a size-bounded LRU with its own hit/miss counters:
//
//   files  - file text keyed by absolute path, validated by (mtime, size) AND a content hash
//   tools  - results of read-only, deterministic tools (list/glob/search/web), keyed by tool+args
//            and invalidated by a "workspace generation" that bumps on every write/command
//   model  - responses of "pure" model calls (e.g. conversation summaries), keyed by a request hash
//
// Important: this cache saves local work and repeated model calls. It does NOT give the model a
// memory: a provider only reuses context through its own prompt-caching feature (see providers/).

import crypto from 'node:crypto';
import fs from 'node:fs/promises';

export const hashText = (text) => crypto.createHash('sha1').update(String(text)).digest('hex');

const sizeOf = (value) => {
  if (value == null) return 16;
  if (typeof value === 'string') return value.length * 2;
  if (Buffer.isBuffer(value)) return value.length;
  try {
    return JSON.stringify(value).length * 2;
  } catch {
    return 1024;
  }
};

/** Least-recently-used map bounded by entry count and by approximate bytes, with optional TTL. */
export class LRUCache {
  #map = new Map();
  #bytes = 0;

  constructor({ maxEntries = 500, maxBytes = 32 * 1024 * 1024, ttlMs = 0, name = 'cache' } = {}) {
    this.name = name;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  get size() {
    return this.#map.size;
  }

  get bytes() {
    return this.#bytes;
  }

  #expired(entry) {
    return entry.ttl > 0 && Date.now() - entry.at > entry.ttl;
  }

  /** Read without counting a hit/miss or touching recency. */
  peek(key) {
    const entry = this.#map.get(key);
    return entry && !this.#expired(entry) ? entry.value : undefined;
  }

  get(key) {
    const entry = this.#map.get(key);
    if (!entry || this.#expired(entry)) {
      if (entry) this.delete(key);
      this.misses++;
      return undefined;
    }
    this.#map.delete(key); // move to the most-recent end
    this.#map.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key, value, { ttlMs } = {}) {
    const bytes = sizeOf(value);
    if (bytes > this.maxBytes) return false; // never let one huge item flush the whole cache
    this.delete(key);
    this.#map.set(key, { value, bytes, at: Date.now(), ttl: ttlMs ?? this.ttlMs });
    this.#bytes += bytes;
    while (this.#map.size > this.maxEntries || this.#bytes > this.maxBytes) {
      const oldest = this.#map.keys().next().value;
      this.delete(oldest);
      this.evictions++;
    }
    return true;
  }

  delete(key) {
    const entry = this.#map.get(key);
    if (!entry) return false;
    this.#bytes -= entry.bytes;
    this.#map.delete(key);
    return true;
  }

  /** Remove every entry whose key matches the predicate. */
  deleteWhere(test) {
    let n = 0;
    for (const key of [...this.#map.keys()]) if (test(key) && this.delete(key)) n++;
    return n;
  }

  clear() {
    this.#map.clear();
    this.#bytes = 0;
  }

  resetStats() {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      name: this.name,
      entries: this.#map.size,
      bytes: this.#bytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: total ? this.hits / total : 0,
    };
  }
}

/**
 * File cache: one entry per absolute path holding { mtimeMs, size, hash, text }.
 * A cached entry is only returned when the file's mtime and size are unchanged; any edit made by
 * the agent also calls invalidate(path). The hash identifies the exact content that was read, so
 * callers can tell "same content as before" without comparing whole strings.
 */
export class FileCache extends LRUCache {
  constructor(opts = {}) {
    super({ name: 'files', maxEntries: 400, maxBytes: 24 * 1024 * 1024, ...opts });
  }

  /** Returns { text, hash, mtimeMs, size, cached } or reads the file. `maxBytes` caps the read. */
  async read(abs, { maxBytes = Infinity, stat: known } = {}) {
    const stat = known ?? (await fs.stat(abs));
    const hit = this.peek(abs);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size && hit.capped === Math.min(stat.size, maxBytes)) {
      this.get(abs); // count the hit and refresh recency
      return { ...hit, cached: true };
    }
    this.misses++;
    const capped = Math.min(stat.size, maxBytes);
    let buf;
    if (capped >= stat.size) buf = await fs.readFile(abs);
    else {
      buf = Buffer.alloc(capped);
      const handle = await fs.open(abs, 'r');
      try {
        await handle.read(buf, 0, capped, 0);
      } finally {
        await handle.close();
      }
    }
    const binary = buf.subarray(0, 8000).includes(0);
    const text = binary ? '' : buf.toString('utf8');
    const entry = { text, binary, hash: hashText(buf), mtimeMs: stat.mtimeMs, size: stat.size, capped };
    this.set(abs, entry);
    return { ...entry, cached: false };
  }

  invalidate(abs) {
    return this.delete(abs);
  }
}

const DEFAULT_LIMITS = {
  files: { maxEntries: 400, maxMB: 24 },
  tools: { maxEntries: 300, maxMB: 8, webTtlMs: 10 * 60 * 1000 },
  model: { maxEntries: 100, maxMB: 4 },
};

/** The three caches plus a "workspace generation" counter used to invalidate tool results. */
export class CacheManager {
  constructor(options = {}) {
    const o = { ...DEFAULT_LIMITS, ...options };
    this.enabled = options.enabled !== false;
    this.files = new FileCache({ maxEntries: o.files.maxEntries, maxBytes: o.files.maxMB * 1024 * 1024 });
    this.tools = new LRUCache({ name: 'tools', maxEntries: o.tools.maxEntries, maxBytes: o.tools.maxMB * 1024 * 1024 });
    this.model = new LRUCache({ name: 'model', maxEntries: o.model.maxEntries, maxBytes: o.model.maxMB * 1024 * 1024 });
    this.webTtlMs = o.tools.webTtlMs ?? DEFAULT_LIMITS.tools.webTtlMs;
    this.generation = 0;
  }

  /** Something in the workspace may have changed (file written, command run, new user turn). */
  bumpGeneration() {
    this.generation++;
  }

  clear(which = 'all') {
    const targets = which === 'all' ? ['files', 'tools', 'model'] : [which];
    for (const t of targets) {
      if (!this[t]?.clear) throw new Error(`Unknown cache "${which}". Use: files | tools | model | all.`);
      this[t].clear();
      this[t].resetStats();
    }
  }

  stats() {
    const parts = [this.files.stats(), this.tools.stats(), this.model.stats()];
    const hits = parts.reduce((n, p) => n + p.hits, 0);
    const misses = parts.reduce((n, p) => n + p.misses, 0);
    return {
      enabled: this.enabled,
      generation: this.generation,
      files: parts[0],
      tools: parts[1],
      model: parts[2],
      total: { entries: parts.reduce((n, p) => n + p.entries, 0), bytes: parts.reduce((n, p) => n + p.bytes, 0), hits, misses, hitRate: hits + misses ? hits / (hits + misses) : 0 },
    };
  }
}

/** Stable JSON (sorted keys) so {a,b} and {b,a} produce the same cache key. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(',')}}`;
}
