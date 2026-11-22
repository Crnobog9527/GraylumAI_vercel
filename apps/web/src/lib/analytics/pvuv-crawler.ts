/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * ANALYTICS-PVUV: AI assistants and search engines fetch the HTML and leave without running scripts, so the browser script
 * never sees them. The proxy reports each such page fetch to pvuv.ai (`POST /v1/sites/<site>/crawler_hits`, ingest-only
 * bearer token), which checks the caller against the operator's published IP ranges. Fire-and-forget: it runs after the
 * response (`waitUntil`), is time-boxed and never fails or delays a page. Off without `PVUV_SITE` and `PVUV_INGEST_TOKEN`.
 * Edge-safe: no Node-only imports (it runs in the proxy).
 */
export const CRAWLER_UA = new RegExp([
  'chatgpt-user', 'oai-searchbot', 'gptbot', 'perplexity-user', 'perplexitybot', 'claude-user', 'claude-searchbot', 'claudebot',
  'bingbot', 'googlebot', 'applebot', 'duckduckbot', 'duckassistbot', 'yandexbot', 'meta-externalagent', 'bytespider',
].join('|'), 'i');
// An extension other than html/htm/txt/xml/md means a static asset.
const ASSET = /\.(?!(?:html?|txt|xml|md)$)[a-z0-9]{1,8}$/i;
const TIMEOUT_MS = 3000;

/** A page fetch by a known crawler: GET or HEAD, a page path (not /api, not /_next, not an asset). */
export function isCrawlerPageHit(method: string, pathname: string, userAgent: string | null | undefined): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (!userAgent || !CRAWLER_UA.test(userAgent)) return false;
  if (pathname.startsWith('/api/') || pathname === '/api' || pathname.startsWith('/_') || ASSET.test(pathname)) return false;
  return true;
}

type HitInput = { method: string; pathname: string; userAgent: string | null; ip: string | null };
type Env = Record<string, string | undefined>;

/** The request to send for a crawler hit, or null when it is not one (or reporting is not configured). */
export function crawlerHitRequest(input: HitInput, env: Env = process.env, now = Date.now()): { url: string; init: RequestInit } | null {
  const site = env.PVUV_SITE?.trim();
  const token = env.PVUV_INGEST_TOKEN?.trim();
  if (!site || !token || !/^[A-Za-z0-9_-]{4,64}$/.test(site)) return null;
  if (!isCrawlerPageHit(input.method, input.pathname, input.userAgent)) return null;
  return {
    url: `https://api.pvuv.ai/v1/sites/${encodeURIComponent(site)}/crawler_hits`,
    init: {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ hits: [{ ua: input.userAgent, path: input.pathname, ...(input.ip ? { ip: input.ip } : {}), ts: now }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  };
}

type Waiter = { waitUntil: (promise: Promise<unknown>) => void };

/** Reports the hit after the response; nothing is awaited by the caller and errors are swallowed. */
export function reportCrawlerHit(
  request: { method: string; nextUrl: { pathname: string }; headers: Headers },
  event: Waiter | undefined,
  deps: { env?: Env; fetch?: typeof fetch } = {},
): boolean {
  const ip = request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const prepared = crawlerHitRequest({ method: request.method, pathname: request.nextUrl.pathname,
    userAgent: request.headers.get('user-agent'), ip }, deps.env);
  if (!prepared || !event) return false;
  try {
    event.waitUntil((deps.fetch ?? fetch)(prepared.url, prepared.init).catch(() => undefined));
    return true;
  } catch {
    return false;
  }
}
