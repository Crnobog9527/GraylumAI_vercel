"use client";

import Link from 'next/link';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  ArrowRight,
  CheckCircle2,
  Chrome,
  Gift,
  Loader2,
  Mail,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { createClient } from '@/lib/supabase';
import { isEmailVerified, sanitizeRedirectTarget } from '@/lib/auth';
import { buildAuthHref, resolveAuthAppUrl, resolveSiteName } from '@/lib/site-config';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { trpc } from '@/trpc/client';

type AuthMode = 'login' | 'signup';
type StatusTone = 'error' | 'success' | 'info';

interface AuthStatus {
  tone: StatusTone;
  message: string;
}

const heroPoints = [
  'Google 一键授权直接进入应用',
  '邮箱注册完成后必须验证邮箱',
  '所有受保护页面都按验证状态拦截',
];

function getEmailConfirmRedirect(redirectTarget: string) {
  const callbackUrl = new URL('/auth/callback', resolveAuthAppUrl());
  callbackUrl.searchParams.set('next', redirectTarget);
  return callbackUrl.toString();
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginPageFallback />}>
      <LoginPageContent />
    </Suspense>
  );
}

function LoginPageContent() {
  const searchParams = useSearchParams();
  const { data: systemSettings } = trpc.settings.getSystemSettings.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const utils = trpc.useUtils();
  const claimInvitationCode = trpc.invitation.claimInvitationCode.useMutation();
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [selectedPlan, setSelectedPlan] = useState('');
  const [pendingAction, setPendingAction] = useState<'login' | 'signup' | 'google' | null>(null);
  const [redirectTarget, setRedirectTarget] = useState('/profile');
  const [status, setStatus] = useState<AuthStatus | null>(null);

  useEffect(() => {
    const action = searchParams.get('action');
    const redirect = sanitizeRedirectTarget(searchParams.get('redirect'));
    const error = searchParams.get('error');
    const emailParam = searchParams.get('email');
    const inviteParam = searchParams.get('invite');
    const planParam = searchParams.get('plan');

    setMode(action === 'signup' ? 'signup' : 'login');
    setRedirectTarget(redirect);
    setSelectedPlan(planParam ?? '');

    if (emailParam) {
      setEmail(emailParam);
    }

    if (inviteParam) {
      setInviteCode(inviteParam);
      if (action !== 'signup') {
        setMode('signup');
      }
    }

    if (error) {
      setStatus({
        tone: 'error',
        message: decodeURIComponent(error),
      });
    }
  }, [searchParams]);

  useEffect(() => {
    const maintenanceModeEnabled =
      systemSettings?.maintenance_mode === true || systemSettings?.maintenance_mode === 'true';

    if (maintenanceModeEnabled) {
      window.location.replace('/maintenance');
    }
  }, [systemSettings]);

  const handleLogin = async () => {
    setPendingAction('login');
    setStatus(null);

    const supabase = createClient();
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      const shouldRouteToVerify = /confirm|verified|verification|email/i.test(error.message);
      if (shouldRouteToVerify) {
        window.location.assign(
          buildAuthHref(`/verify-email?email=${encodeURIComponent(email)}&redirect=${encodeURIComponent(redirectTarget)}`)
        );
        return;
      }

      setStatus({ tone: 'error', message: error.message });
      setPendingAction(null);
      return;
    }

    if (!isEmailVerified(data.user)) {
      window.location.assign(
        buildAuthHref(`/verify-email?email=${encodeURIComponent(email)}&redirect=${encodeURIComponent(redirectTarget)}`)
      );
      return;
    }

    setStatus({ tone: 'success', message: '登录成功，正在进入应用。' });
    window.location.assign(redirectTarget);
  };

  const handleSignup = async () => {
    setPendingAction('signup');
    setStatus(null);

    const trimmedInviteCode = inviteCode.trim();
    if (trimmedInviteCode) {
      try {
        await utils.invitation.validateInvitationCode.fetch({ code: trimmedInviteCode });
      } catch (error) {
        setStatus({
          tone: 'error',
          message: error instanceof Error ? error.message : '邀请码无效或已使用。',
        });
        setPendingAction(null);
        return;
      }
    }

    const supabase = createClient();
    const emailRedirectTo = getEmailConfirmRedirect(redirectTarget);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo,
        data: {
          nickname: nickname.trim() || undefined,
          display_name: nickname.trim() || undefined,
          invite_code: trimmedInviteCode || undefined,
        },
      },
    });

    if (error) {
      setStatus({ tone: 'error', message: error.message });
      setPendingAction(null);
      return;
    }

    if (trimmedInviteCode && data.user?.id && data.user.email) {
      try {
        const claimResult = await claimInvitationCode.mutateAsync({
          code: trimmedInviteCode,
          inviteeId: data.user.id,
          inviteeEmail: data.user.email,
        });

        if (claimResult.status === 'rejected') {
          setStatus({
            tone: 'info',
            message: `注册成功，但邀请码奖励未发放：${claimResult.blockReason ?? '触发邀请限制。'}`,
          });
          window.location.assign(
            buildAuthHref(`/verify-email?email=${encodeURIComponent(email)}&redirect=${encodeURIComponent(redirectTarget)}`)
          );
          return;
        }
      } catch (claimError) {
        setStatus({
          tone: 'info',
          message:
            claimError instanceof Error
              ? `注册成功，但邀请码奖励处理失败：${claimError.message}`
              : '注册成功，但邀请码奖励处理失败。',
        });
        window.location.assign(
          buildAuthHref(`/verify-email?email=${encodeURIComponent(email)}&redirect=${encodeURIComponent(redirectTarget)}`)
        );
        return;
      }
    }

    setStatus({
      tone: 'success',
      message:
        trimmedInviteCode
          ? '注册成功，邀请码奖励已记录，验证邮件已发送。请先完成邮箱验证。'
          : '注册成功，验证邮件已发送。请先完成邮箱验证。',
    });

    window.location.assign(
      buildAuthHref(`/verify-email?email=${encodeURIComponent(email)}&redirect=${encodeURIComponent(redirectTarget)}`)
    );
  };

  const handleGoogleLogin = async () => {
    setPendingAction('google');
    setStatus(null);

    const supabase = createClient();
    const redirectTo = getEmailConfirmRedirect(redirectTarget);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
      },
    });

    if (error) {
      setStatus({ tone: 'error', message: error.message });
      setPendingAction(null);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (mode === 'signup') {
      await handleSignup();
      return;
    }

    await handleLogin();
  };

  const isBusy = pendingAction !== null;
  const submitLabel = mode === 'signup' ? '创建账户' : '登录';
  const submitBusyLabel = mode === 'signup' ? '创建中...' : '登录中...';
  const siteName =
    typeof systemSettings?.site_name === 'string' && systemSettings.site_name.trim()
      ? systemSettings.site_name.trim()
      : resolveSiteName();

  return (
    <main
      className="min-h-screen px-4 py-8 sm:px-6 lg:px-8"
      style={{
        background:
          'radial-gradient(circle at top left, rgba(255,215,0,0.18), transparent 30%), radial-gradient(circle at bottom right, rgba(251,191,36,0.16), transparent 35%), #070707',
      }}
    >
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-3xl items-center justify-center">
        <section
          className="relative w-full overflow-hidden rounded-[32px] border px-5 py-6 sm:px-8 sm:py-8 lg:px-10 lg:py-10"
          style={{
            background:
              'linear-gradient(160deg, rgba(14,14,14,0.96), rgba(8,8,8,0.92))',
            borderColor: 'rgba(255,215,0,0.14)',
          }}
        >
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'linear-gradient(135deg, rgba(255,215,0,0.09), transparent 38%), linear-gradient(320deg, rgba(255,255,255,0.04), transparent 42%)',
            }}
          />

          <div className="relative space-y-8">
            <div className="space-y-4 text-center">
              <div className="mx-auto inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs uppercase tracking-[0.24em] text-[#f8d25c]">
                <Sparkles className="h-3.5 w-3.5" />
                {siteName} Access
              </div>
              <div className="space-y-3">
                <h1 className="text-4xl font-semibold leading-tight text-white sm:text-5xl">
                  一个入口，完成登录、注册与邮箱验证收口。
                </h1>
                <p className="mx-auto max-w-2xl text-sm leading-7 text-[#d0d0d0] sm:text-base">
                  Google 账户直接授权进入应用。邮箱账户必须先验证邮箱，才允许访问聊天、个人中心和受保护 API。
                </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              {heroPoints.map((item) => (
                <div
                  key={item}
                  className="rounded-2xl border p-4 text-center"
                  style={{
                    background: 'rgba(255,255,255,0.03)',
                    borderColor: 'rgba(255,255,255,0.06)',
                  }}
                >
                  <ShieldCheck className="mx-auto mb-3 h-5 w-5 text-[#f8d25c]" aria-hidden="true" />
                  <p className="text-sm leading-6 text-[#f4f4f4]">{item}</p>
                </div>
              ))}
            </div>

            <Card
              className="overflow-hidden rounded-[28px] border"
              style={{
                background: 'rgba(11,11,11,0.95)',
                borderColor: 'rgba(255,255,255,0.08)',
                boxShadow: '0 24px 70px rgba(0,0,0,0.42)',
              }}
            >
              <CardContent className="p-0">
                <div className="space-y-6 px-5 py-6 sm:px-7 sm:py-7">
                  <div className="flex rounded-2xl border p-1" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
                    <button
                      type="button"
                      onClick={() => setMode('login')}
                      className="flex-1 rounded-xl px-4 py-3 text-sm font-medium transition"
                      style={{
                        background: mode === 'login' ? 'rgba(255,215,0,0.14)' : 'transparent',
                        color: mode === 'login' ? '#fff4c1' : '#a3a3a3',
                      }}
                    >
                      登录
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode('signup')}
                      className="flex-1 rounded-xl px-4 py-3 text-sm font-medium transition"
                      style={{
                        background: mode === 'signup' ? 'rgba(255,215,0,0.14)' : 'transparent',
                        color: mode === 'signup' ? '#fff4c1' : '#a3a3a3',
                      }}
                    >
                      注册
                    </button>
                  </div>

                  <div className="space-y-2 text-center">
                    <h2 className="text-2xl font-semibold text-white">
                      {mode === 'signup' ? `创建你的 ${siteName} 账户` : `登录到 ${siteName}`}
                    </h2>
                    <p className="text-sm leading-6 text-[#a3a3a3]">
                      {mode === 'signup'
                        ? '邮箱注册完成后将收到验证邮件，验证通过后才可使用核心功能。'
                        : 'Google 登录无需再次验证邮箱，邮箱账户会按验证状态自动拦截。'}
                    </p>
                    {redirectTarget !== '/profile' && (
                      <p className="rounded-xl border px-3 py-2 text-xs text-[#c8c8c8]" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
                        登录完成后将返回 <span className="font-mono">{redirectTarget}</span>
                      </p>
                    )}
                    {mode === 'signup' && selectedPlan && (
                      <p className="rounded-xl border px-3 py-2 text-xs text-[#f6dd96]" style={{ borderColor: 'rgba(255,215,0,0.16)' }}>
                        当前来自 <span className="font-semibold">{selectedPlan}</span> 套餐入口。注册后可在产品内查看该套餐对应的最新权益与购买状态。
                      </p>
                    )}
                  </div>

                  <div className="grid gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleGoogleLogin}
                      disabled={isBusy}
                      className="h-12 justify-between rounded-2xl border-[#3a3a3a] bg-[#141414] px-4 text-white hover:bg-[#1a1a1a]"
                      aria-label="使用 Google 一键登录"
                    >
                      <span className="flex items-center gap-2">
                        {pendingAction === 'google' ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Chrome className="h-4 w-4" />
                        )}
                        使用 Google 一键登录
                      </span>
                      <ArrowRight className="h-4 w-4 opacity-70" />
                    </Button>
                    <div className="flex items-center gap-3 text-xs uppercase tracking-[0.2em] text-[#6f6f6f]">
                      <div className="h-px flex-1 bg-[#2e2e2e]" />
                      或使用邮箱
                      <div className="h-px flex-1 bg-[#2e2e2e]" />
                    </div>
                  </div>

                  <form className="space-y-4" onSubmit={handleSubmit}>
                    {mode === 'signup' && (
                      <>
                        <div className="space-y-2">
                          <Label htmlFor="nickname" className="text-[#f2f2f2]">
                            昵称
                          </Label>
                          <Input
                            id="nickname"
                            value={nickname}
                            onChange={(event) => setNickname(event.target.value)}
                            placeholder="怎么称呼你"
                            autoComplete="nickname"
                            className="h-12 rounded-2xl border-[#2d2d2d] bg-[#131313] text-white placeholder:text-[#686868]"
                          />
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="invite-code" className="text-[#f2f2f2]">
                            邀请码
                          </Label>
                          <div className="relative">
                            <Gift className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8a8a8a]" />
                            <Input
                              id="invite-code"
                              value={inviteCode}
                              onChange={(event) => setInviteCode(event.target.value)}
                              placeholder="选填，输入好友的邀请码"
                              autoComplete="off"
                              className="h-12 rounded-2xl border-[#2d2d2d] bg-[#131313] pl-11 text-white placeholder:text-[#686868]"
                            />
                          </div>
                        </div>
                      </>
                    )}

                    <div className="space-y-2">
                      <Label htmlFor="email" className="text-[#f2f2f2]">
                        邮箱
                      </Label>
                      <Input
                        id="email"
                        type="email"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        placeholder="name@example.com"
                        autoComplete="email"
                        required
                        className="h-12 rounded-2xl border-[#2d2d2d] bg-[#131313] text-white placeholder:text-[#686868]"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="password" className="text-[#f2f2f2]">
                        密码
                      </Label>
                      <Input
                        id="password"
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        placeholder={mode === 'signup' ? '至少 8 位密码' : '输入你的密码'}
                        autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                        minLength={8}
                        required
                        className="h-12 rounded-2xl border-[#2d2d2d] bg-[#131313] text-white placeholder:text-[#686868]"
                      />
                    </div>

                    {status && (
                      <div
                        className="rounded-2xl border px-4 py-3 text-sm leading-6"
                        aria-live="polite"
                        style={{
                          borderColor:
                            status.tone === 'error'
                              ? 'rgba(248,113,113,0.24)'
                              : status.tone === 'success'
                                ? 'rgba(74,222,128,0.24)'
                                : 'rgba(255,215,0,0.24)',
                          background:
                            status.tone === 'error'
                              ? 'rgba(127,29,29,0.2)'
                              : status.tone === 'success'
                                ? 'rgba(20,83,45,0.2)'
                                : 'rgba(120,53,15,0.2)',
                          color:
                            status.tone === 'error'
                              ? '#fecaca'
                              : status.tone === 'success'
                                ? '#bbf7d0'
                                : '#fde68a',
                        }}
                      >
                        <div className="flex items-start gap-2">
                          {status.tone === 'success' ? (
                            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                          ) : (
                            <Mail className="mt-0.5 h-4 w-4 shrink-0" />
                          )}
                          <span>{status.message}</span>
                        </div>
                      </div>
                    )}

                    <Button
                      type="submit"
                      disabled={isBusy}
                      className="h-12 w-full rounded-2xl bg-[#f2c94c] text-black hover:bg-[#f7d96c]"
                    >
                      {pendingAction === 'login' || pendingAction === 'signup' ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          {submitBusyLabel}
                        </>
                      ) : (
                        submitLabel
                      )}
                    </Button>
                  </form>

                  <div className="rounded-2xl border px-4 py-4 text-sm leading-6 text-[#afafaf]" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
                    <p>
                      {mode === 'signup'
                        ? '注册后系统会立即发送验证邮件。你必须点击邮件中的链接完成验证后，才能进入聊天或个人中心。'
                        : '如果你之前通过邮箱注册但尚未验证，可以直接打开验证状态页重发邮件。'}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <Link
                        href={buildAuthHref(`/verify-email?email=${encodeURIComponent(email)}&redirect=${encodeURIComponent(redirectTarget)}`)}
                        className="text-[#f2c94c] underline-offset-4 hover:underline"
                      >
                        打开验证状态页
                      </Link>
                      <button
                        type="button"
                        onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}
                        className="text-[#f2c94c] underline-offset-4 hover:underline"
                      >
                        {mode === 'signup' ? '已有账户，返回登录' : '没有账户，立即注册'}
                      </button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>
      </div>
    </main>
  );
}

