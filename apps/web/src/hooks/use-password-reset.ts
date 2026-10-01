'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { buildAuthHref } from '@/lib/site-config';
import {
  changePasswordWithToken,
  classifyAccountGateError,
  classifyPasswordUpdateError,
  isFreshRecoverySession,
  isTransientAuthError,
  readAccessTokenClaims,
  recoveryTimestamp,
  validateNewPassword,
  type AccountGate,
} from '@/lib/passwordRecovery';
import { trpc } from '@/trpc/client';

// Who the form was opened for: the user and the reset (its recovery time) that unlocked it.
export type ResetGrant = { userId: string; recoveredAt: number };

export type ResetPhase =
  | { kind: 'checking' }
  // No session in this browser, or GoTrue no longer accepts it: the link has to be requested again.
  | { kind: 'no-link' }
  // Signed in some other way, another account, or the reset is too old: the form stays closed.
  | { kind: 'not-recovery' }
  // signedOut is false when signing the rejected account out of this browser did not complete.
  | { kind: 'blocked'; gate: AccountGate; signedOut: boolean }
  | { kind: 'ready'; grant: ResetGrant }
  // The password was changed but the sign-out did not complete; only the sign-out is retried.
  | { kind: 'signout-pending' };

type AuthClient = Pick<
  ReturnType<typeof createClient>['auth'],
  'getUser' | 'getSession' | 'mfa' | 'signOut' | 'onAuthStateChange'
>;

export type ResetDeps = {
  auth: AuthClient;
  // Any protected API call; it fails with FORBIDDEN for every account status but active.
  checkAccount: () => Promise<unknown>;
  nowSeconds: () => number;
  // Sends the change with exactly this access token (changePasswordWithToken).
  changePassword: (accessToken: string, password: string) => Promise<{ error: unknown }>;
};

export const PASSWORD_RESET_DONE_PATH = '/login?notice=password_reset';

// Global first, so no session from before the reset (or the reset session itself) stays usable;
// local as a fallback. auth-js keeps the local session when the server request fails (network or
// 5xx), so false means this browser may still be signed in.
export async function signOutAfterReset(auth: Pick<AuthClient, 'signOut'>): Promise<boolean> {
  for (const scope of ['global', 'local'] as const) {
    const result = await auth.signOut({ scope }).catch(error => ({ error }));
    if (!result.error) return true;
  }
  return false;
}

// The form is shown only for a fresh recovery session of an account the API still accepts. The API
// enforces account status on every protected call anyway; this check keeps the page from setting a
// password for a closed or disabled account through the normal UI. Errors never read as "no link".
export async function checkResetAccess({ auth, checkAccount, nowSeconds }: ResetDeps): Promise<ResetPhase> {
  let grant: ResetGrant;
  try {
    const { data, error } = await auth.getUser();
    if (!data.user) {
      return error && isTransientAuthError(error) ? { kind: 'blocked', gate: 'retry', signedOut: true } : { kind: 'no-link' };
    }
    const { data: level, error: levelError } = await auth.mfa.getAuthenticatorAssuranceLevel();
    if (levelError) return { kind: 'blocked', gate: 'retry', signedOut: true };
    const methods = level?.currentAuthenticationMethods;
    const recoveredAt = recoveryTimestamp(methods);
    if (recoveredAt === null || !isFreshRecoverySession(methods, nowSeconds())) return { kind: 'not-recovery' };
    grant = { userId: data.user.id, recoveredAt };
  } catch {
    return { kind: 'blocked', gate: 'retry', signedOut: true };
  }

  try {
    await checkAccount();
  } catch (error) {
    const gate = classifyAccountGateError(error);
    // Leave nothing usable behind for an account that may not be used.
    const signedOut = gate === 'unavailable' ? await signOutAfterReset(auth) : true;
    return { kind: 'blocked', gate, signedOut };
  }
  return { kind: 'ready', grant };
}

export type ResetSubmitResult =
  | { kind: 'invalid'; message: string }
  // The session no longer matches the form: show this phase instead, nothing was changed.
  | { kind: 'closed'; phase: ResetPhase }
  | { kind: 'signout-pending' }
  | { kind: 'done'; to: string };

// One submit. Auth events (also from other tabs) void it while it waits; once the password has
// changed, its own sign-out events are expected and no longer count.
export class ResetAttempt {
  voided: ResetPhase | null = null;
  signingOut = false;

  constructor(readonly grant: ResetGrant) {}

  observe(session: { user: { id: string } } | null) {
    if (this.signingOut || this.voided) return;
    if (!session) this.voided = { kind: 'no-link' };
    else if (session.user.id !== this.grant.userId) this.voided = { kind: 'not-recovery' };
  }
}

// The last check: this browser's session, read locally, must still be the reset the form was opened
// with, and nothing may have voided the attempt while it waited. Returns the checked access token,
// which the change then uses, so a later switch of the shared session cannot redirect it.
async function confirmSameReset(
  deps: ResetDeps,
  attempt: ResetAttempt,
): Promise<{ phase: ResetPhase } | { accessToken: string }> {
  const { data } = await deps.auth.getSession().catch(() => ({ data: { session: null } }));
  if (attempt.voided) return { phase: attempt.voided };
  const accessToken = data.session?.access_token;
  const claims = readAccessTokenClaims(accessToken);
  if (!accessToken || !claims) return { phase: { kind: 'no-link' } };
  const { grant } = attempt;
  const same = claims.userId === grant.userId
    && recoveryTimestamp(claims.amr) === grant.recoveredAt
    && isFreshRecoverySession(claims.amr, deps.nowSeconds());
  return same ? { accessToken } : { phase: { kind: 'not-recovery' } };
}

