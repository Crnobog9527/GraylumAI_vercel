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

export function sanitizeRedirectTarget(redirect: string | null | undefined) {
  if (!redirect || !redirect.startsWith('/') || redirect.startsWith('//')) {
    return '/profile';
  }

  return redirect;
}
