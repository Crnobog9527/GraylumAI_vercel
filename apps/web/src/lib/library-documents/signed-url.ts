/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Library links come from the server, but the page still only follows Supabase Storage signed URLs
 * on the configured project origin (never another site, never javascript: or data: URLs).
 */
export function isSignedStorageUrl(value: unknown, kind: 'read' | 'upload' = 'read', base = process.env.NEXT_PUBLIC_SUPABASE_URL) {
  if (typeof value !== 'string' || !base) return false;
  let url: URL;
  let origin: string;
  try {
    url = new URL(value);
    origin = new URL(base).origin;
  } catch {
    return false;
  }
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) return false;
  const prefix = kind === 'upload' ? '/storage/v1/object/upload/sign/' : '/storage/v1/object/sign/';
  return url.origin === origin && url.pathname.startsWith(prefix) && url.searchParams.has('token');
}

/** Starts a browser download from a short-lived signed URL without leaving the page. */
export function startDownload(url: string) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.rel = 'noopener noreferrer';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