function LoginPageFallback() {
  const fallbackSiteName = resolveSiteName();

  return (
    <main
      className="min-h-screen px-4 py-8 sm:px-6 lg:px-8"
      style={{
        background:
          'radial-gradient(circle at top left, rgba(255,215,0,0.18), transparent 30%), radial-gradient(circle at bottom right, rgba(251,191,36,0.16), transparent 35%), #070707',
      }}
    >
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-3xl items-center justify-center">
        <Card
          className="w-full overflow-hidden rounded-[28px] border"
          style={{
            background: 'rgba(11,11,11,0.95)',
            borderColor: 'rgba(255,255,255,0.08)',
            boxShadow: '0 24px 70px rgba(0,0,0,0.42)',
          }}
        >
          <CardContent className="space-y-6 px-6 py-8 text-center sm:px-8 sm:py-10">
            <div className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs uppercase tracking-[0.24em] text-[#f8d25c]">
              <Sparkles className="h-3.5 w-3.5" />
              {fallbackSiteName} Access
            </div>
            <div className="space-y-3">
              <h1 className="text-4xl font-semibold leading-tight text-white sm:text-5xl">
                一个入口，完成登录、注册与邮箱验证收口。
              </h1>
              <p className="mx-auto max-w-xl text-sm leading-7 text-[#d0d0d0] sm:text-base">
                正在加载认证入口。
              </p>
            </div>
            <div className="flex items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-[#f2c94c]" />
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
