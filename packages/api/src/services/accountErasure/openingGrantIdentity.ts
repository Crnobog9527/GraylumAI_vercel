// Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
import { createHmac } from 'node:crypto';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { readOpeningGrantKeyring } from '../../lib/openingGrantKeyring';

export type OpeningGrantDigest = { kind: 'email' | 'oauth'; key_version: string; digest: string };

/** Auth lowercases email; trim surrounding input whitespace, retaining dots and plus aliases. */
export function normalizeOpeningGrantEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Input must be a server-verified Auth user, never user_metadata or a client-supplied identity. */
export function openingGrantDigests(user: User, value?: string): OpeningGrantDigest[] {
  const keyring = readOpeningGrantKeyring(value);
  const identities: { kind: OpeningGrantDigest['kind']; parts: string[] }[] = [];
  const providers = Array.isArray(user.app_metadata?.providers) ? user.app_metadata.providers : [];
  if (user.app_metadata?.provider === 'google' || providers.includes('google')) {
    if (!(user.identities ?? []).some(identity => identity.provider === 'google')) {
      throw new Error('OPENING_GRANT_IDENTITY_INVALID');
    }
  }
  if (user.email) {
    const email = normalizeOpeningGrantEmail(user.email);
    if (email) identities.push({ kind: 'email', parts: [email] });
  }
  for (const identity of user.identities ?? []) {
    if (identity.provider === 'email') continue;
    const data = identity.identity_data ?? {};
    const subject = data.sub;
    // Google is the repository's current OAuth provider. Its verified provider namespace
    // determines the canonical issuer even when the Auth identity omits the optional iss claim.
    const issuer = identity.provider === 'google' ? 'https://accounts.google.com' : data.iss;
    if (typeof subject !== 'string' || !subject || typeof issuer !== 'string' || !issuer) {
      throw new Error('OPENING_GRANT_IDENTITY_INVALID');
    }
    identities.push({ kind: 'oauth', parts: [issuer, subject] });
  }
  if (!identities.length) throw new Error('OPENING_GRANT_IDENTITY_MISSING');
  const digests = identities.flatMap(identity => keyring.keys.map(({ keyVersion, key }) => ({
    kind: identity.kind,
    key_version: keyVersion,
    digest: createHmac('sha256', key)
      .update(JSON.stringify(['opening_grant', identity.kind, ...identity.parts])).digest('hex'),
  })));
  return [...new Map(digests.map(digest => [JSON.stringify(digest), digest])).values()];
}

export async function loadOpeningGrantDigests(admin: SupabaseClient, userId: string) {
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || !data.user || data.user.id !== userId) throw new Error('OPENING_GRANT_IDENTITY_UNAVAILABLE');
  return openingGrantDigests(data.user);
}
