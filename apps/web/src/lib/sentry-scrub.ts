import type { Breadcrumb, ErrorEvent, Event } from '@sentry/nextjs';

/**
 * DATA-ERASURE E7: Sentry keeps events for up to 90 days (Owner 2026-10-12: third-party exception),
 * so nothing that identifies a person or carries their content may be sent. Runs in browser, Node
 * and Edge; no Node-only APIs.
 */
const MAX_TEXT = 300;
const MAX_DEPTH = 6;
const REDACTIONS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [token]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt]'],
  [/\b(?:sk|pk|rk|whsec|sb_secret|sb_publishable)[-_][A-Za-z0-9_-]{8,}/g, '[key]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]'],
  [/\+?\d[\d\s-]{9,}\d/g, '[number]'],
];
const SECRET_KEY = /pass|secret|token|auth|cookie|session|key|email|phone|prompt|content|body|message|text|input|query/i;

export function scrubText(value: string): string {
  let text = value;
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/** Keeps scheme, host and path (ids redacted); drops query string and fragment. */
export function scrubUrl(value: string): string {
  const cut = value.search(/[?#]/);
  return scrubText(cut === -1 ? value : value.slice(0, cut));
}

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => scrubValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key) && item !== null && typeof item !== 'boolean' && typeof item !== 'number') {
      out[key] = '[removed]';
    } else if (/url|href|path|uri/i.test(key) && typeof item === 'string') {
      out[key] = scrubUrl(item);
    } else {
      out[key] = scrubValue(item, depth + 1);
    }
  }
  return out;
}

function scrubRecord<T>(value: T): T {
  return scrubValue(value, 0) as T;
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  // Console output may echo user content; request/response bodies are never wanted.
  if (breadcrumb.category === 'console') return null;
  const out: Breadcrumb = { ...breadcrumb };
  if (out.message) out.message = scrubText(out.message);
  if (out.data) out.data = scrubRecord(out.data);
  return out;
}

function scrubCommon<T extends Event>(event: T): T {
  delete event.user;
  delete event.server_name;
  if (event.request) {
    event.request = {
      method: event.request.method,
      url: event.request.url ? scrubUrl(event.request.url) : undefined,
    };
  }
  if (event.transaction) event.transaction = scrubUrl(event.transaction);
  if (event.message) event.message = scrubText(event.message);
  if (event.extra) event.extra = scrubRecord(event.extra);
  if (event.contexts) event.contexts = scrubRecord(event.contexts);
  if (event.tags) event.tags = scrubRecord(event.tags);
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb).filter((item: Breadcrumb | null): item is Breadcrumb => item !== null);
  }
  return event;
}

export function scrubErrorEvent(event: ErrorEvent): ErrorEvent {
  scrubCommon(event);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.vars;
    }
  }
  return event;
}

export function scrubTransactionEvent<T extends Event>(event: T): T {
  scrubCommon(event);
  for (const span of event.spans ?? []) {
    if (span.description) span.description = scrubUrl(span.description);
    if (span.data) span.data = scrubRecord(span.data);
  }
  return event;
}
