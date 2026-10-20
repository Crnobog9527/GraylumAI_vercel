import { createBrowserClient } from '@supabase/ssr';
import {
  legacyParentCookieNames,
  resolveSupabaseCookieOptions,
  SHARED_COOKIE_DOMAIN,
} from '@/lib/site-config';

let legacyCookiesCleared = false;

// Session cookies last 400 days, the browser maximum @supabase/ssr also uses.
const SESSION_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

function readCookiePairs() {
  return document.cookie
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const index = part.indexOf('=');
      return index < 0 ? [part, ''] : [part.slice(0, index), part.slice(index + 1)];
    });
}

// The production and staging hosts used to write the session to .graylum.com; next to a host-only cookie of the
// same name the browser may send the stale shared copy first. Expire only this project's copies there. If a name
// then disappears, the shared copy was the visitor's only session (signed in before the single-host move, E1), so
// its value is written back as a host-only cookie and the visitor stays signed in (SEO_GEO_SPEC section 2).
export function clearLegacyParentSessionCookies() {
  if (legacyCookiesCleared || typeof document === 'undefined') {
    return;
  }
  legacyCookiesCleared = true;

  const before = readCookiePairs();
  const names = [...new Set(before.map(([name]) => name))];
  for (const name of legacyParentCookieNames(names)) {
    const value = before.find(([candidate]) => candidate === name)?.[1] ?? '';
    document.cookie = `${name}=; Domain=${SHARED_COOKIE_DOMAIN}; Path=/; Max-Age=0; Secure; SameSite=Lax`;
    if (value && !readCookiePairs().some(([candidate]) => candidate === name)) {
      document.cookie = `${name}=${value}; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE}; Secure; SameSite=Lax`;
    }
  }
}

export function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing Supabase environment variables');
  }

  clearLegacyParentSessionCookies();
  return createBrowserClient(supabaseUrl, supabaseAnonKey, {
    cookieOptions: resolveSupabaseCookieOptions(),
  });
}
