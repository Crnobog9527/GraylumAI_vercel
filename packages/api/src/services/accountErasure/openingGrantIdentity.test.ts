// Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { readOpeningGrantKeyring } from '../../lib/openingGrantKeyring';
import { loadOpeningGrantDigests, normalizeOpeningGrantEmail, openingGrantDigests } from './openingGrantIdentity';

const original = { ...process.env };
const key = Buffer.from('test-only-opening-grant-key-00001').toString('base64');
const key2 = Buffer.from('test-only-opening-grant-key-00002').toString('base64');
const keys = JSON.stringify({ active: 'v1', keys: { v1: key } });
const rotated = JSON.stringify({ active: 'v2', keys: { v1: key, v2: key2 } });
const user = (email: string | undefined, provider = 'email', sub?: string, iss?: string) => ({
  id: '00000000-0000-4000-8000-000000000001', email,
  app_metadata: { provider, providers: [provider] },
  user_metadata: { nickname: 'same nickname', sub: 'untrusted', iss: 'untrusted' },
  identities: provider === 'email' ? [] : [{ provider, identity_data: { sub, iss } }],
}) as unknown as User;
afterEach(() => { process.env = { ...original }; });

describe('opening-grant HMAC identity boundary', () => {
  it('uses only Auth normalization for casing and surrounding whitespace', () => {
    expect(normalizeOpeningGrantEmail('  Mixed.Case+tag@EXAMPLE.TEST \t')).toBe('mixed.case+tag@example.test');
    expect(openingGrantDigests(user('  Mixed.Case+tag@EXAMPLE.TEST \t'), keys))
      .toEqual(openingGrantDigests(user('mixed.case+tag@example.test'), keys));
  });
  it('keeps dotted and plus aliases distinct', () => {
    const digests = ['some.one@example.test', 'someone@example.test', 'someone+tag@example.test']
      .map(email => openingGrantDigests(user(email), keys)[0].digest);
    expect(new Set(digests).size).toBe(3);
  });
  it('records both email and stable Google issuer+subject, ignoring nicknames and metadata', () => {
    const first = openingGrantDigests(user('first@example.test', 'google', 'stable-sub'), keys);
    const second = openingGrantDigests(user('changed@example.test', 'google', 'stable-sub', 'accounts.google.com'), keys);
    expect(first.map(item => item.kind)).toEqual(['email', 'oauth']);
    expect(first[1]).toEqual(second[1]);
    expect(first[0]).not.toEqual(second[0]);
    expect(first[1]).not.toEqual(openingGrantDigests(user('first@example.test', 'google', 'other-sub'), keys)[1]);
    const serialized = JSON.stringify(first);
    for (const raw of ['first@example.test', 'stable-sub', 'google.com', 'same nickname', 'untrusted']) {
      expect(serialized).not.toContain(raw);
    }
    expect(first.every(item => /^[a-f0-9]{64}$/.test(item.digest))).toBe(true);
  });
  it('different issuers with the same subject remain different; missing subjects fail closed', () => {
    const a = openingGrantDigests(user(undefined, 'oidc', 'sub', 'https://issuer-a.example.test'), keys);
    const b = openingGrantDigests(user(undefined, 'oidc', 'sub', 'https://issuer-b.example.test'), keys);
    expect(a).not.toEqual(b);
    expect(() => openingGrantDigests(user('a@example.test', 'google'), keys)).toThrow('IDENTITY_INVALID');
    expect(() => openingGrantDigests(user(undefined), keys)).toThrow('IDENTITY_MISSING');
    const missing = user('a@example.test', 'google', 'sub');
    missing.identities = [];
    expect(() => openingGrantDigests(missing, keys)).toThrow('IDENTITY_INVALID');
  });
  it('rotation retains the exact old-version digest and adds a distinct new digest', () => {
    const old = openingGrantDigests(user('a@example.test'), keys);
    const next = openingGrantDigests(user('a@example.test'), rotated);
    expect(next).toContainEqual(old[0]);
    expect(next[1].key_version).toBe('v2');
    expect(next[1].digest).not.toBe(old[0].digest);
  });
  it('deduplicates repeated identities', () => {
    const account = user(undefined, 'google', 'stable-sub');
    account.identities!.push(account.identities![0]);
    expect(openingGrantDigests(account, keys)).toHaveLength(1);
  });
  it('loads only the requested server-authenticated identity and refuses lookup failures/mismatch', async () => {
    process.env.OPENING_GRANT_HMAC_KEYS = keys;
    const account = user('a@example.test');
    const getUserById = vi.fn().mockResolvedValue({ data: { user: account }, error: null });
    const admin = { auth: { admin: { getUserById } } } as unknown as SupabaseClient;
    await expect(loadOpeningGrantDigests(admin, account.id)).resolves.toEqual(openingGrantDigests(account, keys));
    expect(getUserById).toHaveBeenCalledWith(account.id);
    getUserById.mockResolvedValueOnce({ data: { user: account }, error: { message: 'private-value' } });
    await expect(loadOpeningGrantDigests(admin, account.id)).rejects.toThrow('IDENTITY_UNAVAILABLE');
    await expect(loadOpeningGrantDigests(admin, 'other-id')).rejects.toThrow('IDENTITY_UNAVAILABLE');
  });
});

describe('independent HMAC keyring', () => {
  it('accepts a versioned test keyring only outside deployed environments', () => {
    expect(readOpeningGrantKeyring(rotated).keys).toHaveLength(2);
    process.env.VERCEL_ENV = 'preview';
    expect(() => readOpeningGrantKeyring(rotated)).toThrow('missing or invalid');
  });
  it.each([
    '', 'private-malformed-value', '{}',
    JSON.stringify({ active: 'v2', keys: { v1: key } }),
    JSON.stringify({ active: 'v1', keys: { v1: 'short' } }),
    JSON.stringify({ active: 'v1', keys: { v1: key, v2: key } }),
    JSON.stringify({ active: 'v1', keys: { v1: `${key} ` } }),
    JSON.stringify({ active: 'v1', keys: { v1: key }, unexpected: 'private-value' }),
  ])('rejects invalid configuration without returning submitted values', value => {
    expect(() => readOpeningGrantKeyring(value)).toThrow('OPENING_GRANT_HMAC_KEYS missing or invalid');
  });
});
