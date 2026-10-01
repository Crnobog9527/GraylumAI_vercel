import { createBrowserClient } from '@supabase/ssr';
import {
  legacyParentCookieNames,
  resolveSupabaseCookieOptions,
  SHARED_COOKIE_DOMAIN,
} from '@/lib/site-config';

let legacyCookiesCleared = false;

// A staging host used to write its session to .graylum.com. Expire only this project's copies there;
// the host-only session cookie (no Domain attribute) is a different cookie and stays.
export function clearLegacyParentSessionCookies() {
  if (legacyCookiesCleared || typeof document === 'undefined') {
    return;
  }
  legacyCookiesCleared = true;

  const names = document.cookie
    .split(';')
    .map(part => part.split('=')[0].trim())
    .filter(Boolean);
  for (const name of legacyParentCookieNames(names)) {
    document.cookie = `${name}=; Domain=${SHARED_COOKIE_DOMAIN}; Path=/; Max-Age=0; Secure; SameSite=Lax`;
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
