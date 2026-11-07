import { describe, expect, it } from 'vitest';
import { assertRecentAuthTime, readVerifiedAuthTime } from './reauth';

// PHONE-OTP: an SMS code sign-in (amr method "otp") re-authorizes account erasure like a password or email code.
const USER = '00000000-0000-4000-8000-000000000001';
const NOW = Date.parse('2026-11-08T03:00:00Z');
const client = (claims: unknown, error: unknown = null) => ({ auth: { getClaims: async () => ({ data: { claims }, error }) } });

describe('account erasure re-authentication with an SMS code', () => {
  it('allows a fresh SMS sign-in of the same user', async () => {
    const time = await readVerifiedAuthTime({ authClient: client({ sub: USER, amr: [{ method: 'otp', timestamp: NOW / 1000 - 30 }] }) as never,
      userId: USER });
    expect(time).toBe(NOW / 1000 - 30);
    expect(() => assertRecentAuthTime(time, NOW)).not.toThrow();
  });

  it('denies an old sign-in, another user, unverifiable claims and no sign-in time', async () => {
    const old = await readVerifiedAuthTime({ authClient: client({ sub: USER, amr: [{ method: 'otp', timestamp: NOW / 1000 - 11 * 60 }] }) as never,
      userId: USER });
    expect(() => assertRecentAuthTime(old, NOW)).toThrow('ACCOUNT_ERASURE_REAUTH_REQUIRED');
    expect(await readVerifiedAuthTime({ authClient: client({ sub: 'other', amr: [{ method: 'otp', timestamp: NOW / 1000 }] }) as never,
      userId: USER })).toBeNull();
    expect(await readVerifiedAuthTime({ authClient: client(null, { message: 'bad' }) as never, userId: USER })).toBeNull();
    expect(() => assertRecentAuthTime(null, NOW)).toThrow('ACCOUNT_ERASURE_REAUTH_REQUIRED');
  });
});
