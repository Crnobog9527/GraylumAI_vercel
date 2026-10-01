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
  useRef: (initial: unknown) => ({ current: initial }),
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => void) => { react.effects.push(fn); },
}));

type Listener = (event: string, session: { user: { id: string } } | null) => void;
const auth = vi.hoisted(() => ({
  getUser: vi.fn(),
  getSession: vi.fn(),
  mfa: { getAuthenticatorAssuranceLevel: vi.fn() },
  signOut: vi.fn(),
  updateUser: vi.fn(),
  onAuthStateChange: vi.fn(),
  listener: null as null | Listener,
}));
const fetchProfile = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({ createClient: () => ({ auth }) }));
vi.mock('@/trpc/client', () => ({ trpc: { useUtils: () => ({ user: { getUserProfile: { fetch: fetchProfile } } }) } }));
vi.mock('@/lib/site-config', () => ({ buildAuthHref: (path: string) => `https://auth.example${path}` }));

const { checkResetAccess, ResetAttempt, submitNewPassword, usePasswordReset } = await import('./use-password-reset');

const NOW = 1_800_000_000;
const clock = { now: NOW };
const user = { id: 'u1', email: 'a@example.test' };
const grant = { userId: 'u1', recoveredAt: NOW - 60 };
const methods = (...entries: { method: string; timestamp: number }[]) => ({ data: { currentAuthenticationMethods: entries }, error: null });
const forbidden = (message: string) => Object.assign(new Error(message), { data: { code: 'FORBIDDEN' } });
const failedSignOut = { error: Object.assign(new Error('x'), { status: 502 }) };
const deps = () => ({ auth: auth as never, checkAccount: fetchProfile, nowSeconds: () => clock.now });
const submit = (password = 'password-1', confirm = password, attempt = new ResetAttempt(grant)) =>
  submitNewPassword(deps(), attempt, password, confirm);
