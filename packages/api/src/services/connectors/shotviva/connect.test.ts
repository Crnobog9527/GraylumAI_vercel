/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ tier: vi.fn(), secret: vi.fn() }));
vi.mock('../../membershipEntitlements', () => ({ readOwnDataTier: mocks.tier }));
vi.mock('../../platformSecrets/reader', async () => {
  class PlatformSecretError extends Error { constructor(readonly code: string, readonly slot: string) { super(code); } }
  return { getPlatformSecret: mocks.secret, PlatformSecretError };
});
import { ShotvivaError } from './client';
import {
  disconnectShotviva, finishShotvivaConnect, loadShotvivaClient, readShotvivaStatus, SHOTVIVA_CALLBACK_PATH,
  ShotvivaConnectError, startShotvivaConnect,
} from './connect';
import { PlatformSecretError } from '../../platformSecrets/reader';

const me = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const SV = '00000000-0000-4000-8000-0000000000aa';
const CODE = 'c'.repeat(32);

/** One profile row with PostgREST's update ... where semantics. */
function db(row: Partial<{ shotviva_account_id: string | null; status: string; is_deleted: string }> = {},
  taken: string[] = []) {
  const state = { shotviva_account_id: null as string | null, status: 'active', is_deleted: 'false', ...row };
  const writes: unknown[] = [];
  const admin = { from: () => ({
    select: () => ({ eq: (_c: string, id: string) => ({ maybeSingle: async () => ({ data: id === me ? { ...state } : null, error: null }) }) }),
    update: (values: { shotviva_account_id: string | null }) => {
      const where: Array<[string, string]> = [];
      const run = async () => {
        writes.push(values);
        const current: Record<string, unknown> = { id: me, ...state };
        if (!where.every(([c, v]) => current[c] === v)) return { data: [], error: null };
        if (values.shotviva_account_id && taken.includes(values.shotviva_account_id)) return { data: null, error: { code: '23505' } };
        state.shotviva_account_id = values.shotviva_account_id;
        return { data: [{ id: me }], error: null };
      };
      const chain = {
        eq(c: string, v: string) { where.push([c, v]); return chain; },
        select: run,
        then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => run().then(resolve, reject),
      };
      return chain;
    },
  }) };
  return { admin: admin as never, state, writes };
}
const sv = (overrides: Partial<{ link: ReturnType<typeof vi.fn>; account: ReturnType<typeof vi.fn> }> = {}) => ({
  origin: 'https://shotviva.test',
  link: overrides.link ?? vi.fn(async () => ({ account_id: SV, display_name: 'j***', credits_remaining: 1, free_credits_remaining: 0 })),
  account: overrides.account ?? vi.fn(async () => ({ credits_remaining: 7, free_credits_remaining: 2, paid_until: null,
    top_up_url: 'https://shotviva.test/pricing?from=graylum' })),
}) as never;
const code = async (promise: Promise<unknown>) => promise.then(() => 'ok', (error: unknown) =>
  error instanceof ShotvivaConnectError ? error.code : String(error));

beforeEach(() => { vi.clearAllMocks(); mocks.tier.mockResolvedValue({ level: 'pro' }); });

