'use client';

import { useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { createClient } from '@/lib/supabase';
import { CAPTCHA_EXPIRED_MESSAGE, captchaOptionsFromToken } from '@/lib/dialogCaptcha';
import { describeErasureError, isAccountClosedError, type AccountErasurePreview } from '@/lib/account-erasure';
import {
  ERASURE_PROGRESS_PATH, parseProgressCredential, saveErasureHandoff, type ErasureHandoff,
} from '@/lib/erasure-progress';

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
  const [handoff, setHandoff] = useState<ErasureHandoff | null>(null);
  const [handoffStored, setHandoffStored] = useState(true);
  const confirming = useRef(false);
  const terminal = useRef(false);
  const requestId = useRef<string | null>(null);
  const preview = trpc.account.erasurePreview.useQuery(undefined, { enabled: open && step !== 'done', staleTime: 0 });
  const confirmMutation = trpc.account.erasureConfirm.useMutation({ retry: false, gcTime: 0 });
  const portal = trpc.payments.createCustomerPortalSession.useMutation();

  const reset = (nextOpen: boolean) => {
    if (confirming.current || terminal.current) return;
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

  const confirm = async () => {
    if (confirming.current || terminal.current) return;
    confirming.current = true;
    await run(async () => {
      let next: ErasureHandoff;
      try {
        requestId.current ??= crypto.randomUUID();
        const result = await confirmMutation.mutateAsync({ requestId: requestId.current, acknowledged: true });
        next = { closed: true, credential: parseProgressCredential(`${result.requestId}.${result.progressToken ?? ''}`) };
      } catch (confirmError) {
        const code = (confirmError as { data?: { code?: string } } | null)?.data?.code;
        if (!isAccountClosedError(confirmError) && code && ['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'TOO_MANY_REQUESTS'].includes(code)) {
          setError(describeErasureError(confirmError));
          return;
        }
        // A lost/ambiguous confirmation may already have closed the account. Never reissue to recover a bearer.
        next = { closed: isAccountClosedError(confirmError), credential: null };
      }
      terminal.current = true;
      setHandoffStored(saveErasureHandoff(next));
      setHandoff(next);
      confirmMutation.reset();
      setStep('done');
    }).finally(() => { confirming.current = false; });
  };

  const finish = () => run(async () => {
    if (!terminal.current) return;
    // The user has had the opportunity to copy/save before clearing the local login session.
    try {
      const result = await createClient().auth.signOut({ scope: 'local' });
      if (result.error) throw result.error;
      window.location.assign(ERASURE_PROGRESS_PATH);
    } catch { setError('未能退出本机登录，请先保存凭证，再重试退出。'); }
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
    open, step, secret, busy, error, handoff, handoffStored, codeSent: codeSentAt !== null,
    preview: preview.data as AccountErasurePreview | undefined,
    previewLoading: preview.isLoading,
    previewFailed: Boolean(preview.error),
    captchaKey, setCaptchaToken, captchaExpired: () => setError(CAPTCHA_EXPIRED_MESSAGE),
    captchaUnavailable: () => setError('人机验证暂不可用，请稍后重试。'),
    setOpen: reset, setStep, setSecret, sendCode, verify, confirm, finish, openPortal,
  };
}
