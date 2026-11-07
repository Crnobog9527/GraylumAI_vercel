/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { User } from '@supabase/supabase-js';
import { verifiedPhoneDigits } from './auth';

/**
 * The profile columns copied from the verified Auth user by the server (users may write only nickname, 0144):
 * email, and since PHONE-OTP the verified mainland phone. A field is only ever set, never cleared, and phone is
 * written only for phone accounts, so email accounts send exactly the update they sent before.
 */
export function profileIdentityUpdate(profile: { email?: string | null; phone?: string | null },
  user: User): { email?: string; phone?: string } | null {
  const update: { email?: string; phone?: string } = {};
  if (user.email && profile.email !== user.email) update.email = user.email; // '' on phone accounts: skipped
  const phone = verifiedPhoneDigits(user);
  if (phone && profile.phone !== phone) update.phone = phone;
  return Object.keys(update).length ? update : null;
}

/** The phone column for a new profile row: present only for phone accounts. */
export function profileInsertPhone(user: User): { phone?: string } {
  const phone = verifiedPhoneDigits(user);
  return phone ? { phone } : {};
}