describe('start', () => {
  it('sends a paid member to the Shotviva authorize page with a fresh state bound to this user', async () => {
    const { admin } = db();
    const started = await startShotvivaConnect({ admin, baseUrl: 'x', client: sv(), profileId: me, appOrigin: 'https://www.graylum.com' });
    const url = new URL(started.redirectUrl);
    expect(url.origin + url.pathname).toBe('https://shotviva.test/connect/graylum');
    expect(url.searchParams.get('return_to')).toBe(`https://www.graylum.com${SHOTVIVA_CALLBACK_PATH}`);
    const state = url.searchParams.get('state')!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.cookie).toBe(`${me}.${state}`);
    const again = await startShotvivaConnect({ admin, baseUrl: 'x', client: sv(), profileId: me, appOrigin: 'https://www.graylum.com' });
    expect(new URL(again.redirectUrl).searchParams.get('state')).not.toBe(state);
  });

  it('refuses a free member, a closed account, and a connector that is not configured', async () => {
    // Only Pro and Gold: free, an unknown level or no level at all are not let through by accident.
    for (const tier of [{ level: 'free' }, { level: 'basic' }, { level: undefined }, undefined]) {
      mocks.tier.mockResolvedValueOnce(tier);
      expect(await code(startShotvivaConnect({ admin: db().admin, baseUrl: 'x', client: sv(), profileId: me, appOrigin: 'https://a' })))
        .toBe('SHOTVIVA_MEMBERSHIP_REQUIRED');
    }
    mocks.tier.mockResolvedValueOnce({ level: 'gold' });
    expect(await code(startShotvivaConnect({ admin: db().admin, baseUrl: 'x', client: sv(), profileId: me, appOrigin: 'https://a' })))
      .toBe('ok');
    expect(await code(startShotvivaConnect({ admin: db({ status: 'banned' }).admin, baseUrl: 'x', client: sv(), profileId: me,
      appOrigin: 'https://a' }))).toBe('SHOTVIVA_ACCOUNT_CLOSED');
    expect(await code(startShotvivaConnect({ admin: db().admin, baseUrl: 'x', client: null, profileId: me, appOrigin: 'https://a' })))
      .toBe('SHOTVIVA_UNAVAILABLE');
  });
});

describe('callback', () => {
  const finish = (d: ReturnType<typeof db>, input: Partial<{ cookie: string; state: string | null; code: string | null }>,
    client = sv()) => finishShotvivaConnect({ admin: d.admin, baseUrl: 'x', client, profileId: me,
    cookie: `${me}.state-value-1234`, state: 'state-value-1234', code: CODE, ...input });

  it('a matching state and a valid code store the Shotviva account id, and nothing else', async () => {
    const d = db();
    const client = sv();
    expect(await finish(d, {}, client)).toEqual({ accountId: SV });
    expect(d.state.shotviva_account_id).toBe(SV);
    expect(d.writes).toEqual([{ shotviva_account_id: SV }]);
    expect((client as unknown as { link: ReturnType<typeof vi.fn> }).link).toHaveBeenCalledWith(CODE);
  });

  it('a missing or different state, or a cookie of another account, is refused before calling Shotviva', async () => {
    for (const input of [{ state: null }, { state: 'state-value-9999' }, { cookie: undefined }, { cookie: `${other}.state-value-1234` },
      { state: 'x'.repeat(600) }]) {
      const client = sv();
      expect(await code(finish(db(), input as never, client))).toBe('SHOTVIVA_STATE_INVALID');
      expect((client as unknown as { link: ReturnType<typeof vi.fn> }).link).not.toHaveBeenCalled();
    }
  });

  it('a bad, expired or reused code is "code invalid"; the account stays unconnected', async () => {
    expect(await code(finish(db(), { code: 'short' }))).toBe('SHOTVIVA_CODE_INVALID');
    const d = db();
    const expired = sv({ link: vi.fn(async () => { throw new ShotvivaError('invalid_input', 422); }) });
    expect(await code(finish(d, {}, expired))).toBe('SHOTVIVA_CODE_INVALID');
    expect(d.state.shotviva_account_id).toBeNull();
    const down = sv({ link: vi.fn(async () => { throw new ShotvivaError('unavailable', null); }) });
    expect(await code(finish(db(), {}, down))).toBe('SHOTVIVA_UNAVAILABLE');
  });

  it('a free member, or an account closed meanwhile, is not connected', async () => {
    mocks.tier.mockResolvedValueOnce({ level: 'free' });
    expect(await code(finish(db(), {}))).toBe('SHOTVIVA_MEMBERSHIP_REQUIRED');
    expect(await code(finish(db({ is_deleted: 'true' }), {}))).toBe('SHOTVIVA_ACCOUNT_CLOSED');
  });
});

