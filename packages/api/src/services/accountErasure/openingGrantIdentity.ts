// Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { readOpeningGrantKeyring } from '../../lib/openingGrantKeyring';
import { verifiedPhoneDigits } from '../../lib/auth';
import { getClientIp } from '../clientIp';

export type OpeningGrantDigest = { kind: 'email' | 'oauth'; key_version: string; digest: string };

/** Auth lowercases email; trim surrounding input whitespace, retaining dots and plus aliases. */
export function normalizeOpeningGrantEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * BOT-GUARD part 3 (controller 2026-11-13): mailbox providers that deliver `name+anything@` to `name@` (and, for Gmail, ignore
 * dots in the name). Only providers documented to do so are listed; elsewhere `+` and dots may be part of a real, different
 * address, so they are left alone. Googlemail is the same mailbox as Gmail.
 */
const DOTLESS_DOMAINS: Record<string, string> = { 'gmail.com': 'gmail.com', 'googlemail.com': 'gmail.com' };
export const PLUS_ADDRESS_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me', 'pm.me', 'fastmail.com',
]);

/** The mailbox an address really reaches, when that differs from the address itself; otherwise null. */
export function canonicalOpeningGrantEmail(email: string): string | null {
  const normalized = normalizeOpeningGrantEmail(email);
  const at = normalized.lastIndexOf('@');
  if (at <= 0) return null;
  let local = normalized.slice(0, at);
  let domain = normalized.slice(at + 1);
  if (!PLUS_ADDRESS_DOMAINS.has(domain)) return null;
  local = local.split('+')[0]!;
  if (domain in DOTLESS_DOMAINS) { local = local.replaceAll('.', ''); domain = DOTLESS_DOMAINS[domain]!; }
  const canonical = local ? `${local}@${domain}` : null;
  return canonical && canonical !== normalized ? canonical : null;
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
    // The same mailbox under another spelling (a.b+x@gmail.com is ab@gmail.com) is the same identity: one grant per mailbox.
    const canonical = canonicalOpeningGrantEmail(user.email);
    if (canonical) identities.push({ kind: 'email', parts: [canonical] });
  }
  // PHONE-OTP: a verified mainland number is an identity of its own, kept in the existing 'oauth' kind under the fixed
  // issuer 'phone' (no OAuth issuer is a bare word), so the grant and Waffo SQL checks are unchanged.
  const phone = verifiedPhoneDigits(user);
  if (phone) identities.push({ kind: 'oauth', parts: ['phone', phone] });
  for (const identity of user.identities ?? []) {
    if (identity.provider === 'email' || identity.provider === 'phone') continue;
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

/** BOT-GUARD: the visitor's address for the opening grant's same-IP rule; null when the proxy header is not an IP. */
export function openingGrantIp(headers: Headers | undefined): string | null {
  const ip = headers ? getClientIp(headers) : null;
  return ip && isIP(ip) ? ip : null;
}
