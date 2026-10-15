import type { Breadcrumb, ErrorEvent, Event } from '@sentry/nextjs';

/**
 * DATA-ERASURE E7 / L9: Sentry keeps events up to 90 days (Owner 2026-10-12: third-party exception), so
 * an event is rebuilt from an allowlist instead of patching known leaks: only the fields listed here
 * leave the process (error codes, templated routes, code locations, model names and counts,
 * environment and versions). Everything else, including all free text and unknown keys, is dropped.
 * Runs in browser, Node and Edge; no Node-only APIs.
 */
type AnyRecord = Record<string, unknown>;

/** Domains whose stable error codes the application emits (e.g. `ACCOUNT_ERASURE_FAILED`). */
const CODE_PREFIXES = ['ACCOUNT', 'AGENT', 'ARTIFACT', 'AUTH', 'BILL2', 'BILLING', 'CAPTURE', 'CONTENT', 'CREDIT',
  'DATA_USE', 'ERASURE', 'LIBRARY', 'MODEL', 'OPC', 'OPENING_GRANT', 'PAY', 'PAYG', 'RATE_LIMIT', 'REPORT', 'RESEARCH',
  'RUNTIME', 'SKILL', 'STRIPE', 'WAFFO'];
const ERROR_CODE = new RegExp(`^(?:${CODE_PREFIXES.join('|')})_[A-Z0-9_]{2,60}(?=$|[:\\s])`);

/** Free text keeps only a leading error code from a known application domain. */
export function scrubText(value: string): string {
  return value.match(ERROR_CODE)?.[0] ?? '[text]';
}

/**
 * Static segments of our own routes (apps/web/src/app) plus Next.js bundle folders. A test keeps the
 * route list complete; any other segment of one of our URLs is a dynamic value and becomes `:param`.
 */
export const APP_SEGMENTS = new Set(['about', 'acceptable-use', 'access-denied', 'account-erasure', 'admin',
  'agent-first-preview', 'ai', 'announcements', 'api', 'auth', 'auto-close', 'billing-reconcile', 'callback', 'chat',
  'advance', 'fusion', 'connect', 'contact', 'costs', 'cron', 'diagnostics', 'f', 'faq', 'finance', 'forgot-password', 'ig-jingying', 'invitations', 'landing',
  'library', 'library-cleanup', 'login', 'maintenance', 'marketplace', 'models', 'orders', 'packages', 'performance',
  'plan', 'positioning', 'postforme', 'preview', 'publish-monitor', 'pricing', 'privacy', 'profile', 'prompts', 'refunds',
  'register', 'release-subscription-credits',
  'requests', 'reset-password', 'runtime', 'runtime-recovery', 'search', 'settings', 'shequn-jingying', 'shequn-xingxiao',
  'skills', 'social-monitor', 'start', 'stream', 'stripe', 'terms', 'tickets', 'topics', 'transactions', 'trpc', 'tutorials', 'upload', 'users',
  'verify-email', 'waffo', 'webhook', 'workbench', 'zh-tw', 'zimeiti-jingying', 'zimeiti-kecheng',
  // Style samples D, E, G, H and I (PUBLIC-SITE, /landing/preview/d, /e, /g, /h and /i), removed with the samples.
  'd', 'e', 'g', 'h', 'i',
  // FUSION-REVIEW animation prototype (/landing/preview/jury), removed with the prototype.
  'jury',
  '_next', 'static', 'chunks', 'app', 'pages', 'css', 'media']);
const OWN_HOST = /(^|\.)graylum\.com$|\.vercel\.app$|^localhost$|^127\.0\.0\.1$/;

/** Only listed static segments survive. tRPC procedure names and bundle file names come from the
 * request, so they are templated like any other value (`:param`). */
function templatePath(path: string): string {
  return path.split('/').map((segment) => (segment === '' || APP_SEGMENTS.has(segment) ? segment : ':param')).join('/');
}

/**
 * `[METHOD ]url-or-path` → method plus a route template. Our own URLs keep their templated path;
 * third-party URLs keep scheme and host only. Query strings and fragments never pass.
 */
