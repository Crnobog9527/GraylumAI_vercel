"use client";

import Link from 'next/link';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { KeyRound, Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase';
import { getSafeErrorMessage } from '@/lib/safe-error-message';
import { invisibleCaptchaOptions } from '@/lib/invisibleCaptcha';
import { resolveAuthAppUrl } from '@/lib/site-config';
import { clearAuthFragment } from '@/lib/authFlow';
import {
  buildRecoveryRedirectUrl,
  recoveryFailureNotice,
  resetRequestOutcome,
} from '@/lib/passwordRecovery';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthStatusBanner, type AuthStatus } from '@/components/auth/AuthStatusBanner';
import {
  AUTH_INPUT_CLASS,
  AUTH_LINK_CLASS,
  AUTH_PRIMARY_BUTTON_CLASS,
  AuthPageCard,
  AuthPageLoading,
} from '@/components/auth/AuthPageCard';

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={<AuthPageLoading />}>
      <ForgotPasswordContent />
    </Suspense>
  );
}

function ForgotPasswordContent() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [status, setStatus] = useState<AuthStatus | null>(null);

  useEffect(() => {
    // A failed reset link arrives with GoTrue's #error=…&error_description=… still attached.
    clearAuthFragment(window);
    setStatus(recoveryFailureNotice(searchParams.get('reason')));
  }, [searchParams]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown(value => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const address = email.trim();
    if (!address) {
      setStatus({ tone: 'error', message: '请填写注册时使用的邮箱。' });
      return;
    }

    setPending(true);
    setStatus(null);
    let captchaOptions: Awaited<ReturnType<typeof invisibleCaptchaOptions>>;
    try {
      captchaOptions = await invisibleCaptchaOptions();
    } catch (error) {
      setStatus({ tone: 'error', message: getSafeErrorMessage(error, '人机验证未完成，请重试。') });
      setPending(false);
      return;
    }

    let error: unknown;
    try {
      ({ error } = await createClient().auth.resetPasswordForEmail(address, {
        redirectTo: buildRecoveryRedirectUrl(resolveAuthAppUrl(window.location.origin)),
        ...captchaOptions,
      }));
    } catch (thrown) {
      error = thrown;
    }
    // One outcome for the whole page state, so a registered and an unknown email end up identical.
    const outcome = resetRequestOutcome(error);
    setPending(false);
    setStatus({ tone: outcome.tone, message: outcome.message });
    setCooldown(outcome.cooldownSeconds);
  };

  return (
    <AuthPageCard
      icon={KeyRound}
      title="重置密码"
      description="填写注册时使用的邮箱，我们会发送一封重置密码的邮件。通过邮件中的链接设置新密码后，用新密码登录。"
    >
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className="space-y-2">
          <Label htmlFor="email" className="text-[#f2f2f2]">
            邮箱
          </Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={event => setEmail(event.target.value)}
            placeholder="name@example.com"
            autoComplete="email"
            required
            className={AUTH_INPUT_CLASS}
          />
        </div>

        {status && <AuthStatusBanner status={status} />}

        <Button type="submit" disabled={pending || cooldown > 0} className={AUTH_PRIMARY_BUTTON_CLASS}>
          {pending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              发送中...
            </>
          ) : cooldown > 0 ? (
            `${cooldown} 秒后可重新发送`
          ) : (
            '发送重置邮件'
          )}
        </Button>
      </form>

      <div
        className="rounded-2xl border px-4 py-4 text-sm leading-6 text-[#afafaf]"
        style={{ borderColor: 'rgba(255,255,255,0.08)' }}
      >
        <p>如果你一直用 Google 登录，直接在登录页点 Google 登录即可，不需要重置密码。</p>
        <div className="mt-3">
          <Link href="/login" className={AUTH_LINK_CLASS}>
            返回登录
          </Link>
        </div>
      </div>
    </AuthPageCard>
  );
}
