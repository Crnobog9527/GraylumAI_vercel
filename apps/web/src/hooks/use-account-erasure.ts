'use client';

import { useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { createClient } from '@/lib/supabase';
import { getAuthCaptchaOptions, runAuthCaptchaAttempt } from '@/lib/authCaptcha';
import { describeErasureError, isAccountClosedError, type AccountErasurePreview } from '@/lib/account-erasure';

export type ErasureStep = 'impact' | 'verify' | 'confirm' | 'done';
const CODE_COOLDOWN_SECONDS = 60;

export function useAccountErasure(options: { email?: string; usesPassword: boolean }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<ErasureStep>('impact');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeSentAt, setCodeSentAt] = useState<number | null>(null);
  const requestId = useRef<string | null>(null);
  const preview = trpc.account.erasurePreview.useQuery(undefined, { enabled: open, staleTime: 0 });
  const confirmMutation = trpc.account.erasureConfirm.useMutation();
  const portal = trpc.payments.createCustomerPortalSession.useMutation();

  const reset = (nextOpen: boolean) => {
    setOpen(nextOpen);
    setStep('impact');
    setSecret('');
    setError(null);
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

  const sendCode = () => run(async () => {
    if (!options.email) return setError('当前会话缺少邮箱信息，无法发送验证码。');
    if (codeSentAt && Date.now() - codeSentAt < CODE_COOLDOWN_SECONDS * 1000) {
      return setError(`验证码已发送，请 ${CODE_COOLDOWN_SECONDS} 秒后再重新发送。`);
    }
    const email = options.email;
    const { error: sendError } = await runAuthCaptchaAttempt(getAuthCaptchaOptions(), (captcha) =>
      createClient().auth.signInWithOtp({ email, options: { shouldCreateUser: false, ...captcha } }));
    if (sendError) return setError('验证码发送失败，请稍后重试。');
    setCodeSentAt(Date.now());
  }).catch(() => setError('请完成人机验证后重试。'));

  const verify = () => run(async () => {
    if (!options.email || !secret.trim()) return setError(options.usesPassword ? '请输入当前密码。' : '请输入验证码。');
    const email = options.email;
    const supabase = createClient();
    const { error: verifyError } = options.usesPassword
      ? await runAuthCaptchaAttempt(getAuthCaptchaOptions(), (captcha) =>
        supabase.auth.signInWithPassword({ email, password: secret, options: captcha }))
      : await supabase.auth.verifyOtp({ email, token: secret.trim(), type: 'email' });
    if (verifyError) return setError(options.usesPassword ? '密码验证失败，请重新输入。' : '验证码无效或已过期。');
    setSecret('');
    setStep('confirm');
  }).catch(() => setError('请完成人机验证后重试。'));

  const confirm = () => run(async () => {
    try {
      await confirmMutation.mutateAsync({ requestId: requestId.current ?? crypto.randomUUID(), acknowledged: true });
    } catch (confirmError) {
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
      setError('订阅管理暂不可用，请稍后重试。');
    }
  });

  return {
    open, step, secret, busy, error, codeSent: codeSentAt !== null,
    preview: preview.data as AccountErasurePreview | undefined,
    previewLoading: preview.isLoading,
    previewFailed: Boolean(preview.error),
    setOpen: reset, setStep, setSecret, sendCode, verify, confirm, openPortal,
  };
}
