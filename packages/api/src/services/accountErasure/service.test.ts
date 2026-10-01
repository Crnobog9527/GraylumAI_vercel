import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient, User } from '@supabase/supabase-js';

const limit = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('../redisRateLimiter', () => ({ checkRateLimitOrThrow: limit.check }));

import { confirmAccountErasure, loadAccountErasurePreview } from './service';
import { openingGrantDigests } from './openingGrantIdentity';
import { REAUTH_MAX_AGE_SECONDS, REAUTH_REQUIRED_MESSAGE } from './reauth';

const USER = '00000000-0000-4000-8000-000000000001';
const REQUEST = '00000000-0000-4000-8000-0000000000aa';
const NOW_MS = Date.parse('2026-09-30T12:00:00.000Z');
const NOW_S = NOW_MS / 1000;

function authClient(claims: Record<string, unknown> | null, error: unknown = null) {
  return { auth: { getClaims: vi.fn().mockResolvedValue({ data: claims ? { claims } : null, error }) } };
}

function adminClient(options: {
  confirm?: { data?: unknown; error?: { message: string; code?: string } | null };
  banError?: { status?: number } | null;
} = {}) {
  const rpc = vi.fn(async (name: string) => {
    if (name === 'account_erasure_confirm_with_digests') {
      return {
        data: options.confirm?.data ?? {
          requestId: REQUEST, stage: 'closed', confirmedAt: '2026-09-30T12:00:00Z', created: true,
        },
        error: options.confirm?.error ?? null,
      };
    }
    return { data: null, error: null };
  });
  const updateUserById = vi.fn().mockResolvedValue({ error: options.banError ?? null });
  return { rpc, auth: { admin: { updateUserById, getUserById: vi.fn().mockResolvedValue({
    data: { user: { id: USER, email: 'fixture@example.test', identities: [] } }, error: null,
  }) } } };
}

function confirm(admin: ReturnType<typeof adminClient>, auth: unknown, headers = new Headers()) {
  return confirmAccountErasure({
    admin: admin as unknown as SupabaseClient, authClient: auth as SupabaseClient | null, headers, userId: USER, requestId: REQUEST, nowMs: NOW_MS,
  });
}

