import dns from 'node:dns/promises';
import net from 'node:net';
import { ToolError } from '../utils/errors.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_BODY_BYTES = 3_000_000;

// ---------------------------------------------------------------- helpers

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...' };

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Very small HTML -> readable text converter (no dependencies). Exported for tests. */
export function htmlToText(html) {
  let h = String(html);
  const title = decodeEntities((h.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim());
  h = h
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|head|template|iframe)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(nav|footer|aside)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|h[1-6]|tr|table|ul|ol|blockquote|pre)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<[^>]+>/g, '');
  const text = decodeEntities(h)
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}


// ---------------------------------------------------------------- SSRF guard
// web_fetch is driven by the model (and by whatever a web page tells it), so it must not be able to
// reach this machine or the local network: localhost services, router pages, cloud metadata (169.254.169.254).

function ipv4Private(a, b) {
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** True for loopback, private, link-local, reserved and multicast addresses (IPv4 and IPv6). Exported for tests. */
export function isPrivateAddress(ip) {
  const version = net.isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    return ipv4Private(a, b);
  }
  if (version === 6) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v); // IPv4-mapped, dotted form
    if (dotted) return isPrivateAddress(dotted[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v); // IPv4-mapped, hex form
    if (hex) {
      const hi = parseInt(hex[1], 16);
      return ipv4Private(hi >> 8, hi & 255);
    }
    const first = parseInt(v.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
  }
  return false;
}

/** Throws a ToolError unless the URL points at a public host. Checks every address the name resolves to. */
export async function assertPublicUrl(url) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const blocked = (why) =>
    new ToolError(`Blocked: ${host} ${why}. web_fetch only reads public internet pages.`);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw blocked('is a local name');
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw blocked('is a private/internal address');
    return;
  }
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch (err) {
    throw new ToolError(`Could not resolve ${host}: ${err.code ?? err.message}`);
  }
  if (addresses.some((a) => isPrivateAddress(a.address))) throw blocked('resolves to a private/internal address');
}

const hasArabic = (s) => /[\u0600-\u06FF]/.test(s);

function withTimeout(ctx, ms) {
  const timeout = AbortSignal.timeout(ms);
  return ctx?.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
}

function pickCharset(contentType, head) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  if (fromHeader) return fromHeader;
  const sniff = Buffer.from(head).toString('latin1');
  return /<meta[^>]+charset=["']?([\w-]+)/i.exec(sniff)?.[1] ?? 'utf-8';
}

function decodeBody(buffer, contentType) {
  const charset = pickCharset(contentType, buffer.subarray(0, 2000));
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

/**
 * GET a URL and return { status, url, contentType, text, truncated }. Throws on network errors.
 * With publicOnly, every hop (including redirects, followed manually) must point at a public host.
 */
async function httpGet(url, { ctx, timeoutMs = 15000, headers = {}, maxBytes = MAX_BODY_BYTES, publicOnly = false } = {}) {
  let current = url;
  let res;
  for (let hop = 0; ; hop++) {
    if (publicOnly) await assertPublicUrl(current);
    res = await fetch(current, {
      redirect: publicOnly ? 'manual' : 'follow',
      signal: withTimeout(ctx, timeoutMs),
      headers: { 'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.8', ...headers },
    });
    const location = res.headers.get('location');
    if (!publicOnly || res.status < 300 || res.status >= 400 || !location) break;
    if (hop >= 5) throw new ToolError('Too many redirects.');
    current = new URL(location, current).toString();
    await res.body?.cancel();
  }
  const chunks = [];
  let size = 0;
  let truncated = false;
  if (res.body) {
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > maxBytes) {
        chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
        truncated = true;
        break;
      }
      chunks.push(chunk);
    }
  }
  const contentType = res.headers.get('content-type') ?? '';
  return {
    status: res.status,
    url: publicOnly ? current : res.url || url,
    contentType,
    text: decodeBody(Buffer.concat(chunks), contentType),
    truncated,
  };
}

// ---------------------------------------------------------------- search backends

