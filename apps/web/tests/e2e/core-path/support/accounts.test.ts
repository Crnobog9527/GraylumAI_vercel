import { describe, expect, it } from 'vitest';

import { identityFromState } from './accounts';

const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
const session = (payload: object) => JSON.stringify({ access_token: jwt(payload), refresh_token: 'r' });

describe('identityFromState', () => {
  it('reads the account from a plain session cookie', () => {
    const value = encodeURIComponent(session({ sub: 'user-1', email: 'a@example.com' }));
    expect(identityFromState({ cookies: [{ name: 'sb-abc-auth-token', value }] })).toEqual({ id: 'user-1', email: 'a@example.com' });
  });

  it('reads a base64-prefixed session split over chunks', () => {
    const value = `base64-${Buffer.from(session({ sub: 'user-2', email: 'b@example.com' })).toString('base64url')}`;
    const cut = Math.floor(value.length / 2);
    const cookies = [{ name: 'sb-abc-auth-token.1', value: value.slice(cut) }, { name: 'sb-abc-auth-token.0', value: value.slice(0, cut) }];
    expect(identityFromState({ cookies })).toEqual({ id: 'user-2', email: 'b@example.com' });
  });

  it('is null when there is no session or it cannot be read', () => {
    expect(identityFromState({})).toBeNull();
    expect(identityFromState({ cookies: [{ name: 'other', value: 'x' }] })).toBeNull();
    expect(identityFromState({ cookies: [{ name: 'sb-abc-auth-token', value: 'not json' }] })).toBeNull();
    expect(identityFromState({ cookies: [{ name: 'sb-abc-auth-token', value: encodeURIComponent(session({ sub: 'only-id' })) }] })).toBeNull();
  });
});