export async function submitNewPassword(
  deps: ResetDeps,
  attempt: ResetAttempt,
  password: string,
  confirm: string,
): Promise<ResetSubmitResult> {
  const invalid = validateNewPassword(password, confirm);
  if (invalid) return { kind: 'invalid', message: invalid };

  // The page may have been open for a while: the reset may be too old, this browser may have
  // switched to another account, or the account may have been closed since.
  const current = await checkResetAccess(deps);
  if (current.kind !== 'ready') return { kind: 'closed', phase: current };
  const { grant } = attempt;
  if (current.grant.userId !== grant.userId || current.grant.recoveredAt !== grant.recoveredAt) {
    return { kind: 'closed', phase: { kind: 'not-recovery' } };
  }
  const confirmed = await confirmSameReset(deps, attempt);
  if ('phase' in confirmed) return { kind: 'closed', phase: confirmed.phase };
  // Nothing is awaited between this check and sending the request with the checked token.
  if (attempt.voided) return { kind: 'closed', phase: attempt.voided };

  let failure;
  try {
    const { error } = await deps.changePassword(confirmed.accessToken, password);
    failure = error ? classifyPasswordUpdateError(error) : null;
  } catch (error) {
    failure = classifyPasswordUpdateError(error);
  }
  if (failure) {
    return failure.kind === 'session' ? { kind: 'closed', phase: { kind: 'no-link' } } : { kind: 'invalid', message: failure.message };
  }

  // The checked account's password changed, and GoTrue revoked its other sessions. If this browser
  // switched to another account meanwhile, that account's password was not touched; the sign-out
  // below acts on whatever session this browser holds now, so it would only sign that account out.
  attempt.signingOut = true;
  return (await signOutAfterReset(deps.auth)) ? { kind: 'done', to: PASSWORD_RESET_DONE_PATH } : { kind: 'signout-pending' };
}

export function usePasswordReset() {
  const utils = trpc.useUtils();
  const [phase, setPhase] = useState<ResetPhase>({ kind: 'checking' });
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Read by the auth listener and kept in step with the phase.
  const phaseRef = useRef<ResetPhase>(phase);
  // A sign-out retry is running; its own events are expected.
  const busyRef = useRef(false);
  const attemptRef = useRef<ResetAttempt | null>(null);

  const show = useCallback((next: ResetPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const deps = useCallback((): ResetDeps => ({
    auth: createClient().auth,
    checkAccount: () => utils.user.getUserProfile.fetch(undefined, { staleTime: 0 }),
    nowSeconds: () => Date.now() / 1000,
    changePassword: (accessToken, password) => changePasswordWithToken({
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
      anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
      accessToken,
      password,
    }),
  }), [utils]);

  const check = useCallback(async () => {
    show({ kind: 'checking' });
    show(await checkResetAccess(deps()));
  }, [deps, show]);

  useEffect(() => {
    void check();
  }, [check]);

  // A sign-out or another account's sign-in (also from another tab) closes an open form at once,
  // or voids a submit that is still waiting; submit checks again in any case.
  useEffect(() => {
    const { data } = createClient().auth.onAuthStateChange((_event, session) => {
      if (attemptRef.current) {
        attemptRef.current.observe(session);
        return;
      }
      const current = phaseRef.current;
      if (busyRef.current || current.kind !== 'ready') return;
      if (!session) show({ kind: 'no-link' });
      else if (session.user.id !== current.grant.userId) show({ kind: 'not-recovery' });
    });
    return () => data.subscription.unsubscribe();
  }, [show]);

  const finish = useCallback((signedOut: boolean) => {
    if (signedOut) {
      window.location.assign(buildAuthHref(PASSWORD_RESET_DONE_PATH));
      return;
    }
    show({ kind: 'signout-pending' });
    busyRef.current = false;
    setPending(false);
  }, [show]);

  const submit = useCallback(async (password: string, confirm: string) => {
    const current = phaseRef.current;
    if (current.kind !== 'ready' || attemptRef.current || busyRef.current) return;
    const attempt = new ResetAttempt(current.grant);
    attemptRef.current = attempt;
    setFormError(null);
    setPending(true);
    const result = await submitNewPassword(deps(), attempt, password, confirm);
    // On success the page is leaving; the finished attempt keeps absorbing its own sign-out events.
    if (result.kind === 'done') {
      finish(true);
      return;
    }
    attemptRef.current = null;
    if (result.kind === 'signout-pending') {
      finish(false);
      return;
    }
    if (result.kind === 'closed') show(result.phase);
    else setFormError(result.message);
    setPending(false);
  }, [deps, finish, show]);

  // Retries only the sign-out: after a changed password, or for a rejected account.
  const retrySignOut = useCallback(async () => {
    const current = phaseRef.current;
    if (busyRef.current) return;
    busyRef.current = true;
    setPending(true);
    const signedOut = await signOutAfterReset(createClient().auth);
    if (current.kind === 'blocked') {
      show({ ...current, signedOut });
      busyRef.current = false;
      setPending(false);
      return;
    }
    finish(signedOut);
  }, [finish, show]);

  return { phase, pending, formError, retry: check, retrySignOut, submit };
}