describe('status and disconnect', () => {
  it('a top-up link off Shotviva\'s domain is dropped (no button), never passed to the page', async () => {
    const evil = sv({ account: vi.fn(async () => ({ credits_remaining: 1, free_credits_remaining: 0, paid_until: null,
      top_up_url: 'https://evil.test/pricing' })) });
    expect((await readShotvivaStatus({ admin: db({ shotviva_account_id: SV }).admin, baseUrl: 'x', client: evil, profileId: me }))
      .balance?.topUpUrl).toBeNull();
  });

  it('connected: the balance from Shotviva', async () => {
    expect(await readShotvivaStatus({ admin: db({ shotviva_account_id: SV }).admin, baseUrl: 'x', client: sv(), profileId: me }))
      .toEqual({ available: true, eligible: true, connected: true,
        balance: { credits: 7, freeCredits: 2, paidUntil: null, topUpUrl: 'https://shotviva.test/pricing?from=graylum' } });
  });

  it('not configured, or not connected: no call to Shotviva', async () => {
    const client = sv();
    mocks.tier.mockResolvedValueOnce({ level: 'free' });
    expect(await readShotvivaStatus({ admin: db().admin, baseUrl: 'x', client, profileId: me }))
      .toEqual({ available: true, eligible: false, connected: false, balance: null });
    expect(await readShotvivaStatus({ admin: db().admin, baseUrl: 'x', client: null, profileId: me }))
      .toEqual({ available: false, eligible: true, connected: false, balance: null });
    expect((client as unknown as { account: ReturnType<typeof vi.fn> }).account).not.toHaveBeenCalled();
  });

  it('a link the user revoked on Shotviva is cleared here; a passing failure keeps the connection', async () => {
    const d = db({ shotviva_account_id: SV });
    const revoked = sv({ account: vi.fn(async () => { throw new ShotvivaError('link_revoked', 401); }) });
    expect((await readShotvivaStatus({ admin: d.admin, baseUrl: 'x', client: revoked, profileId: me })).connected).toBe(false);
    expect(d.state.shotviva_account_id).toBeNull();
    const kept = db({ shotviva_account_id: SV });
    const down = sv({ account: vi.fn(async () => { throw new ShotvivaError('unavailable', 503); }) });
    expect(await readShotvivaStatus({ admin: kept.admin, baseUrl: 'x', client: down, profileId: me }))
      .toMatchObject({ connected: true, balance: null });
    expect(kept.state.shotviva_account_id).toBe(SV);
  });

  it('disconnect clears the id', async () => {
    const d = db({ shotviva_account_id: SV });
    expect(await disconnectShotviva({ admin: d.admin, profileId: me })).toEqual({ connected: false });
    expect(d.state.shotviva_account_id).toBeNull();
  });
});

describe('loadShotvivaClient', () => {
  it('off without an address or a key; a Vault failure is "unavailable", not "off"', async () => {
    const { admin } = db();
    expect(await loadShotvivaClient({ admin, baseUrl: undefined })).toBeNull();
    mocks.secret.mockRejectedValueOnce(new PlatformSecretError('PLATFORM_SECRET_NOT_CONFIGURED', 'shotviva'));
    expect(await loadShotvivaClient({ admin, baseUrl: 'https://shotviva.test' })).toBeNull();
    mocks.secret.mockResolvedValueOnce({ value: 'not-a-shotviva-key-000000' });
    expect(await loadShotvivaClient({ admin, baseUrl: 'https://shotviva.test' })).toBeNull();
    mocks.secret.mockResolvedValueOnce({ value: 'sv_test_fixturekey0000' });
    expect((await loadShotvivaClient({ admin, baseUrl: 'https://shotviva.test' }))?.origin).toBe('https://shotviva.test');
    mocks.secret.mockRejectedValueOnce(new PlatformSecretError('PLATFORM_SECRET_UNAVAILABLE', 'shotviva'));
    expect(await code(loadShotvivaClient({ admin, baseUrl: 'https://shotviva.test' }))).toBe('SHOTVIVA_UNAVAILABLE');
  });
});
