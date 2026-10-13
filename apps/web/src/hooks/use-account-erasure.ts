'use client';

import { useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { createClient } from '@/lib/supabase';
import { CAPTCHA_EXPIRED_MESSAGE, captchaOptionsFromToken } from '@/lib/dialogCaptcha';
import {
  describeErasureError, isAccountClosedError, isRenewalBlockedError, type AccountErasurePreview,
} from '@/lib/account-erasure';

export function settledPreview(query: { data?: unknown; isFetching: boolean; error: unknown }) {
  return query.isFetching || query.error ? undefined : query.data as AccountErasurePreview | undefined;
}

export type ErasureStep = 'impact' | 'verify' | 'confirm' | 'done';
const CODE_COOLDOWN_SECONDS = 60;

export function useAccountErasure(options: { email?: string; usesPassword: boolean }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<ErasureStep>('impact');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeSentAt, setCodeSentAt] = useState<number | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);
  const requestId = useRef<string | null>(null);
  const preview = trpc.account.erasurePreview.useQuery(undefined, { enabled: open, staleTime: 0 });
  const confirmMutation = trpc.account.erasureConfirm.useMutation();
  const portal = trpc.payments.createCustomerPortalSession.useMutation();

  const reset = (nextOpen: boolean) => {
    setOpen(nextOpen);
    setStep('impact');
    setSecret('');
    setError(null);
    setCaptchaToken(null);
    // One idempotency key per dialog session; a retry of the same confirm reuses it.
    requestId.current = nextOpen ? crypto.randomUUID() : null;
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

  // Single use: read the token, then drop it and remount the widget before the attempt runs.
  const takeCaptcha = () => {
    const captcha = captchaOptionsFromToken(captchaToken);
    setCaptchaToken(null);
    setCaptchaKey((key) => key + 1);
    return captcha;
  };

  const sendCode = () => run(async () => {
    if (!options.email) return setError('当前会话缺少邮箱信息，无法发送验证码。');
    if (codeSentAt && Date.now() - codeSentAt < CODE_COOLDOWN_SECONDS * 1000) {
      return setError(`验证码已发送，请 ${CODE_COOLDOWN_SECONDS} 秒后再重新发送。`);
    }
    const email = options.email;
    const captcha = takeCaptcha();
    const { error: sendError } = await createClient().auth.signInWithOtp({
      email, options: { shouldCreateUser: false, ...captcha },
    });
    if (sendError) return setError('验证码发送失败，请稍后重试。');
    setCodeSentAt(Date.now());
  }).catch(() => setError('请完成人机验证后重试。'));

  const verify = () => run(async () => {
    if (!options.email || !secret.trim()) return setError(options.usesPassword ? '请输入当前密码。' : '请输入验证码。');
    const email = options.email;
    const supabase = createClient();
    const { error: verifyError } = options.usesPassword
      ? await supabase.auth.signInWithPassword({ email, password: secret, options: takeCaptcha() })
      : await supabase.auth.verifyOtp({ email, token: secret.trim(), type: 'email' });
    if (verifyError) return setError(options.usesPassword ? '密码验证失败，请重新输入。' : '验证码无效或已过期。');
    setSecret('');
    setStep('confirm');
  }).catch(() => setError('请完成人机验证后重试。'));

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
    // Only facts from a finished, successful fetch count: a cached preview from an earlier opening must
    // not offer "继续" while the current facts are loading or after their refresh failed.
    preview: settledPreview(preview),
    previewLoading: preview.isFetching,
    previewFailed: Boolean(preview.error) && !preview.isFetching,
    captchaKey, setCaptchaToken, captchaExpired: () => setError(CAPTCHA_EXPIRED_MESSAGE),
    captchaUnavailable: () => setError('人机验证暂不可用，请稍后重试。'),
    setOpen: reset, setStep, setSecret, sendCode, verify, confirm, openPortal,
  };
}
