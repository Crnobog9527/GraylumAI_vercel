/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/*
 * Who is signed in, read at once (no network, no promise) from the Supabase session cookie. The saved page data is kept per user, and
 * it must be known before the first paint which user's data to show. This is only used to pick (or refuse) saved data that this
 * browser itself saved: everything shown is read again from the server with the real session, so a forged cookie shows nothing it
 * did not already hold. Anything unreadable is "nobody": no saved data is shown or written.
 */
const SESSION_COOKIE = /^(sb-.+-auth-token)(?:\.(\d+))?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function userOfCookie(value: string): string | null {
  try {
    let raw = decodeURIComponent(value);
    if (raw.startsWith('base64-')) raw = decodeBase64Url(raw.slice('base64-'.length));
    const token = (JSON.parse(raw) as { access_token?: unknown }).access_token;
    if (typeof token !== 'string') return null;
    const sub = (JSON.parse(decodeBase64Url(token.split('.')[1] ?? '')) as { sub?: unknown }).sub;
    return typeof sub === 'string' && UUID.test(sub) ? sub.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function readSessionUserIdSync(cookie: string = typeof document === 'undefined' ? '' : document.cookie): string | null {
  const sessions = new Map<string, Array<[number, string]>>();
  for (const pair of cookie.split(';')) {
    const index = pair.indexOf('=');
    const match = index < 0 ? null : SESSION_COOKIE.exec(pair.slice(0, index).trim());
    if (!match) continue;
    sessions.set(match[1]!, [...(sessions.get(match[1]!) ?? []), [Number(match[2] ?? 0), pair.slice(index + 1).trim()]]);
  }
  const users = new Set<string>();
  for (const parts of sessions.values()) {
    const user = userOfCookie(parts.sort((a, b) => a[0] - b[0]).map(part => part[1]).join(''));
    if (user) users.add(user);
  }
  // Two different users in two session cookies: not knowing is the safe answer.
  return users.size === 1 ? [...users][0]! : null;
}
