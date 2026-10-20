/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

const DEFAULT_SITE_NAME = 'GraylumAI';
const DEFAULT_SUPPORT_EMAIL = 'support@example.com';
const DEFAULT_APP_URL = 'http://localhost:3000';
const DEFAULT_AUTH_APP_URL = 'https://www.graylum.com';
// The parent domain the production hosts used to share the session cookie on, before the single host.
const SHARED_COOKIE_DOMAIN = '.graylum.com';

// The single production host (E1, SEO_GEO_SPEC section 2). The bare domain and the old app host only
// redirect to it, so a configured URL naming either of them is read as this host.
const PRODUCTION_HOST = 'www.graylum.com';
const LEGACY_PRODUCTION_HOSTS = new Set(['graylum.com', 'app.graylum.com']);
// Hosts whose own origin serves login, the auth callback and the verify page. Matched exactly so a
// request's Host header alone never chooses where auth redirects go.
const APP_HOSTS = new Set([PRODUCTION_HOST, 'auth-staging.graylum.com']);

function resolveTrimmedValue(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeAppOrigin(value: string | null, fallback: string) {
  if (!value) {
    return fallback;
  }

  try {
    const url = new URL(value);
    const normalizedHost = url.hostname.toLowerCase();

    if (LEGACY_PRODUCTION_HOSTS.has(normalizedHost)) {
      return DEFAULT_AUTH_APP_URL;
    }

    return url.origin;
  } catch {
    return value;
  }
}

function resolveHostname(hostname?: string | null) {
  if (hostname) {
    return hostname.toLowerCase();
  }

  if (typeof window !== 'undefined') {
    return window.location.hostname.toLowerCase();
  }

  return '';
}

function isRuntimeAuthHost(hostname: string) {
  return (
    APP_HOSTS.has(hostname) ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.vercel.app')
  );
}

function resolveRuntimeAuthOrigin(value?: string | URL | null) {
  const candidate = value ?? (typeof window !== 'undefined' ? window.location.origin : null);
  if (!candidate) {
    return null;
  }

  try {
    const url = new URL(candidate.toString());
    if (!['http:', 'https:'].includes(url.protocol) || !isRuntimeAuthHost(url.hostname.toLowerCase())) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

export function resolveSiteName(value?: string | null) {
  return resolveTrimmedValue(value) ||
    resolveTrimmedValue(process.env.NEXT_PUBLIC_SITE_NAME) ||
    DEFAULT_SITE_NAME;
}

export function resolveSupportEmail(value?: string | null) {
  return resolveTrimmedValue(value) ||
    resolveTrimmedValue(process.env.NEXT_PUBLIC_SUPPORT_EMAIL) ||
    DEFAULT_SUPPORT_EMAIL;
}

export function resolveAppUrl() {
  const runtimeOrigin = resolveRuntimeAuthOrigin();
  if (runtimeOrigin) {
    return runtimeOrigin;
  }

  return normalizeAppOrigin(
    resolveTrimmedValue(process.env.NEXT_PUBLIC_APP_URL) ||
      (typeof window !== 'undefined' ? window.location.origin : null),
    DEFAULT_APP_URL
  );
}

export function resolveAuthAppUrl(runtimeOrigin?: string | URL | null) {
  const runtimeAuthOrigin = resolveRuntimeAuthOrigin(runtimeOrigin);
  if (runtimeAuthOrigin) {
    return runtimeAuthOrigin;
  }

  return normalizeAppOrigin(
    resolveTrimmedValue(process.env.NEXT_PUBLIC_AUTH_APP_URL) ||
      resolveTrimmedValue(process.env.NEXT_PUBLIC_APP_URL),
    DEFAULT_AUTH_APP_URL
  );
}

export function resolveAuthCallbackOrigin(requestOrigin: string | URL) {
  return resolveAuthAppUrl(requestOrigin);
}

function isGraylumHost(hostname: string) {
  return hostname === SHARED_COOKIE_DOMAIN.slice(1) || hostname.endsWith(SHARED_COOKIE_DOMAIN);
}

// Every host keeps a host-only session cookie (no Domain attribute), so sessions never cross hosts or
// environments; production stopped sharing .graylum.com when the app moved onto the single host.
export function resolveSupabaseCookieOptions(hostname?: string | null) {
  const normalizedHostname = resolveHostname(hostname);

  return {
    domain: undefined,
    path: '/',
    sameSite: 'lax' as const,
    secure: isGraylumHost(normalizedHostname),
  };
}

// Before host-only cookies, the production hosts and a staging host under graylum.com wrote the session
// to .graylum.com. Returns this project's cookie names that may still sit there, on any graylum.com host.
// Next to a host-only cookie of the same name the browser may send the stale parent copy first, which can
// sign the visitor out or loop through login (SEO_GEO_SPEC section 2), so the browser client expires them.
export function legacyParentCookieNames(cookieNames: string[], hostname?: string | null) {
  const normalizedHostname = resolveHostname(hostname);
  if (!isGraylumHost(normalizedHostname)) {
    return [];
  }

  const prefix = supabaseAuthCookiePrefix();
  return prefix ? cookieNames.filter(name => name.startsWith(prefix)) : [];
}

// Same storage key @supabase/ssr derives: sb-<first label of the project URL host>-auth-token.
function supabaseAuthCookiePrefix() {
  try {
    const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').hostname.split('.')[0];
    return ref ? `sb-${ref}-auth-token` : null;
  } catch {
    return null;
  }
}

// Links for moving around the site. In the browser they point at the app or auth origin. On the
// server there is no request origin here, so they stay relative and the current host serves them. URLs that
// must be absolute (email and OAuth redirects, payment return URLs) do not use these helpers; they
// pass an explicit origin to resolveAuthAppUrl or build from the request.
export function buildAppHref(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return typeof window === 'undefined' ? normalizedPath : `${resolveAppUrl()}${normalizedPath}`;
}

export function buildAuthHref(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return typeof window === 'undefined' ? normalizedPath : `${resolveAuthAppUrl()}${normalizedPath}`;
}

export {
  DEFAULT_APP_URL,
  DEFAULT_AUTH_APP_URL,
  DEFAULT_SITE_NAME,
  SHARED_COOKIE_DOMAIN,
  DEFAULT_SUPPORT_EMAIL,
};