export function scrubUrl(value: string): string {
  const match = value.match(/^([A-Z]{3,7} )?([\s\S]*)$/);
  const method = match?.[1] ?? '';
  const target = (match?.[2] ?? '').replace(/[?#][\s\S]*$/, '');
  const absolute = target.match(/^([a-z][a-z0-9+.-]*:\/\/)([^/\s:]+)(:\d+)?(\/.*)?$/i);
  if (absolute) {
    const [, scheme, host = '', , path = ''] = absolute;
    if (!OWN_HOST.test(host.toLowerCase())) return `${method}${scheme}${host}`;
    return `${method}${scheme}${host}${templatePath(path)}`;
  }
  if (target.startsWith('/')) return `${method}${templatePath(target)}`;
  return method ? method.trim() : '[text]';
}

/** Code locations (stack frames, debug images) come from the build, not the request; they only lose queries. */
function scrubFrameFile(value: string): string {
  return value.replace(/[?#][\s\S]*$/, '');
}

function pick(source: unknown, keys: readonly string[]): AnyRecord | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const out: AnyRecord = {};
  for (const key of keys) {
    const value = (source as AnyRecord)[key];
    if (value !== undefined && (value === null || ['string', 'number', 'boolean'].includes(typeof value))) out[key] = value;
  }
  return out;
}

const CONTEXT_FIELDS: Record<string, readonly string[]> = {
  trace: ['trace_id', 'span_id', 'parent_span_id', 'op', 'status', 'origin'],
  runtime: ['name', 'version'],
  os: ['name', 'version'],
  browser: ['name', 'version'],
  device: ['family', 'model', 'arch'],
};
const TAG_FIELDS = ['runtime', 'handled', 'mechanism', 'level', 'environment', 'release'] as const;
const GEN_AI_FIELD = /^gen_ai\.(system|operation\.name|request\.model|response\.model|usage\.[a-z_]+)$/;
const SPAN_FIELDS = new Set(['http.method', 'http.request.method', 'http.status_code', 'http.response.status_code',
  'db.system', 'sentry.op', 'sentry.origin', 'sentry.source', 'sentry.sample_rate']);

function scrubContexts(contexts: unknown): AnyRecord | undefined {
  if (!contexts || typeof contexts !== 'object') return undefined;
  const out: AnyRecord = {};
  for (const [name, fields] of Object.entries(CONTEXT_FIELDS)) {
    const picked = pick((contexts as AnyRecord)[name], fields);
    if (picked && Object.keys(picked).length) out[name] = picked;
  }
  return out;
}

function scrubSpanData(data: unknown): AnyRecord {
  const out: AnyRecord = {};
  if (!data || typeof data !== 'object') return out;
  for (const [key, value] of Object.entries(data as AnyRecord)) {
    if (!['string', 'number', 'boolean'].includes(typeof value)) continue;
    if (SPAN_FIELDS.has(key) || GEN_AI_FIELD.test(key)) out[key] = value;
  }
  return out;
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  // Console output may echo user content; request/response bodies are never wanted.
  if (breadcrumb.category === 'console') return null;
  const data = breadcrumb.data as AnyRecord | undefined;
  const out: Breadcrumb = { ...pick(breadcrumb, ['type', 'category', 'level', 'timestamp']) };
  if (breadcrumb.message) out.message = scrubText(breadcrumb.message);
  if (data) {
    const kept: AnyRecord = { ...pick(data, ['method', 'status_code']) };
    for (const key of ['url', 'from', 'to'] as const) {
      const value = data[key];
      if (typeof value === 'string') kept[key] = scrubUrl(value);
    }
    out.data = kept;
  }
  return out;
}

function scrubCommon(event: Event): Event {
  const out = {
    ...pick(event, ['event_id', 'timestamp', 'start_timestamp', 'platform', 'level', 'environment', 'release', 'dist', 'type']),
  } as Event;
  if (event.sdk) out.sdk = { name: event.sdk.name, version: event.sdk.version };
  if (event.transaction) out.transaction = scrubUrl(event.transaction);
  if (event.message) out.message = scrubText(event.message);
  if (event.logentry?.message) out.logentry = { message: scrubText(event.logentry.message) };
  if (event.request) out.request = { method: event.request.method, url: event.request.url ? scrubUrl(event.request.url) : undefined };
  const contexts = scrubContexts(event.contexts);
  if (contexts) out.contexts = contexts as Event['contexts'];
  const tags = pick(event.tags, TAG_FIELDS);
  if (tags) out.tags = tags as Event['tags'];
  if (event.breadcrumbs) {
    out.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb).filter((item: Breadcrumb | null): item is Breadcrumb => item !== null);
  }
  return out;
}

export function scrubErrorEvent(event: ErrorEvent): ErrorEvent {
  const out = scrubCommon(event) as ErrorEvent;
  // Debug ids let uploaded source maps match minified frames; they identify build files, not people.
  const images = event.debug_meta?.images;
  if (Array.isArray(images)) {
    out.debug_meta = { images: images.map((image) => {
      const kept = pick(image, ['type', 'debug_id']) ?? {};
      const file = (image as unknown as AnyRecord).code_file;
      if (typeof file === 'string') kept.code_file = scrubFrameFile(file);
      return kept;
    }) as unknown as NonNullable<ErrorEvent['debug_meta']>['images'] };
  }
  if (event.exception?.values) {
    out.exception = { values: event.exception.values.map((exception) => ({
      type: exception.type,
      value: exception.value ? scrubText(exception.value) : undefined,
      mechanism: exception.mechanism ? { type: exception.mechanism.type, handled: exception.mechanism.handled } : undefined,
      stacktrace: exception.stacktrace?.frames ? { frames: exception.stacktrace.frames.map((frame) => ({
        ...pick(frame, ['function', 'module', 'lineno', 'colno', 'in_app']),
        filename: frame.filename ? scrubFrameFile(frame.filename) : undefined,
        abs_path: frame.abs_path ? scrubFrameFile(frame.abs_path) : undefined,
      })) } : undefined,
    })) };
  }
  return out;
}

export function scrubTransactionEvent<T extends Event>(event: T): T {
  const out = scrubCommon(event) as T;
  if (event.measurements) out.measurements = event.measurements;
  if (event.spans) {
    out.spans = event.spans.map((span) => ({
      ...pick(span, ['span_id', 'trace_id', 'parent_span_id', 'op', 'status', 'origin', 'start_timestamp', 'timestamp']),
      description: span.op?.startsWith('http') && span.description ? scrubUrl(span.description) : span.op,
      data: scrubSpanData(span.data),
    })) as Event['spans'];
  }
  return out;
}