async function searchSearxng(base, query, { language, max, ctx, timeoutMs, engines }) {
  const u = new URL(`${base.replace(/\/+$/, '')}/search`);
  u.searchParams.set('q', query);
  u.searchParams.set('format', 'json');
  u.searchParams.set('language', language);
  u.searchParams.set('safesearch', '0');
  if (engines) u.searchParams.set('engines', engines);
  const res = await httpGet(u.toString(), { ctx, timeoutMs, headers: { Accept: 'application/json' } });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} (this instance may have JSON output disabled)`);
  let data;
  try {
    data = JSON.parse(res.text);
  } catch {
    throw new Error('response was not JSON (instance has JSON output disabled)');
  }
  return (data.results ?? [])
    .filter((r) => r.url)
    .slice(0, max)
    .map((r) => ({ title: r.title ?? r.url, url: r.url, snippet: (r.content ?? '').trim() }));
}

function decodeDdgUrl(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const real = u.searchParams.get('uddg');
    if (real) return real;
    if (u.hostname.endsWith('duckduckgo.com')) return null; // ads / internal links
    return u.toString();
  } catch {
    return null;
  }
}

/** Parse the HTML endpoint of DuckDuckGo. Exported for tests. */
export function parseDuckDuckGo(html, max = 8) {
  const re = /<a\b([^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi;
  const found = [...html.matchAll(re)];
  const results = [];
  for (let i = 0; i < found.length && results.length < max; i++) {
    const m = found[i];
    const href = /href="([^"]*)"/i.exec(m[1])?.[1];
    const url = href ? decodeDdgUrl(decodeEntities(href)) : null;
    if (!url) continue;
    const end = found[i + 1]?.index ?? html.length;
    const region = html.slice(m.index + m[0].length, end);
    const snip = /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div|span)>/i.exec(region)?.[1] ?? '';
    results.push({ title: htmlToText(m[2]).text, url, snippet: htmlToText(snip).text });
  }
  return results;
}

async function searchDuckDuckGo(query, { max, ctx, timeoutMs }) {
  const u = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await httpGet(u, { ctx, timeoutMs });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const results = parseDuckDuckGo(res.text, max);
  if (!results.length) throw new Error('no results parsed (DuckDuckGo may be showing a captcha)');
  return results;
}

async function searchWikipedia(query, { max, ctx, timeoutMs, endpoint }) {
  const lang = hasArabic(query) ? 'ar' : 'en';
  const host = endpoint ?? `https://${lang}.wikipedia.org`;
  const u = `${host}/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=${max}&srsearch=${encodeURIComponent(query)}`;
  const res = await httpGet(u, { ctx, timeoutMs, headers: { Accept: 'application/json' } });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const data = JSON.parse(res.text);
  return (data.query?.search ?? []).map((r) => ({
    title: r.title,
    url: `${host}/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
    snippet: htmlToText(r.snippet ?? '').text,
  }));
}

const DEFAULT_SEARCH = {
  providers: ['searxng', 'duckduckgo', 'wikipedia'],
  searxngUrls: ['https://searx.be', 'https://search.inetol.net', 'https://priv.au', 'https://searx.tiekoetter.com'],
  searxngEngines: '',
  maxResults: 8,
  timeoutMs: 10000,
};

/**
 * Run the configured providers in order until one returns results.
 * Public SearXNG instances are tried in parallel (first answer wins) because many of them
 * disable JSON output or are down. Exported so the terminal UI can reuse it for /search.
 */
export async function runSearch(query, ctx, { max } = {}) {
  const cfg = { ...DEFAULT_SEARCH, ...(ctx.settings?.search ?? {}) };
  const limit = Math.min(Math.max(1, max ?? cfg.maxResults), 15);
  const language = hasArabic(query) ? 'ar' : 'auto';
  const errors = [];

  for (const provider of cfg.providers) {
    try {
      let results;
      if (provider === 'searxng') {
        const urls = cfg.searxngUrls.slice(0, 4);
        if (!urls.length) throw new Error('no searxngUrls configured');
        const attempts = urls.map((base) =>
          searchSearxng(base, query, { language, max: limit, ctx, timeoutMs: cfg.timeoutMs, engines: cfg.searxngEngines })
            .then((r) => {
              if (!r.length) throw new Error('0 results');
              return r;
            })
            .catch((err) => {
              errors.push(`searxng ${base}: ${err.message}`);
              throw err;
            }),
        );
        results = await Promise.any(attempts);
      } else if (provider === 'duckduckgo') {
        results = await searchDuckDuckGo(query, { max: limit, ctx, timeoutMs: cfg.timeoutMs });
      } else if (provider === 'wikipedia') {
        results = await searchWikipedia(query, {
          max: limit,
          ctx,
          timeoutMs: cfg.timeoutMs,
          endpoint: cfg.wikipediaEndpoint,
        });
      } else {
        continue;
      }
      if (results?.length) return { provider, results };
      errors.push(`${provider}: 0 results`);
    } catch (err) {
      if (ctx.signal?.aborted) throw new ToolError('Cancelled by the user.');
      if (provider !== 'searxng') errors.push(`${provider}: ${err.message}`);
    }
  }
  throw new ToolError(
    `All search providers failed. ${errors.slice(-6).join(' | ')}. ` +
      'Try a different/shorter query, or fetch a known URL with web_fetch, or use run_python with urllib. ' +
      'The user can run their own SearXNG and set SEARXNG_URL in .env.',
  );
}

// ---------------------------------------------------------------- tools

const webSearchTool = {
  name: 'web_search',
  readOnly: true,
  description:
    'Search the internet and return a list of results (title, url, snippet). Use it for anything current, factual, or unknown to you: lyrics, news, documentation, library versions, people, places, prices. Snippets are short: follow up with web_fetch on the best 1-3 URLs to read the real content. Keep queries short and specific; try an Arabic and an English phrasing when the first one finds nothing.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (1-8 words works best).' },
      max_results: { type: 'integer', description: 'How many results to return (default 8, max 15).' },
    },
    required: ['query'],
  },
  async execute({ query, max_results }, ctx) {
    if (!query.trim()) throw new ToolError('query must not be empty.');
    const { provider, results } = await runSearch(query.trim(), ctx, { max: max_results });
    return {
      query,
      provider,
      results,
      hint: 'Snippets are partial. Use web_fetch on the most relevant url to read the full page, then answer and cite the urls.',
      summary: `${results.length} result(s) via ${provider}`,
    };
  },
};

const webFetchTool = {
  name: 'web_fetch',
  readOnly: true,
  description:
    'Download a web page (http/https) and return its readable text (HTML is converted to plain text; JSON and text are returned as is). Use it after web_search to read a result in full. For long pages use start to continue from next_start.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full http(s) URL.' },
      max_chars: { type: 'integer', description: 'Max characters to return (default 12000, max 40000).' },
      start: { type: 'integer', description: 'Character offset to start from (for pagination). Default 0.' },
    },
    required: ['url'],
  },
  async execute({ url, max_chars = 12000, start = 0 }, ctx) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new ToolError(`Invalid URL: ${url}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new ToolError('Only http and https URLs are allowed.');

    const timeoutMs = ctx.settings?.search?.fetchTimeoutMs ?? 20000;
    let res;
    try {
      res = await httpGet(parsed.toString(), {
        ctx,
        timeoutMs,
        publicOnly: !ctx.settings?.search?.allowPrivateFetch,
      });
    } catch (err) {
      if (ctx.signal?.aborted) throw new ToolError('Cancelled by the user.');
      if (err instanceof ToolError) throw err;
      throw new ToolError(`Could not fetch ${url}: ${err.cause?.code ?? err.message}`);
    }
    if (res.status >= 400) throw new ToolError(`HTTP ${res.status} when fetching ${url}`);

    let title = '';
    let text = res.text;
    if (/html|xml/i.test(res.contentType) || /^\s*<(!doctype|html)/i.test(text)) {
      ({ title, text } = htmlToText(text));
    } else if (!/text|json|javascript|csv/i.test(res.contentType)) {
      throw new ToolError(`Unsupported content type "${res.contentType}" (only text-like pages can be read).`);
    }

    const limit = Math.min(Math.max(500, max_chars), 40000);
    const from = Math.max(0, start);
    const slice = text.slice(from, from + limit);
    const end = from + slice.length;
    return {
      url: res.url,
      status: res.status,
      title,
      content: slice,
      start: from,
      end,
      total_chars: text.length,
      has_more: end < text.length,
      ...(end < text.length && { next_start: end }),
      summary: `${slice.length} chars from ${parsed.hostname}${end < text.length ? ' (more available)' : ''}`,
    };
  },
};

export const webTools = [webSearchTool, webFetchTool];
