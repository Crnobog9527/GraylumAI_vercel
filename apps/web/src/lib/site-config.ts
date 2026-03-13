/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

const DEFAULT_SITE_NAME = 'GraylumAI';
const DEFAULT_SUPPORT_EMAIL = 'support@example.com';
const DEFAULT_APP_URL = 'http://localhost:3000';

function resolveTrimmedValue(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
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
  return resolveTrimmedValue(process.env.NEXT_PUBLIC_APP_URL) ||
    (typeof window !== 'undefined' ? window.location.origin : null) ||
    DEFAULT_APP_URL;
}

export function buildAppHref(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${resolveAppUrl()}${normalizedPath}`;
}

export {
  DEFAULT_APP_URL,
  DEFAULT_SITE_NAME,
  DEFAULT_SUPPORT_EMAIL,
};
