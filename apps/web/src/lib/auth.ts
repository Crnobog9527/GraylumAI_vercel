import { isSafeRelativePath } from './safe-url';
import type { User } from '@supabase/supabase-js';

export type AppAuthProvider = 'email' | 'google' | 'unknown';

export function getAuthProvider(user: User | null | undefined): AppAuthProvider {
  if (!user) return 'unknown';

  const provider = user.app_metadata?.provider;
  const providers = Array.isArray(user.app_metadata?.providers)
    ? user.app_metadata.providers
    : [];

  if (provider === 'google' || providers.includes('google')) {
    return 'google';
  }

  if (provider === 'email' || providers.includes('email')) {
    return 'email';
  }

  return user.email ? 'email' : 'unknown';
}

export function isEmailVerified(user: User | null | undefined): boolean {
  if (!user) return false;

  if (getAuthProvider(user) === 'google') {
    return true;
  }

  if ('email_confirmed_at' in user && user.email_confirmed_at) {
    return true;
  }

  const identities = Array.isArray(user.identities) ? user.identities : [];
  return identities.some((identity) => {
    const emailVerified = identity.identity_data?.email_verified;
    return emailVerified === true || emailVerified === 'true';
  });
}

const DEFAULT_REDIRECT_TARGET = '/profile';

// Parameters GoTrue adds to the page it sends an email or OAuth link back to. They belong to that
// one landing, never to where the visitor should end up, so they are dropped from redirect targets.
const AUTH_LANDING_PARAMS = ['code', 'error', 'error_code', 'error_description'];

function stripAuthParams(params: string) {
  const search = new URLSearchParams(params);
  if (!AUTH_LANDING_PARAMS.some(name => search.has(name))) {
    return { value: params, stripped: false };
  }
  AUTH_LANDING_PARAMS.forEach(name => search.delete(name));
  return { value: search.toString(), stripped: true };
}

// Works on the string instead of re-serializing a parsed URL, which could turn a path such as
// /.//evil.example into the protocol-relative //evil.example. The result is checked again.
function stripAuthLandingParams(target: string) {
  const hashIndex = target.indexOf('#');
  const beforeHash = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
  const queryIndex = beforeHash.indexOf('?');
  const path = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;
  const query = stripAuthParams(queryIndex >= 0 ? beforeHash.slice(queryIndex + 1) : '');
  const hash = stripAuthParams(hashIndex >= 0 ? target.slice(hashIndex + 1) : '');
  if (!query.stripped && !hash.stripped) {
    return target;
  }

  const rebuilt = `${path}${query.value ? `?${query.value}` : ''}${hash.value ? `#${hash.value}` : ''}`;
  // A bare root was only GoTrue's fallback landing, not a page the visitor asked for.
  return rebuilt === '/' ? DEFAULT_REDIRECT_TARGET : rebuilt;
}

export function sanitizeRedirectTarget(redirect: string | null | undefined) {
  if (!redirect || !isSafeRelativePath(redirect)) {
    return DEFAULT_REDIRECT_TARGET;
  }

  const target = stripAuthLandingParams(redirect);
  return isSafeRelativePath(target) ? target : DEFAULT_REDIRECT_TARGET;
}
