/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

const DEFAULT_SITE_NAME = 'GraylumAI';
const DEFAULT_SUPPORT_EMAIL = 'support@example.com';
const DEFAULT_APP_URL = 'http://localhost:3000';
const DEFAULT_AUTH_APP_URL = 'https://app.graylum.com';
const SHARED_COOKIE_DOMAIN = '.graylum.com';

// Production hosts. Only these share the parent-domain session cookie; every other host, including
// a staging domain under graylum.com, keeps a host-only cookie so sessions never cross environments.
const PUBLIC_SITE_HOSTS = new Set(['graylum.com', 'www.graylum.com']);
const SHARED_COOKIE_HOSTS = new Set([...PUBLIC_SITE_HOSTS, 'app.graylum.com']);
// App hosts whose own origin serves login, the auth callback and the verify page. Matched exactly so a
// request's Host header alone never chooses where auth redirects go.
const STAGING_APP_HOSTS = new Set(['auth-staging.graylum.com']);

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

    if (normalizedHost === 'graylum.com' || normalizedHost === 'www.graylum.com') {
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

export function isPublicSiteHost(hostname: string) {
  return PUBLIC_SITE_HOSTS.has(hostname);
}

function isRuntimeAuthHost(hostname: string) {
  return (
    STAGING_APP_HOSTS.has(hostname) ||
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

export function resolveSupabaseCookieOptions(hostname?: string | null) {
  const normalizedHostname = resolveHostname(hostname);
  const useSharedDomain = SHARED_COOKIE_HOSTS.has(normalizedHostname);

  return {
    domain: useSharedDomain ? SHARED_COOKIE_DOMAIN : undefined,
    path: '/',
    sameSite: 'lax' as const,
    secure: useSharedDomain || normalizedHostname.endsWith(SHARED_COOKIE_DOMAIN),
  };
}

// Before host-only cookies, a staging host under graylum.com wrote its session to .graylum.com.
// Returns this project's cookie names that may still sit there; production hosts return none.
export function legacyParentCookieNames(cookieNames: string[], hostname?: string | null) {
  const normalizedHostname = resolveHostname(hostname);
  if (SHARED_COOKIE_HOSTS.has(normalizedHostname) || !normalizedHostname.endsWith(SHARED_COOKIE_DOMAIN)) {
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
// server there is no request origin here, so they stay relative: the current host serves them, and on
// the public site the proxy forwards non-public paths such as /login to the app domain. URLs that
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
