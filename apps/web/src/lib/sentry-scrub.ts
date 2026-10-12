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
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]'],
  [/\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/gi, '[ip]'],
  [/\+?\d[\d\s-]{9,}\d/g, '[number]'],
];
// Client addresses (http.client_ip, ip_address, x-forwarded-for, ...) are personal data.
const IP_KEY = /(^|[._-])ip($|[._-])|client_ip|ip_address|forwarded|remote_addr/i;
// Provider/record identifiers (gen_ai.response.id, conversation ids, customer_id, ...) can locate a person's records.
const ID_KEY = /(^|[._-])ids?$|_id$|[a-z]Id$/;
// From AI spans keep only model names, operation and token counts; never messages, ids or tool data.
const GEN_AI_KEEP = /^gen_ai\.(system|operation\.name|request\.model|response\.model|usage\.[a-z_]+)$/;
const SECRET_KEY = /pass|secret|token|auth|cookie|session|key|email|phone|prompt|content|body|message|text|input|query/i;

/** For SDK-generated metadata (urls, tags, contexts): known identifier formats are masked. */
export function redactText(value: string): string {
  let text = value;
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/** Domains whose stable error codes the application emits (e.g. `ACCOUNT_ERASURE_FAILED`). */
const CODE_PREFIXES = ['ACCOUNT', 'AGENT', 'ARTIFACT', 'AUTH', 'BILL2', 'BILLING', 'CAPTURE', 'CONTENT', 'CREDIT',
  'DATA_USE', 'ERASURE', 'LIBRARY', 'MODEL', 'OPC', 'OPENING_GRANT', 'PAY', 'PAYG', 'RATE_LIMIT', 'REPORT', 'RESEARCH',
  'RUNTIME', 'SKILL', 'STRIPE', 'WAFFO'];
const ERROR_CODE = new RegExp(`^(?:${CODE_PREFIXES.join('|')})_[A-Z0-9_]{2,60}(?=$|[:\\s])`);
/**
 * For free text (messages, exception values, breadcrumbs, extra): pattern masking cannot catch a
 * name or a sentence, so only a leading error code from a known application domain is kept.
 */
export function scrubText(value: string): string {
  return value.match(ERROR_CODE)?.[0] ?? '[text]';
}

// Opaque identifiers in paths: provider ids (sub_..., cus_..., pi_..., cs_...), draft ids, tokens.
// Any segment of 8+ characters that contains a digit is treated as an identifier.
const PATH_ID = /(?<=\/)(?=[A-Za-z0-9_-]{8,}(?=[/\s]|$))[A-Za-z_-]*\d[A-Za-z0-9_-]*/g;

/** Keeps scheme, host and path (identifier segments redacted); drops query string and fragment. */
export function scrubUrl(value: string): string {
  const cut = value.search(/[?#]/);
  return redactText((cut === -1 ? value : value.slice(0, cut)).replace(PATH_ID, '[id]'));
}

function scrubValue(value: unknown, depth: number, text: (value: string) => string): unknown {
  if (typeof value === 'string') return text(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => scrubValue(item, depth + 1, text));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith('gen_ai.')) {
      out[key] = GEN_AI_KEEP.test(key) && (typeof item === 'number' || typeof item === 'string') ? item : '[removed]';
    } else if (IP_KEY.test(key) || ID_KEY.test(key) || (SECRET_KEY.test(key) && item !== null && typeof item !== 'boolean')) {
      // Sensitive keys lose numbers too (a phone number stored as a number is still a phone number).
      out[key] = '[removed]';
    } else if (/url|href|path|uri|target/i.test(key) && typeof item === 'string') {
      out[key] = scrubUrl(item);
    } else {
      out[key] = scrubValue(item, depth + 1, text);
    }
  }
  return out;
}

/** Free text: extra and breadcrumb data. */
function scrubRecord<T>(value: T): T {
  return scrubValue(value, 0, scrubText) as T;
}

/** SDK metadata: contexts, tags and span data. */
function redactRecord<T>(value: T): T {
  return scrubValue(value, 0, redactText) as T;
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
  // Sentry.parameterize stores the template and the interpolated values here instead of `message`.
  if (event.logentry) {
    event.logentry = { message: event.logentry.message ? scrubText(event.logentry.message) : undefined };
  }
  if (event.extra) event.extra = scrubRecord(event.extra);
  if (event.contexts) event.contexts = redactRecord(event.contexts);
  if (event.tags) event.tags = redactRecord(event.tags);
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
    if (span.data) span.data = redactRecord(span.data);
  }
  return event;
}
