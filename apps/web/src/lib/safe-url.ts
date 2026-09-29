/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Do not trim: URL parsers silently remove some control characters.
function hasUnsafeUrlCharacters(value: string) {
  return /[\u0000-\u0020\u007f\\]/u.test(value);
}

export function isSafeRelativePath(value: string) {
  return value.startsWith('/') && !value.startsWith('//') && !hasUnsafeUrlCharacters(value);
}

/** Exact HTTPS origins only; no suffix, substring, credential or port lookalikes. */
export function isAllowedHttpsUrl(value: string, allowedOrigins: readonly string[]) {
  if (hasUnsafeUrlCharacters(value) || !value.startsWith('https://')) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && allowedOrigins.includes(url.origin);
  } catch {
    return false;
  }
}
