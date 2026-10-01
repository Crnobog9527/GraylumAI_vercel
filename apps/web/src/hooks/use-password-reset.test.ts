import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No DOM renderer in this package: React is stubbed so the hook runs as a plain function, with
// state cells the test can read and effects it runs by hand.
const react = vi.hoisted(() => ({ cells: [] as { value: unknown }[], effects: [] as (() => void)[] }));
vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const cell = { value: initial };
    react.cells.push(cell);
    return [cell.value, (next: unknown) => { cell.value = next; }];
  },
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => void) => { react.effects.push(fn); },
}));

const auth = vi.hoisted(() => ({
  getUser: vi.fn(),
  mfa: { getAuthenticatorAssuranceLevel: vi.fn() },
  signOut: vi.fn(),
  updateUser: vi.fn(),
}));
const fetchProfile = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({ createClient: () => ({ auth }) }));
vi.mock('@/trpc/client', () => ({ trpc: { useUtils: () => ({ user: { getUserProfile: { fetch: fetchProfile } } }) } }));
vi.mock('@/lib/site-config', () => ({ buildAuthHref: (path: string) => `https://auth.example${path}` }));

const { checkResetAccess, submitNewPassword, usePasswordReset } = await import('./use-password-reset');

const NOW = 1_800_000_000;
const user = { id: 'u1', email: 'a@example.test' };
const recovery = { data: { currentAuthenticationMethods: [{ method: 'recovery', timestamp: NOW - 60 }] }, error: null };
const forbidden = (message: string) => Object.assign(new Error(message), { data: { code: 'FORBIDDEN' } });
const deps = () => ({ auth: auth as never, checkAccount: fetchProfile, nowSeconds: () => NOW });

beforeEach(() => {
  vi.clearAllMocks();
  react.cells.length = 0;
  react.effects.length = 0;
  auth.getUser.mockResolvedValue({ data: { user }, error: null });
  auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue(recovery);
  auth.signOut.mockResolvedValue({ error: null });
  auth.updateUser.mockResolvedValue({ data: { user }, error: null });
  fetchProfile.mockResolvedValue({ id: 'u1' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkResetAccess', () => {
  it('is ready for a fresh recovery session of a usable account', async () => {
    expect(await checkResetAccess(deps())).toEqual({ kind: 'ready' });
    expect(fetchProfile).toHaveBeenCalledOnce();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('sends a visitor without a session to a new request', async () => {
    auth.getUser.mockResolvedValue({
      data: { user: null }, error: Object.assign(new Error('Auth session missing!'), { name: 'AuthSessionMissingError', status: 400 }),
    });
    expect(await checkResetAccess(deps())).toEqual({ kind: 'no-link' });
    auth.getUser.mockResolvedValue({ data: { user: null }, error: Object.assign(new Error('x'), { code: 'session_not_found', status: 403 }) });
    expect(await checkResetAccess(deps())).toEqual({ kind: 'no-link' });
    expect(fetchProfile).not.toHaveBeenCalled();
  });

  it('keeps a password session (or an old reset) off the form without signing it out', async () => {
    auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentAuthenticationMethods: [{ method: 'password', timestamp: NOW }] }, error: null,
    });
    expect(await checkResetAccess(deps())).toEqual({ kind: 'not-recovery' });
    auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentAuthenticationMethods: [{ method: 'recovery', timestamp: NOW - 7200 }] }, error: null,
    });
    expect(await checkResetAccess(deps())).toEqual({ kind: 'not-recovery' });
    expect(fetchProfile).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it.each(['ACCOUNT_CLOSED: 账号已注销', '账号已被禁用，请联系管理员', '账号已被封禁'])(
    'blocks an account the API rejects and signs this browser out (%s)',
    async message => {
      fetchProfile.mockRejectedValue(forbidden(message));
      expect(await checkResetAccess(deps())).toEqual({ kind: 'blocked', gate: 'unavailable' });
      expect(auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
    },
  );

  it('offers a retry, never the form or "no link", when anything cannot be read', async () => {
    fetchProfile.mockRejectedValue(Object.assign(new Error('x'), { data: { code: 'INTERNAL_SERVER_ERROR' } }));
    expect(await checkResetAccess(deps())).toEqual({ kind: 'blocked', gate: 'retry' });
    expect(auth.signOut).not.toHaveBeenCalled();

    auth.getUser.mockResolvedValue({ data: { user: null }, error: Object.assign(new Error('x'), { name: 'AuthRetryableFetchError', status: 0 }) });
    expect(await checkResetAccess(deps())).toEqual({ kind: 'blocked', gate: 'retry' });
    auth.getUser.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await checkResetAccess(deps())).toEqual({ kind: 'blocked', gate: 'retry' });

    auth.getUser.mockResolvedValue({ data: { user }, error: null });
    auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({ data: null, error: new Error('x') });
    expect(await checkResetAccess(deps())).toEqual({ kind: 'blocked', gate: 'retry' });
    auth.mfa.getAuthenticatorAssuranceLevel.mockRejectedValue(new Error('x'));
    expect(await checkResetAccess(deps())).toEqual({ kind: 'blocked', gate: 'retry' });
  });
});

