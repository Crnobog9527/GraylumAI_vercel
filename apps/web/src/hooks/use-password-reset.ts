'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { buildAuthHref } from '@/lib/site-config';
import {
  classifyAccountGateError,
  classifyPasswordUpdateError,
  isFreshRecoverySession,
  isTransientAuthError,
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
  'getUser' | 'mfa' | 'signOut' | 'updateUser' | 'onAuthStateChange'
>;

export type ResetDeps = {
  auth: AuthClient;
  // Any protected API call; it fails with FORBIDDEN for every account status but active.
  checkAccount: () => Promise<unknown>;
  nowSeconds: () => number;
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

export async function submitNewPassword(
  deps: ResetDeps,
  grant: ResetGrant,
  password: string,
  confirm: string,
): Promise<ResetSubmitResult> {
  const invalid = validateNewPassword(password, confirm);
  if (invalid) return { kind: 'invalid', message: invalid };

  // The page may have been open for a while: the reset may be too old, this browser may have
  // switched to another account, or the account may have been closed since.
  const current = await checkResetAccess(deps);
  if (current.kind !== 'ready') return { kind: 'closed', phase: current };
  if (current.grant.userId !== grant.userId || current.grant.recoveredAt !== grant.recoveredAt) {
    return { kind: 'closed', phase: { kind: 'not-recovery' } };
  }

  let failure;
  try {
    const { error } = await deps.auth.updateUser({ password });
    failure = error ? classifyPasswordUpdateError(error) : null;
  } catch (error) {
    failure = classifyPasswordUpdateError(error);
  }
  if (failure) {
    return failure.kind === 'session' ? { kind: 'closed', phase: { kind: 'no-link' } } : { kind: 'invalid', message: failure.message };
  }

  return (await signOutAfterReset(deps.auth)) ? { kind: 'done', to: PASSWORD_RESET_DONE_PATH } : { kind: 'signout-pending' };
}

export function usePasswordReset() {
  const utils = trpc.useUtils();
  const [phase, setPhase] = useState<ResetPhase>({ kind: 'checking' });
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Read by the auth listener and kept in step with the phase.
  const phaseRef = useRef<ResetPhase>(phase);
  const busyRef = useRef(false);

  const show = useCallback((next: ResetPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const deps = useCallback((): ResetDeps => ({
    auth: createClient().auth,
    checkAccount: () => utils.user.getUserProfile.fetch(undefined, { staleTime: 0 }),
    nowSeconds: () => Date.now() / 1000,
  }), [utils]);

  const check = useCallback(async () => {
    show({ kind: 'checking' });
    show(await checkResetAccess(deps()));
  }, [deps, show]);

  useEffect(() => {
    void check();
  }, [check]);

  // A sign-out or another account's sign-in (also from another tab) closes an open form at once;
  // submit checks again in any case.
  useEffect(() => {
    const { data } = createClient().auth.onAuthStateChange((_event, session) => {
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
    if (current.kind !== 'ready' || busyRef.current) return;
    busyRef.current = true;
    setFormError(null);
    setPending(true);
    const result = await submitNewPassword(deps(), current.grant, password, confirm);
    if (result.kind === 'done' || result.kind === 'signout-pending') {
      finish(result.kind === 'done');
      return;
    }
    if (result.kind === 'closed') show(result.phase);
    else setFormError(result.message);
    busyRef.current = false;
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
