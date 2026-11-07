import type { User } from '@supabase/supabase-js';
import { parseStoredPhone } from '../shared/mainlandPhone';

export type ApiAuthProvider = 'email' | 'google' | 'phone' | 'unknown';

export function getAuthProvider(user: User | null | undefined): ApiAuthProvider {
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

  if (provider === 'phone' || providers.includes('phone')) {
    return 'phone';
  }

  return user.email ? 'email' : 'unknown';
}

/** PHONE-OTP: a mainland number Supabase confirmed with an SMS code, in stored digits (8613800005678); null otherwise. */
export function verifiedPhoneDigits(user: User | null | undefined): string | null {
  if (!user?.phone || !user.phone_confirmed_at) return null;
  return parseStoredPhone(user.phone)?.digits ?? null;
}

/** A verified email, a Google sign-in, or (PHONE-OTP, Owner 2026-11-07) a verified mainland phone number. */
export function isEmailVerified(user: User | null | undefined): boolean {
  if (!user) return false;

  if (getAuthProvider(user) === 'google') {
    return true;
  }

  if ('email_confirmed_at' in user && user.email_confirmed_at) {
    return true;
  }

  if (verifiedPhoneDigits(user)) {
    return true;
  }

  const identities = Array.isArray(user.identities) ? user.identities : [];
  return identities.some((identity) => {
    const emailVerified = identity.identity_data?.email_verified;
    return emailVerified === true || emailVerified === 'true';
  });
}