describe('submitNewPassword', () => {
  it('rejects an invalid form before calling GoTrue', async () => {
    expect(await submitNewPassword(auth as never, 'short', 'short')).toEqual({ kind: 'invalid', message: '新密码至少需要 8 位字符。' });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('shows fixed texts for update errors and sends a lost session to a new request', async () => {
    auth.updateUser.mockResolvedValue({ data: {}, error: Object.assign(new Error('raw'), { code: 'same_password', status: 422 }) });
    expect(await submitNewPassword(auth as never, 'password-1', 'password-1'))
      .toEqual({ kind: 'invalid', message: '新密码不能和原来的密码相同。' });
    auth.updateUser.mockResolvedValue({ data: {}, error: Object.assign(new Error('raw'), { code: 'session_not_found', status: 403 }) });
    expect(await submitNewPassword(auth as never, 'password-1', 'password-1')).toEqual({ kind: 'session' });
    auth.updateUser.mockRejectedValue(new Error('Internal database error'));
    expect(await submitNewPassword(auth as never, 'password-1', 'password-1'))
      .toEqual({ kind: 'invalid', message: '密码重置失败，请稍后重试。' });
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('signs out everywhere after a new password', async () => {
    expect(await submitNewPassword(auth as never, 'password-1', 'password-1')).toEqual({ kind: 'done', to: '/login?notice=password_reset' });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: 'password-1' });
    expect(auth.signOut.mock.calls).toEqual([[{ scope: 'global' }]]);
  });

  it.each([
    ['returns an error', () => auth.signOut.mockResolvedValueOnce({ error: new Error('x') })],
    ['throws', () => auth.signOut.mockRejectedValueOnce(new Error('x'))],
  ])('falls back to a local sign-out when the global one %s', async (_, arrange) => {
    arrange();
    expect(await submitNewPassword(auth as never, 'password-1', 'password-1')).toMatchObject({ kind: 'done' });
    expect(auth.signOut.mock.calls).toEqual([[{ scope: 'global' }], [{ scope: 'local' }]]);
  });
});

describe('usePasswordReset', () => {
  const assign = vi.fn();
  // Calls the hook once, runs its mount effect and waits for the check to finish.
  const startedReset = async () => {
    vi.stubGlobal('window', { location: { assign } });
    // The hook reads the real clock.
    auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentAuthenticationMethods: [{ method: 'recovery', timestamp: Math.floor(Date.now() / 1000) - 60 }] }, error: null,
    });
    // React is stubbed above, so the hook runs as a plain function outside a component.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const hook = usePasswordReset();
    const [phase, pending, formError] = react.cells;
    react.effects.forEach(effect => effect());
    await vi.waitFor(() => expect(phase.value).not.toEqual({ kind: 'checking' }));
    return { hook, phase, pending, formError };
  };

  it('checks the account with a fresh API read and opens the form', async () => {
    const { phase } = await startedReset();
    expect(phase.value).toEqual({ kind: 'ready' });
    expect(fetchProfile).toHaveBeenCalledWith(undefined, { staleTime: 0 });
  });

  it('shows the blocked state and signs out for a closed account', async () => {
    fetchProfile.mockRejectedValue(forbidden('ACCOUNT_CLOSED: 账号已注销'));
    const { phase } = await startedReset();
    expect(phase.value).toEqual({ kind: 'blocked', gate: 'unavailable' });
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('goes to the login page after the reset, also when the global sign-out fails', async () => {
    auth.signOut.mockResolvedValueOnce({ error: new Error('x') });
    const { hook, pending } = await startedReset();
    await hook.submit('password-1', 'password-1');
    expect(auth.signOut.mock.calls).toEqual([[{ scope: 'global' }], [{ scope: 'local' }]]);
    expect(assign).toHaveBeenCalledExactlyOnceWith('https://auth.example/login?notice=password_reset');
    expect(pending.value).toBe(true);
  });

  it('keeps the form with a message, or drops to "no link", without navigating', async () => {
    const { hook, phase, pending, formError } = await startedReset();
    await hook.submit('password-1', 'password-2');
    expect(formError.value).toBe('两次输入的新密码不一致。');
    expect(pending.value).toBe(false);
    auth.updateUser.mockResolvedValue({ data: {}, error: Object.assign(new Error('raw'), { status: 401 }) });
    await hook.submit('password-1', 'password-1');
    expect(phase.value).toEqual({ kind: 'no-link' });
    expect(assign).not.toHaveBeenCalled();
  });
});