describe('account erasure confirm', () => {
  beforeEach(() => {
    process.env.OPENING_GRANT_HMAC_KEYS = JSON.stringify({ active: 'test-v1',
      keys: { 'test-v1': Buffer.from('test-only-opening-grant-key-00001').toString('base64') } });
    limit.check.mockReset().mockResolvedValue({ success: true });
  });

  it('closes the account after a recent verified sign-in and bans the Auth user', async () => {
    const admin = adminClient();
    const auth = authClient({ sub: USER, amr: [{ method: 'password', timestamp: NOW_S - 60 }] });

    await expect(confirm(admin, auth)).resolves.toMatchObject({ requestId: REQUEST, created: true, authRevoked: true });
    expect(limit.check).toHaveBeenCalledWith(`account-erasure:${USER}`, 'auth');
    expect(admin.rpc).toHaveBeenCalledWith('account_erasure_confirm_with_digests', {
      p_profile_id: USER, p_request_id: REQUEST,
      p_digests: openingGrantDigests({ id: USER, email: 'fixture@example.test', identities: [] } as unknown as User),
    });
    expect(admin.auth.admin.updateUserById).toHaveBeenCalledWith(USER, { ban_duration: '876000h' });
  });

  it('accepts an email-code sign-in and passes a Bearer token to claim verification', async () => {
    const admin = adminClient();
    const auth = authClient({ sub: USER, amr: [{ method: 'otp', timestamp: NOW_S - 5 }] });

    await confirm(admin, auth, new Headers({ Authorization: 'Bearer jwt-1' }));
    expect(auth.auth.getClaims).toHaveBeenCalledWith('jwt-1');
  });

  it.each([
    ['stale sign-in', { sub: USER, amr: [{ method: 'password', timestamp: NOW_S - REAUTH_MAX_AGE_SECONDS - 1 }] }],
    ['future timestamp', { sub: USER, amr: [{ method: 'otp', timestamp: NOW_S + 3600 }] }],
    ['no timestamps', { sub: USER, amr: ['password'] }],
    ['no amr', { sub: USER }],
    ['another subject', { sub: '00000000-0000-4000-8000-000000000002', amr: [{ method: 'otp', timestamp: NOW_S }] }],
  ])('rejects %s before touching the database', async (_name, claims) => {
    const admin = adminClient();
    await expect(confirm(admin, authClient(claims))).rejects.toMatchObject({
      code: 'FORBIDDEN', message: REAUTH_REQUIRED_MESSAGE,
    });
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('rejects unverifiable claims and a missing auth client', async () => {
    const admin = adminClient();
    await expect(confirm(admin, authClient(null, { message: 'invalid JWT' }))).rejects.toMatchObject({
      message: REAUTH_REQUIRED_MESSAGE,
    });
    await expect(confirm(admin, null)).rejects.toMatchObject({ message: REAUTH_REQUIRED_MESSAGE });
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('stops at the rate limit', async () => {
    limit.check.mockRejectedValueOnce(Object.assign(new Error('rate'), { code: 'TOO_MANY_REQUESTS' }));
    const admin = adminClient();
    await expect(confirm(admin, authClient({ sub: USER, amr: [{ method: 'otp', timestamp: NOW_S }] })))
      .rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('fails closed before confirmation when the verified identity is unavailable', async () => {
    const admin = adminClient();
    admin.auth.admin.getUserById.mockResolvedValueOnce({ data: { user: null }, error: null });
    await expect(confirm(admin, authClient({ sub: USER, amr: [{ method: 'otp', timestamp: NOW_S }] })))
      .rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(admin.auth.admin.updateUserById).not.toHaveBeenCalled();
  });

  it('refuses while a subscription still renews, as enforced by the database', async () => {
    const admin = adminClient({
      confirm: { data: null, error: { message: 'ACCOUNT_ERASURE_SUBSCRIPTION_RENEWING', code: 'P0001' } },
    });
    await expect(confirm(admin, authClient({ sub: USER, amr: [{ method: 'otp', timestamp: NOW_S }] })))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(admin.auth.admin.updateUserById).not.toHaveBeenCalled();
  });

  it('hides unknown database errors', async () => {
    const admin = adminClient({ confirm: { data: null, error: { message: 'PRIVATE DETAIL', code: 'XX000' } } });
    const promise = confirm(admin, authClient({ sub: USER, amr: [{ method: 'otp', timestamp: NOW_S }] }));
    await expect(promise).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    await expect(promise).rejects.not.toThrow(/PRIVATE/);
  });

  it('keeps the closure and records the failure when the Auth ban fails', async () => {
    const admin = adminClient({ banError: { status: 500 } });
    await expect(confirm(admin, authClient({ sub: USER, amr: [{ method: 'otp', timestamp: NOW_S }] })))
      .resolves.toMatchObject({ created: true, authRevoked: false });
    expect(admin.rpc).toHaveBeenCalledWith('account_erasure_note_error', { p_profile_id: USER, p_code: 'AUTH_BAN_FAILED' });
  });
});

describe('account erasure preview', () => {
  it('returns the database facts and rejects a malformed shape', async () => {
    const facts = {
      credits: 40, subscriptionRenewing: true, subscriptionActiveUntil: '2026-10-30T00:00:00Z',
      pendingPayments: 0, runsInFlight: 1, closed: false,
    };
    const admin = { rpc: vi.fn().mockResolvedValue({ data: facts, error: null }) };
    await expect(loadAccountErasurePreview(admin as unknown as SupabaseClient, USER)).resolves.toEqual(facts);
    expect(admin.rpc).toHaveBeenCalledWith('account_erasure_preview', { p_profile_id: USER });

    admin.rpc.mockResolvedValueOnce({ data: { credits: '40' }, error: null });
    await expect(loadAccountErasurePreview(admin as unknown as SupabaseClient, USER)).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });
});
