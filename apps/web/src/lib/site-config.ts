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
  return normalizeAppOrigin(
    resolveTrimmedValue(process.env.NEXT_PUBLIC_APP_URL) ||
      (typeof window !== 'undefined' ? window.location.origin : null),
    DEFAULT_APP_URL
  );
}

export function resolveAuthAppUrl() {
  return normalizeAppOrigin(
    resolveTrimmedValue(process.env.NEXT_PUBLIC_AUTH_APP_URL) ||
      resolveTrimmedValue(process.env.NEXT_PUBLIC_APP_URL),
    DEFAULT_AUTH_APP_URL
  );
}

export function resolveSupabaseCookieOptions(hostname?: string | null) {
  const normalizedHostname = resolveHostname(hostname);
  const useSharedDomain =
    normalizedHostname === 'graylum.com' ||
    normalizedHostname === 'www.graylum.com' ||
    normalizedHostname === 'app.graylum.com' ||
    normalizedHostname.endsWith('.graylum.com');

  return {
    domain: useSharedDomain ? SHARED_COOKIE_DOMAIN : undefined,
    path: '/',
    sameSite: 'lax' as const,
    secure: useSharedDomain,
  };
}

export function buildAppHref(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${resolveAppUrl()}${normalizedPath}`;
}

export function buildAuthHref(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${resolveAuthAppUrl()}${normalizedPath}`;
}

export {
  DEFAULT_APP_URL,
  DEFAULT_AUTH_APP_URL,
  DEFAULT_SITE_NAME,
  SHARED_COOKIE_DOMAIN,
  DEFAULT_SUPPORT_EMAIL,
};
