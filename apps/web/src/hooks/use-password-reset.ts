'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { buildAuthHref } from '@/lib/site-config';
import {
  classifyAccountGateError,
  classifyPasswordUpdateError,
  isFreshRecoverySession,
  isTransientAuthError,
  validateNewPassword,
  type AccountGate,
} from '@/lib/passwordRecovery';
import { trpc } from '@/trpc/client';

export type ResetPhase =
  | { kind: 'checking' }
  // No session in this browser, or GoTrue no longer accepts it: the link has to be requested again.
  | { kind: 'no-link' }
  // Signed in some other way (or long ago): changing the password goes through the profile page.
  | { kind: 'not-recovery' }
  | { kind: 'blocked'; gate: AccountGate }
  | { kind: 'ready' };

type AuthClient = Pick<ReturnType<typeof createClient>['auth'], 'getUser' | 'mfa' | 'signOut' | 'updateUser'>;

export type ResetDeps = {
  auth: AuthClient;
  // Any protected API call; it fails with FORBIDDEN for every account status but active.
  checkAccount: () => Promise<unknown>;
  nowSeconds: () => number;
};

export const PASSWORD_RESET_DONE_PATH = '/login?notice=password_reset';

// The form is shown only for a fresh recovery session of an account the API still accepts. The API
// enforces account status on every protected call anyway; this check keeps the page from setting a
// password for a closed or disabled account through the normal UI. Errors never read as "no link".
export async function checkResetAccess({ auth, checkAccount, nowSeconds }: ResetDeps): Promise<ResetPhase> {
  try {
    const { data, error } = await auth.getUser();
    if (!data.user) {
      return error && isTransientAuthError(error) ? { kind: 'blocked', gate: 'retry' } : { kind: 'no-link' };
    }
    const { data: level, error: levelError } = await auth.mfa.getAuthenticatorAssuranceLevel();
    if (levelError) return { kind: 'blocked', gate: 'retry' };
    if (!isFreshRecoverySession(level?.currentAuthenticationMethods, nowSeconds())) return { kind: 'not-recovery' };
  } catch {
    return { kind: 'blocked', gate: 'retry' };
  }

  try {
    await checkAccount();
  } catch (error) {
    const gate = classifyAccountGateError(error);
    // Leave nothing usable behind for an account that may not be used.
    if (gate === 'unavailable') await auth.signOut({ scope: 'local' }).catch(() => undefined);
    return { kind: 'blocked', gate };
  }
  return { kind: 'ready' };
}

export type ResetSubmitResult =
  | { kind: 'invalid'; message: string }
  | { kind: 'session' }
  | { kind: 'done'; to: string };

export async function submitNewPassword(auth: AuthClient, password: string, confirm: string): Promise<ResetSubmitResult> {
  const invalid = validateNewPassword(password, confirm);
  if (invalid) return { kind: 'invalid', message: invalid };

  let failure;
  try {
    const { error } = await auth.updateUser({ password });
    failure = error ? classifyPasswordUpdateError(error) : null;
  } catch (error) {
    failure = classifyPasswordUpdateError(error);
  }
  if (failure) return failure.kind === 'session' ? failure : { kind: 'invalid', message: failure.message };

  // Sign out everywhere, this browser included, so the next sign-in uses the new password and
  // no session from before the reset (or the reset session itself) stays usable.
  const global = await auth.signOut({ scope: 'global' }).catch(error => ({ error }));
  if (global.error) await auth.signOut({ scope: 'local' }).catch(() => undefined);
  return { kind: 'done', to: PASSWORD_RESET_DONE_PATH };
}

export function usePasswordReset() {
  const utils = trpc.useUtils();
  const [phase, setPhase] = useState<ResetPhase>({ kind: 'checking' });
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setPhase({ kind: 'checking' });
    setPhase(await checkResetAccess({
      auth: createClient().auth,
      checkAccount: () => utils.user.getUserProfile.fetch(undefined, { staleTime: 0 }),
      nowSeconds: () => Date.now() / 1000,
    }));
  }, [utils]);

  useEffect(() => {
    void check();
  }, [check]);

  const submit = useCallback(async (password: string, confirm: string) => {
    setFormError(null);
    setPending(true);
    const result = await submitNewPassword(createClient().auth, password, confirm);
    if (result.kind === 'done') {
      window.location.assign(buildAuthHref(result.to));
      return;
    }
    if (result.kind === 'session') setPhase({ kind: 'no-link' });
    else setFormError(result.message);
    setPending(false);
  }, []);

  return { phase, pending, formError, retry: check, submit };
}
