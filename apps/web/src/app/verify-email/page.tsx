"use client";

import { Suspense, useEffect, useState } from 'react';
import Script from 'next/script';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle2, Loader2, LogOut, MailCheck, RefreshCw } from 'lucide-react';
import { createClient } from '@/lib/supabase';
import { getSafeErrorMessage } from '@/lib/safe-error-message';
import { isEmailVerified, sanitizeRedirectTarget } from '@/lib/auth';
import { buildAuthHref, resolveAuthAppUrl } from '@/lib/site-config';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  getAuthCaptchaOptions,
  getAuthCaptchaSiteKey,
  HCAPTCHA_SCRIPT_SRC,
  runAuthCaptchaAttempt,
} from '@/lib/authCaptcha';

type VerifyTone = 'info' | 'success' | 'error';

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<VerifyEmailFallback />}>
      <VerifyEmailPageContent />
    </Suspense>
  );
}

function VerifyEmailPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [redirectTarget, setRedirectTarget] = useState('/profile');
  const [checking, setChecking] = useState(true);
  const [resending, setResending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [message, setMessage] = useState<{ tone: VerifyTone; text: string }>({
    tone: 'info',
    text: '我们正在确认你的邮箱验证状态。',
  });

  useEffect(() => {
    const boot = async () => {
      const nextEmail = searchParams.get('email') ?? '';
      const nextRedirect = sanitizeRedirectTarget(searchParams.get('redirect'));

      setEmail(nextEmail);
      setRedirectTarget(nextRedirect);

      const supabase = createClient();
      const { data } = await supabase.auth.getUser();

      if (data.user?.email) {
        setEmail(data.user.email);
      }

      if (isEmailVerified(data.user)) {
        router.replace(nextRedirect);
        return;
      }

      setChecking(false);
      setMessage({
        tone: 'info',
        text: '邮箱账户必须完成验证后，才能进入聊天、个人中心和其他受保护功能。',
      });
    };

    boot();
  }, [router, searchParams]);

  const handleRefreshStatus = async () => {
    setRefreshing(true);
    setMessage({
      tone: 'info',
      text: '正在重新检查邮箱验证状态。',
    });

    const supabase = createClient();
    const { data } = await supabase.auth.getUser();

    if (data.user?.email) {
      setEmail(data.user.email);
    }

    if (isEmailVerified(data.user)) {
      setMessage({
        tone: 'success',
        text: '邮箱已验证，正在进入应用。',
      });
      router.replace(redirectTarget);
      return;
    }

    setMessage({
      tone: 'info',
      text: '还没有检测到验证完成。请点击邮件中的确认链接，然后再刷新状态。',
    });
    setRefreshing(false);
  };

  const handleResend = async () => {
    if (!email) {
      setMessage({
        tone: 'error',
        text: '当前没有可用邮箱地址，请返回登录页重新发起注册。',
      });
      return;
    }

    setResending(true);
    const supabase = createClient();
    let captchaOptions: ReturnType<typeof getAuthCaptchaOptions>;
    try {
      captchaOptions = getAuthCaptchaOptions();
    } catch (error) {
      setMessage({ tone: 'error', text: getSafeErrorMessage(error, '请完成人机验证后重试。') });
      setResending(false);
      return;
    }

    const emailRedirectTo = new URL('/auth/callback', resolveAuthAppUrl());
    emailRedirectTo.searchParams.set('next', redirectTarget);

    const { error } = await runAuthCaptchaAttempt(captchaOptions, (options) =>
      supabase.auth.resend({
        type: 'signup',
        email,
        options: {
          emailRedirectTo: emailRedirectTo.toString(),
          ...options,
        },
      }),
    );

    if (error) {
      setMessage({
        tone: 'error',
        text: getSafeErrorMessage(error, '验证邮件发送失败，请稍后重试。'),
      });
      setResending(false);
      return;
    }

    setMessage({
      tone: 'success',
      text: '验证邮件已重新发送，请检查收件箱和垃圾邮件文件夹。',
    });
    setResending(false);
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace(buildAuthHref(`/login?email=${encodeURIComponent(email)}`));
  };

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#070707] px-4">
        <Loader2 className="h-8 w-8 animate-spin text-[#f2c94c]" />
      </div>
    );
  }

  const captchaSiteKey = getAuthCaptchaSiteKey();

  return (
    <main className="min-h-screen bg-[#070707] px-4 py-6 sm:px-6">
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-3xl items-center justify-center">
        <Card
          className="w-full rounded-[28px] border"
          style={{
            background: 'linear-gradient(180deg, rgba(16,16,16,0.96), rgba(10,10,10,0.96))',
            borderColor: 'rgba(255,255,255,0.08)',
          }}
        >
          <CardContent className="space-y-6 px-6 py-7 sm:px-8">
            <div className="space-y-4 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-[rgba(242,201,76,0.12)] text-[#f2c94c]">
                <MailCheck className="h-8 w-8" aria-hidden="true" />
              </div>
              <div className="space-y-2">
                <h1 className="text-3xl font-semibold text-white">检查你的邮箱</h1>
                <p className="mx-auto max-w-xl text-sm leading-7 text-[#b5b5b5] sm:text-base">
                  邮箱注册账户在完成验证前不可访问核心业务。验证成功后，你会自动进入原本要访问的页面。
                </p>
              </div>
            </div>

            <div className="rounded-2xl border px-4 py-4 text-sm text-[#f3f3f3]" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
              <div className="flex items-center justify-between gap-4">
                <span className="text-[#a8a8a8]">当前邮箱</span>
                <span className="break-all text-right">{email || '未提供'}</span>
              </div>
            </div>

            <div
              className="rounded-2xl border px-4 py-4 text-sm leading-6"
              aria-live="polite"
              style={{
                borderColor:
                  message.tone === 'error'
                    ? 'rgba(248,113,113,0.24)'
                    : message.tone === 'success'
                      ? 'rgba(74,222,128,0.24)'
                      : 'rgba(255,215,0,0.24)',
                background:
                  message.tone === 'error'
                    ? 'rgba(127,29,29,0.18)'
                    : message.tone === 'success'
                      ? 'rgba(20,83,45,0.18)'
                      : 'rgba(120,53,15,0.18)',
                color:
                  message.tone === 'error'
                    ? '#fecaca'
                    : message.tone === 'success'
                      ? '#bbf7d0'
                      : '#fde68a',
              }}
            >
              <div className="flex items-start gap-2">
                {message.tone === 'success' ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                ) : (
                  <MailCheck className="mt-0.5 h-4 w-4 shrink-0" />
                )}
                <span>{message.text}</span>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {captchaSiteKey ? (
                <>
                  <Script src={HCAPTCHA_SCRIPT_SRC} strategy="afterInteractive" />
                  <div className="h-captcha sm:col-span-2" data-sitekey={captchaSiteKey} />
                </>
              ) : null}
              <Button
                type="button"
                onClick={handleRefreshStatus}
                disabled={refreshing || signingOut}
                className="h-11 rounded-2xl bg-[#f2c94c] text-black hover:bg-[#f7d96c]"
              >
                {refreshing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    检查中...
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4" />
                    刷新验证状态
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleResend}
                disabled={resending || signingOut}
                className="h-11 rounded-2xl border-[#333] bg-transparent text-white hover:bg-[#171717]"
              >
                {resending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    发送中...
                  </>
                ) : (
                  '重新发送验证邮件'
                )}
              </Button>
            </div>

            <div className="flex flex-col gap-3 rounded-2xl border px-4 py-4 text-sm text-[#b4b4b4] sm:flex-row sm:items-center sm:justify-between" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
              <div>
                验证成功后将进入 <span className="font-mono text-[#f2f2f2]">{redirectTarget}</span>
              </div>
              <div className="flex items-center gap-3">
                <Link href={buildAuthHref(`/login?email=${encodeURIComponent(email)}`)} className="text-[#f2c94c] underline-offset-4 hover:underline">
                  返回登录页
                </Link>
                <button
                  type="button"
                  onClick={handleSignOut}
                  disabled={signingOut}
                  className="inline-flex items-center gap-1 text-[#f2c94c] underline-offset-4 hover:underline"
                >
                  {signingOut ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <LogOut className="h-4 w-4" />
                  )}
                  退出当前会话
                </button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

function VerifyEmailFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#070707] px-4">
      <Loader2 className="h-8 w-8 animate-spin text-[#f2c94c]" />
    </div>
  );
}
