'use client';

import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { createClient } from '@/lib/supabase';
import { sendPhoneReauthCode, verifyPhoneReauth } from '@/lib/phoneReauth';
import {
  OAUTH_REAUTH_MESSAGES, OAUTH_REAUTH_PARAM, OAUTH_REAUTH_VALUE, oauthReauthRedirect, rememberOAuthReauth,
  takeOAuthReauth, withoutOAuthReauthParam,
} from '@/lib/erasureOAuthReauth';
import {
  describeErasureError, isAccountClosedError, isRenewalBlockedError, type AccountErasurePreview,
} from '@/lib/account-erasure';

/**
 * Facts count only after a read that finished successfully during this opening of the dialog: a cached
 * preview from an earlier opening must not offer "继续" while loading, paused (offline) or failed.
 */
export function settledPreview(query: {
  data?: unknown; fetchStatus: 'fetching' | 'paused' | 'idle'; error: unknown; dataUpdatedAt: number;
}, openedAt: number) {
  if (query.fetchStatus !== 'idle' || query.error || query.dataUpdatedAt < openedAt) return undefined;
  return query.data as AccountErasurePreview | undefined;
}

export type ErasureStep = 'impact' | 'verify' | 'confirm' | 'done';
const CODE_COOLDOWN_SECONDS = 60;

/**
 * How the account proves it is still its owner: an email account with its password, a phone account (PHONE-OTP) with
 * an SMS code to the number of the session, and a Google account by signing in with Google once more
 * (lib/erasureOAuthReauth.ts). Google accounts used to get an email code, but the Supabase email carries no code.
 */
export function useAccountErasure(options: { email?: string; usesPassword: boolean; phone?: boolean; userId?: string }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<ErasureStep>('impact');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeSentAt, setCodeSentAt] = useState<number | null>(null);
  const requestId = useRef<string | null>(null);
  const [openedAt, setOpenedAt] = useState(0);
  const preview = trpc.account.erasurePreview.useQuery(undefined, { enabled: open, staleTime: 0 });
  const confirmMutation = trpc.account.erasureConfirm.useMutation();
  const portal = trpc.payments.createCustomerPortalSession.useMutation();
  const resumeChecked = useRef(false);

  // Back from Google: reopen the dialog where the note left by reauthWithGoogle says it may go (once per page load).
  useEffect(() => {
    if (resumeChecked.current || !options.userId) return;
    resumeChecked.current = true;
    if (new URLSearchParams(window.location.search).get(OAUTH_REAUTH_PARAM) !== OAUTH_REAUTH_VALUE) return;
    let resume: ReturnType<typeof takeOAuthReauth> = { kind: 'none' };
    try {
      resume = takeOAuthReauth(window.sessionStorage, window.location.search, options.userId, Date.now());
    } catch {
      // Storage blocked: nothing to resume, the user starts again.
    }
    window.history.replaceState(null, '', withoutOAuthReauthParam(window.location.href));
    if (resume.kind === 'none') return;
    requestId.current = crypto.randomUUID();
    setOpenedAt(Date.now());
    setOpen(true);
    if (resume.kind === 'confirm') return setStep('confirm');
    if (resume.kind === 'expired') setStep('verify');
    setError(OAUTH_REAUTH_MESSAGES[resume.kind]);
  }, [options.userId]);

  const reset = (nextOpen: boolean) => {
    setOpen(nextOpen);
    setStep('impact');
    setSecret('');
    setError(null);
    // One idempotency key per dialog session; a retry of the same confirm reuses it.
    requestId.current = nextOpen ? crypto.randomUUID() : null;
    if (nextOpen) setOpenedAt(Date.now());
  };

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } finally {
      setBusy(false);
    }
  };

  const sendCode = () => run(async () => {
    if (codeSentAt && Date.now() - codeSentAt < CODE_COOLDOWN_SECONDS * 1000) {
      return setError(`验证码已发送，请 ${CODE_COOLDOWN_SECONDS} 秒后再重新发送。`);
    }
    const failure = await sendPhoneReauthCode(createClient());
    return failure ? setError(failure) : setCodeSentAt(Date.now());
  }).catch(() => setError('验证码没有发出去，请稍后重试。'));

  // Leaves the page for Google; the account chooser opens on this account's address. Back on the profile page the
  // effect above takes the note. The server still requires the new sign-in to be recent (accountErasure/reauth.ts).
  const reauthWithGoogle = () => run(async () => {
    if (!options.userId) return setError(OAUTH_REAUTH_MESSAGES.failed);
    rememberOAuthReauth(window.sessionStorage, options.userId, Date.now());
    const { error: oauthError } = await createClient().auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: oauthReauthRedirect(window.location.origin),
        queryParams: { prompt: 'select_account', ...(options.email ? { login_hint: options.email } : {}) },
      },
    });
    if (oauthError) setError(OAUTH_REAUTH_MESSAGES.failed);
  }).catch(() => setError(OAUTH_REAUTH_MESSAGES.failed));

  const verify = () => run(async () => {
    if (options.phone) {
      const failure = await verifyPhoneReauth(createClient(), secret);
      if (failure) return setError(failure);
      setSecret('');
      return setStep('confirm');
    }
    if (!options.usesPassword) return;
    if (!options.email || !secret.trim()) return setError('请输入当前密码。');
    const { error: verifyError } = await createClient().auth.signInWithPassword({
      email: options.email, password: secret,
    });
    if (verifyError) return setError('密码验证失败，请重新输入。');
    setSecret('');
    setStep('confirm');
  }).catch(() => setError('验证没有完成，请稍后重试。'));

  const confirm = () => run(async () => {
    try {
      await confirmMutation.mutateAsync({ requestId: requestId.current ?? crypto.randomUUID(), acknowledged: true });
    } catch (confirmError) {
      if (isRenewalBlockedError(confirmError)) {
        // Re-read the facts and go back to the impact step, where the channel-specific cancel entry is shown.
        await preview.refetch();
        setStep('impact');
        return setError(describeErasureError(confirmError));
      }
      if (!isAccountClosedError(confirmError)) return setError(describeErasureError(confirmError));
    }
    await createClient().auth.signOut({ scope: 'local' }).catch(() => undefined);
    setStep('done');
  });

  const openPortal = () => run(async () => {
    try {
      const result = await portal.mutateAsync({});
      window.location.assign(result.portalUrl);
    } catch {
      setError('订阅管理暂时打不开，请稍后重试，或联系客服帮你停止自动续费。');
    }
  });

  return {
    open, step, secret, busy, error, codeSent: codeSentAt !== null,
    preview: settledPreview(preview, openedAt),
    previewLoading: preview.fetchStatus !== 'idle',
    previewFailed: Boolean(preview.error) && !preview.isFetching,
    setOpen: reset, setStep, setSecret, sendCode, verify, reauthWithGoogle, confirm, openPortal,
  };
}