// The session this browser holds locally, as auth-js stores it: only the access token's claims matter.
const tokenFor = (sub: string, recoveredAt: number | null) => {
  const amr = recoveredAt === null ? [{ method: 'password', timestamp: NOW }] : [{ method: 'recovery', timestamp: recoveredAt }];
  return `header.${Buffer.from(JSON.stringify({ sub, amr })).toString('base64url')}.signature`;
};
const holdSession = (sub: string | null, recoveredAt: number | null = NOW - 60) => auth.getSession.mockResolvedValue({
  data: { session: sub ? { access_token: tokenFor(sub, recoveredAt), user: { id: sub } } : null }, error: null,
});
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
  clock.now = NOW;
  react.cells.length = 0;
  react.effects.length = 0;
  auth.listener = null;
  auth.getUser.mockResolvedValue({ data: { user }, error: null });
  holdSession('u1');
  auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue(methods({ method: 'recovery', timestamp: NOW - 60 }));
  auth.signOut.mockResolvedValue({ error: null });
  auth.updateUser.mockResolvedValue({ data: { user }, error: null });
  auth.onAuthStateChange.mockImplementation((listener: Listener) => {
    auth.listener = listener;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  fetchProfile.mockResolvedValue({ id: 'u1' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('checkResetAccess', () => {
  it('is ready for a fresh recovery session of a usable account, and remembers which one', async () => {
    expect(await checkResetAccess(deps())).toEqual({ kind: 'ready', grant });
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
    auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue(methods({ method: 'password', timestamp: NOW }));
    expect(await checkResetAccess(deps())).toEqual({ kind: 'not-recovery' });
    auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue(methods({ method: 'recovery', timestamp: NOW - 7200 }));
    expect(await checkResetAccess(deps())).toEqual({ kind: 'not-recovery' });
    expect(fetchProfile).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it.each(['ACCOUNT_CLOSED: 账号已注销', '账号已被禁用，请联系管理员', '账号已被封禁'])(
    'blocks an account the API rejects and signs it out (%s)',
    async message => {
      fetchProfile.mockRejectedValue(forbidden(message));
      expect(await checkResetAccess(deps())).toEqual({ kind: 'blocked', gate: 'unavailable', signedOut: true });
      expect(auth.signOut.mock.calls).toEqual([[{ scope: 'global' }]]);
    },
  );

  it('says so when a rejected account could not be signed out', async () => {
    fetchProfile.mockRejectedValue(forbidden('ACCOUNT_CLOSED: 账号已注销'));
    auth.signOut.mockResolvedValueOnce(failedSignOut).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await checkResetAccess(deps())).toEqual({ kind: 'blocked', gate: 'unavailable', signedOut: false });
    expect(auth.signOut.mock.calls).toEqual([[{ scope: 'global' }], [{ scope: 'local' }]]);
  });

  it('offers a retry, never the form or "no link", when anything cannot be read', async () => {
    const retry = { kind: 'blocked', gate: 'retry', signedOut: true };
    fetchProfile.mockRejectedValue(Object.assign(new Error('x'), { data: { code: 'INTERNAL_SERVER_ERROR' } }));
    expect(await checkResetAccess(deps())).toEqual(retry);
    expect(auth.signOut).not.toHaveBeenCalled();

    auth.getUser.mockResolvedValue({ data: { user: null }, error: Object.assign(new Error('x'), { name: 'AuthRetryableFetchError', status: 0 }) });
    expect(await checkResetAccess(deps())).toEqual(retry);
    auth.getUser.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await checkResetAccess(deps())).toEqual(retry);

    auth.getUser.mockResolvedValue({ data: { user }, error: null });
    auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({ data: null, error: new Error('x') });
    expect(await checkResetAccess(deps())).toEqual(retry);
    auth.mfa.getAuthenticatorAssuranceLevel.mockRejectedValue(new Error('x'));
    expect(await checkResetAccess(deps())).toEqual(retry);
  });
});

describe('submitNewPassword', () => {
  it('rejects an invalid form before checking anything or calling GoTrue', async () => {
    expect(await submit('short')).toEqual({ kind: 'invalid', message: '新密码至少需要 8 位字符。' });
    expect(auth.getUser).not.toHaveBeenCalled();
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('refuses once the reset has become too old while the form was open', async () => {
    clock.now = NOW + 3600;
    expect(await submit()).toEqual({ kind: 'closed', phase: { kind: 'not-recovery' } });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it.each([
    ['another account signed in normally', { id: 'u2' }, methods({ method: 'password', timestamp: NOW })],
    ['another account with its own reset', { id: 'u2' }, methods({ method: 'recovery', timestamp: NOW - 10 })],
    ['the same account with a newer reset', user, methods({ method: 'recovery', timestamp: NOW - 10 })],
  ])('refuses when this browser now holds %s', async (_, current, level) => {
    auth.getUser.mockResolvedValue({ data: { user: current }, error: null });
    auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue(level);
    expect(await submit()).toEqual({ kind: 'closed', phase: { kind: 'not-recovery' } });
    expect(auth.updateUser).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('refuses after a sign-out in another tab, and for an account closed since', async () => {
    auth.getUser.mockResolvedValueOnce({ data: { user: null }, error: Object.assign(new Error('x'), { name: 'AuthSessionMissingError', status: 400 }) });
    expect(await submit()).toEqual({ kind: 'closed', phase: { kind: 'no-link' } });
    fetchProfile.mockRejectedValue(forbidden('ACCOUNT_CLOSED: 账号已注销'));
    expect(await submit()).toEqual({ kind: 'closed', phase: { kind: 'blocked', gate: 'unavailable', signedOut: true } });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it.each([
    ['another account', () => { holdSession('u2'); }, { kind: 'not-recovery' }],
    ['a newer reset of the same account', () => { holdSession('u1', NOW - 10); }, { kind: 'not-recovery' }],
    ['a password sign-in of the same account', () => { holdSession('u1', null); }, { kind: 'not-recovery' }],
    ['no session', () => { holdSession(null); }, { kind: 'no-link' }],
    ['an unreadable session', () => { auth.getSession.mockRejectedValue(new Error('x')); }, { kind: 'no-link' }],
  ])('refuses when the local session read right before the change shows %s', async (_, arrange, phase) => {
    arrange();
    expect(await submit()).toEqual({ kind: 'closed', phase });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('refuses an attempt voided by a sign-out or another sign-in while it waited', async () => {
    const signedOut = new ResetAttempt(grant);
    signedOut.observe(null);
    expect(await submit(undefined, undefined, signedOut)).toEqual({ kind: 'closed', phase: { kind: 'no-link' } });
    const switched = new ResetAttempt(grant);
    switched.observe({ user: { id: 'u2' } });
    switched.observe({ user: { id: 'u1' } });
    expect(await submit(undefined, undefined, switched)).toEqual({ kind: 'closed', phase: { kind: 'not-recovery' } });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('shows fixed texts for update errors and sends a lost session to a new request', async () => {
    auth.updateUser.mockResolvedValue({ data: {}, error: Object.assign(new Error('raw'), { code: 'same_password', status: 422 }) });
    expect(await submit()).toEqual({ kind: 'invalid', message: '新密码不能和原来的密码相同。' });
    auth.updateUser.mockResolvedValue({ data: {}, error: Object.assign(new Error('raw'), { code: 'session_not_found', status: 403 }) });
    expect(await submit()).toEqual({ kind: 'closed', phase: { kind: 'no-link' } });
    auth.updateUser.mockRejectedValue(new Error('Internal database error'));
    expect(await submit()).toEqual({ kind: 'invalid', message: '密码重置失败，请稍后重试。' });
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('signs out everywhere after a new password', async () => {
    expect(await submit()).toEqual({ kind: 'done', to: '/login?notice=password_reset' });
    expect(auth.updateUser).toHaveBeenCalledExactlyOnceWith({ password: 'password-1' });
    expect(auth.signOut.mock.calls).toEqual([[{ scope: 'global' }]]);
  });

  it('falls back to a local sign-out when the global one fails', async () => {
    auth.signOut.mockResolvedValueOnce(failedSignOut);
    expect(await submit()).toMatchObject({ kind: 'done' });
    expect(auth.signOut.mock.calls).toEqual([[{ scope: 'global' }], [{ scope: 'local' }]]);
  });

  it.each([
    ['return errors', () => auth.signOut.mockResolvedValue(failedSignOut)],
    ['throw', () => auth.signOut.mockRejectedValue(new TypeError('Failed to fetch'))],
  ])('does not report done when both sign-outs %s', async (_, arrange) => {
    arrange();
    expect(await submit()).toEqual({ kind: 'signout-pending' });
    expect(auth.updateUser).toHaveBeenCalledOnce();
    expect(auth.signOut.mock.calls).toEqual([[{ scope: 'global' }], [{ scope: 'local' }]]);
  });
});

describe('usePasswordReset', () => {
  const assign = vi.fn();
  // Calls the hook once, runs its effects (the check and the auth listener) and waits for the check.
  const startedReset = async () => {
    vi.stubGlobal('window', { location: { assign } });
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
    expect(phase.value).toEqual({ kind: 'ready', grant });
    expect(fetchProfile).toHaveBeenCalledWith(undefined, { staleTime: 0 });
  });

  it('closes an open form when this browser signs out or switches account', async () => {
    const { phase } = await startedReset();
    auth.listener!('TOKEN_REFRESHED', { user: { id: 'u1' } });
    expect(phase.value).toEqual({ kind: 'ready', grant });
    auth.listener!('SIGNED_IN', { user: { id: 'u2' } });
    expect(phase.value).toEqual({ kind: 'not-recovery' });

    react.cells.length = 0;
    react.effects.length = 0;
    const second = await startedReset();
    auth.listener!('SIGNED_OUT', null);
    expect(second.phase.value).toEqual({ kind: 'no-link' });
  });

  it.each([
    ['another account signs in (event only, the session read still looks the same)', { user: { id: 'u2' } }, () => { /* local session unchanged */ },
      { kind: 'not-recovery' }],
    ['another account signs in (session switched, event not delivered yet)', undefined, () => { holdSession('u2'); },
      { kind: 'not-recovery' }],
    ['this browser signs out', null, () => { holdSession(null); }, { kind: 'no-link' }],
  ])('does not change any password when, while the account lookup is pending, %s', async (_, event, switchSession, closed) => {
    const { hook, phase } = await startedReset();
    const lookup = deferred();
    fetchProfile.mockImplementationOnce(() => lookup.promise);
    const submitting = hook.submit('password-1', 'password-1');
    await vi.waitFor(() => expect(fetchProfile).toHaveBeenCalledTimes(2));
    switchSession();
    if (event !== undefined) auth.listener!(event ? 'SIGNED_IN' : 'SIGNED_OUT', event);
    lookup.resolve({ id: 'u1' });
    await submitting;
    expect(auth.updateUser).not.toHaveBeenCalled();
    expect(phase.value).toEqual(closed);
    expect(assign).not.toHaveBeenCalled();
  });

  it('does not change the password after the reset expired on an open page', async () => {
    const { hook, phase } = await startedReset();
    vi.setSystemTime((NOW + 3600) * 1000);
    await hook.submit('password-1', 'password-1');
    expect(auth.updateUser).not.toHaveBeenCalled();
    expect(phase.value).toEqual({ kind: 'not-recovery' });
    expect(assign).not.toHaveBeenCalled();
  });

  it('goes to the login page after the reset, ignoring its own sign-out event', async () => {
    auth.signOut.mockImplementation(async () => {
      auth.listener!('SIGNED_OUT', null);
      return { error: null };
    });
    const { hook, phase } = await startedReset();
    await hook.submit('password-1', 'password-1');
    expect(assign).toHaveBeenCalledExactlyOnceWith('https://auth.example/login?notice=password_reset');
    expect(phase.value).toEqual({ kind: 'ready', grant });
  });

  it('keeps "password changed" apart from "signed out" and retries only the sign-out', async () => {
    const { hook, phase, pending } = await startedReset();
    auth.signOut.mockResolvedValue(failedSignOut);
    await hook.submit('password-1', 'password-1');
    expect(phase.value).toEqual({ kind: 'signout-pending' });
    expect(pending.value).toBe(false);
    expect(assign).not.toHaveBeenCalled();

    await hook.retrySignOut();
    expect(phase.value).toEqual({ kind: 'signout-pending' });
    auth.signOut.mockResolvedValue({ error: null });
    await hook.retrySignOut();
    expect(assign).toHaveBeenCalledExactlyOnceWith('https://auth.example/login?notice=password_reset');
    expect(auth.updateUser).toHaveBeenCalledOnce();
  });

  it('lets a rejected account retry its sign-out without leaving the page', async () => {
    fetchProfile.mockRejectedValue(forbidden('ACCOUNT_CLOSED: 账号已注销'));
    auth.signOut.mockResolvedValue(failedSignOut);
    const { hook, phase } = await startedReset();
    expect(phase.value).toEqual({ kind: 'blocked', gate: 'unavailable', signedOut: false });
    auth.signOut.mockResolvedValue({ error: null });
    await hook.retrySignOut();
    expect(phase.value).toEqual({ kind: 'blocked', gate: 'unavailable', signedOut: true });
    expect(assign).not.toHaveBeenCalled();
    expect(auth.updateUser).not.toHaveBeenCalled();
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
