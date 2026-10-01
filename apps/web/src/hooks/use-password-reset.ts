'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { buildAuthHref } from '@/lib/site-config';
import {
  classifyAccountGateError,
  classifyPasswordUpdateError,
  isFreshRecoverySession,
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

// The form is shown only for a fresh recovery session of an account the API still accepts. The API
// enforces account status on every protected call anyway; this check keeps the page from setting a
// password for a closed or disabled account through the normal UI.
export function usePasswordReset() {
  const utils = trpc.useUtils();
  const [phase, setPhase] = useState<ResetPhase>({ kind: 'checking' });
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setPhase({ kind: 'checking' });
    const supabase = createClient();
    const { data } = await supabase.auth.getUser();
    if (!data.user) {
      setPhase({ kind: 'no-link' });
      return;
    }
    const { data: level } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (!isFreshRecoverySession(level?.currentAuthenticationMethods, Date.now() / 1000)) {
      setPhase({ kind: 'not-recovery' });
      return;
    }
    try {
      await utils.user.getUserProfile.fetch(undefined, { staleTime: 0 });
    } catch (error) {
      const gate = classifyAccountGateError(error);
      // Leave nothing usable behind for an account that may not be used.
      if (gate === 'unavailable') await supabase.auth.signOut({ scope: 'local' });
      setPhase({ kind: 'blocked', gate });
      return;
    }
    setPhase({ kind: 'ready' });
  }, [utils]);

  useEffect(() => {
    void check();
  }, [check]);

  const submit = useCallback(async (password: string, confirm: string) => {
    const invalid = validateNewPassword(password, confirm);
    setFormError(invalid);
    if (invalid) return;

    setPending(true);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      const failure = classifyPasswordUpdateError(error);
      if (failure.kind === 'session') setPhase({ kind: 'no-link' });
      else setFormError(failure.message);
      setPending(false);
      return;
    }

    // Sign out everywhere, this browser included, so the next sign-in uses the new password and
    // no session from before the reset (or the reset session itself) stays usable.
    const { error: signOutError } = await supabase.auth.signOut({ scope: 'global' });
    if (signOutError) await supabase.auth.signOut({ scope: 'local' });
    window.location.assign(buildAuthHref('/login?notice=password_reset'));
  }, []);

  return { phase, pending, formError, retry: check, submit };
}
