"use client";

import Link from 'next/link';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowRight, Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase';
import { getSafeErrorMessage } from '@/lib/safe-error-message';
import {
  buildAuthCallbackUrl, buildVerifyEmailPath, classifyLoginError, EMAIL_VERIFIED_LOGIN_MESSAGE,
  LOGIN_ERROR_MESSAGES, loginErrorMessage, readAuthFragment, type AuthCallbackFlow,
} from '@/lib/authFlow';
import { isEmailVerified, sanitizeRedirectTarget } from '@/lib/auth';
import { buildAuthHref, resolveAuthAppUrl, resolveSiteName } from '@/lib/site-config';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { trpc } from '@/trpc/client';
import { invisibleCaptchaOptions } from '@/lib/invisibleCaptcha';
import { AuthStatusBanner, type AuthStatus } from '@/components/auth/AuthStatusBanner';
import { AuthRedirectNotice } from '@/components/auth/AuthRedirectNotice';
import {
  AUTH_INPUT_CLASS, AUTH_LABEL_CLASS, AUTH_LINK_CLASS, AUTH_PRIMARY_BUTTON_CLASS, AUTH_SECONDARY_BUTTON_CLASS, AuthCard, AuthDivider, AuthHead,
  AuthLoading, AuthPanel, AuthSegment, AuthShell,
} from '@/components/auth/AuthShell';
import { GoogleIcon } from '@/components/auth/GoogleIcon';
import { AuthMethodTabs, PhoneSignIn, type AuthMethod } from '@/components/auth/PhoneSignIn';
import { phoneSignInAllowed } from '@/lib/phoneAuth';
import { FORGOT_PASSWORD_PATH, PASSWORD_RESET_DONE_MESSAGE } from '@/lib/passwordRecovery';
import { clearPendingEmail, rememberPendingEmail, restorePendingEmail } from '@/lib/pendingAuthEmail';
import { useHydrated } from '@/hooks/use-hydrated';

type AuthMode = 'login' | 'signup';

const heroPoints = [
  'Google 一键授权直接进入应用',
  '邮箱注册完成后必须验证邮箱',
  '所有受保护页面都按验证状态拦截',
];

function getEmailConfirmRedirect(redirectTarget: string, flow: AuthCallbackFlow = 'email') {
  return buildAuthCallbackUrl(resolveAuthAppUrl(window.location.origin), redirectTarget, flow);
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginPageFallback />}>
      <LoginPageContent />
    </Suspense>
  );
}

export function LoginPageContent() {
  const searchParams = useSearchParams();
  const { data: systemSettings } = trpc.settings.getSystemSettings.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const hydrated = useHydrated();
  const [mode, setMode] = useState<AuthMode>(() => (searchParams.get('action') === 'signup' ? 'signup' : 'login'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [selectedPlan, setSelectedPlan] = useState('');
  const [pendingAction, setPendingAction] = useState<'login' | 'signup' | 'google' | null>(null);
  const [redirectTarget, setRedirectTarget] = useState('/app/profile');
  const [status, setStatus] = useState<AuthStatus | null>(null);
  // PHONE-OTP: Simplified pages only (not lang=zh-Hant / en), opened first; ?method=email (a link meant for email sign-in)
  // or a notice from an email link opens the email tab.
  const phoneAllowed = phoneSignInAllowed(searchParams.get('lang'));
  const [method, setMethod] = useState<AuthMethod>(() => (phoneAllowed && searchParams.get('method') !== 'email' ? 'phone' : 'email'));
  const showEmail = !phoneAllowed || method === 'email';

  useEffect(() => {
    const action = searchParams.get('action');
    const redirect = sanitizeRedirectTarget(searchParams.get('redirect'));
    const error = searchParams.get('error');
    const planParam = searchParams.get('plan');

    setMode(action === 'signup' ? 'signup' : 'login');
    setRedirectTarget(redirect);
    setSelectedPlan(planParam ?? '');
    const knownEmail = restorePendingEmail(window);
    if (knownEmail) setEmail(knownEmail);
    if (error || searchParams.get('notice') || readAuthFragment(window.location.hash)) setMethod('email');

    const errorMessage = loginErrorMessage(error);
    // After a verifier mismatch the email is usually already confirmed: guide, do not alarm.
    if (errorMessage) setStatus({ tone: error === 'link_needs_login' ? 'info' : 'error', message: errorMessage });
    if (searchParams.get('notice') === 'password_reset') setStatus({ tone: 'success', message: PASSWORD_RESET_DONE_MESSAGE });

    // Errors or tokens from an email link: drop them from the address bar and history first.
    const fragment = readAuthFragment(window.location.hash);
    if (fragment) window.history.replaceState(null, '', window.location.pathname + window.location.search);
    if (fragment?.to === 'verify-expired') {
      window.location.replace(buildAuthHref(buildVerifyEmailPath(redirect, 'expired')));
      return;
    }
    if (fragment?.to === 'login-error') setStatus({ tone: 'error', message: LOGIN_ERROR_MESSAGES.callback_failed });
    if (fragment?.to === 'verified') setStatus({ tone: 'success', message: EMAIL_VERIFIED_LOGIN_MESSAGE });
  }, [searchParams]);

  const handleLogin = async () => {
    setPendingAction('login');
    setStatus(null);

    let captchaOptions: Awaited<ReturnType<typeof invisibleCaptchaOptions>>;
    try {
      captchaOptions = await invisibleCaptchaOptions();
    } catch (error) {
      setStatus({ tone: 'error', message: getSafeErrorMessage(error, '人机验证未完成，请重试。') });
      setPendingAction(null);
      return;
    }

    rememberPendingEmail(email); // read by /verify-email, never put in a URL
    const supabase = createClient();
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
      options: captchaOptions,
    });

    if (error) {
      const failure = classifyLoginError(error, '登录失败，请检查账号信息后重试。');
      if (failure.kind === 'unconfirmed') {
        window.location.assign(buildAuthHref(buildVerifyEmailPath(redirectTarget)));
        return;
      }
      setStatus({ tone: 'error', message: failure.message, offerResend: failure.offerResend });
      setPendingAction(null);
      return;
    }

    if (!isEmailVerified(data.user)) {
      window.location.assign(buildAuthHref(buildVerifyEmailPath(redirectTarget)));
      return;
    }

    clearPendingEmail();
    setStatus({ tone: 'success', message: '登录成功，正在进入应用。' });
    window.location.assign(redirectTarget);
  };

  const handleSignup = async () => {
    setPendingAction('signup');
    setStatus(null);

    const supabase = createClient();
    const emailRedirectTo = getEmailConfirmRedirect(redirectTarget);
    let captchaOptions: Awaited<ReturnType<typeof invisibleCaptchaOptions>>;
    try {
      captchaOptions = await invisibleCaptchaOptions();
    } catch (error) {
      setStatus({ tone: 'error', message: getSafeErrorMessage(error, '人机验证未完成，请重试。') });
      setPendingAction(null);
      return;
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo,
        ...captchaOptions,
        data: {
          nickname: nickname.trim() || undefined,
          display_name: nickname.trim() || undefined,
        },
      },
    });

    if (error) {
      setStatus({
        tone: 'error',
        message: getSafeErrorMessage(error, '注册失败，请稍后重试。'),
      });
      setPendingAction(null);
      return;
    }

    setStatus({
      tone: 'success',
      message: '注册成功，验证邮件已发送。请先完成邮箱验证。',
    });

    rememberPendingEmail(email);
    window.location.assign(buildAuthHref(buildVerifyEmailPath(redirectTarget, 'signup')));
  };

  const handleGoogleLogin = async () => {
    setPendingAction('google');
    setStatus(null);

    const supabase = createClient();
    const redirectTo = getEmailConfirmRedirect(redirectTarget, 'oauth');
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
      },
    });

    if (error) {
      setStatus({
        tone: 'error',
        message: getSafeErrorMessage(error, 'Google 登录失败，请稍后重试。'),
      });
      setPendingAction(null);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    await (mode === 'signup' ? handleSignup() : handleLogin());
  };

  // Off until the page's scripts have taken the form over (hooks/use-hydrated.ts); method="post" keeps a native submit out of the URL.
  const isBusy = pendingAction !== null || !hydrated;
  const submitLabel = !hydrated ? '加载中...' : mode === 'signup' ? '创建账户' : '登录';
  const submitBusyLabel = mode === 'signup' ? '创建中...' : '登录中...';
  const siteName =
    typeof systemSettings?.site_name === 'string' && systemSettings.site_name.trim()
      ? systemSettings.site_name.trim()
      : resolveSiteName();

  return (
    <AuthShell siteName={siteName}>
      <AuthCard>
        <AuthSegment
          value={mode}
          options={[{ value: 'login', label: '登录' }, { value: 'signup', label: '注册' }]}
          onChange={value => setMode(value === 'signup' ? 'signup' : 'login')}
        />

        <AuthHead
          title={mode === 'signup' ? `创建你的 ${siteName} 账户` : `登录到 ${siteName}`}
          lead={!showEmail ? '用中国大陆手机号接收验证码，新号码会自动注册。' : mode === 'signup'
            ? '邮箱注册完成后将收到验证邮件，验证通过后才可使用核心功能。'
            : 'Google 登录无需再次验证邮箱，邮箱账户会按验证状态自动拦截。'}
        />
        <div className="space-y-3 text-center">
          <AuthRedirectNotice target={redirectTarget} />
          {mode === 'signup' && selectedPlan && (
            <p className="rounded-xl border border-[var(--pub-line)] bg-[var(--gl-accent-gold-soft)] px-3 py-2 text-xs text-[var(--gl-accent-gold-text)]">
              当前来自 <span className="font-semibold">{selectedPlan}</span> 套餐入口。注册后可在产品内查看该套餐对应的最新权益与购买状态。
            </p>
          )}
        </div>

        {phoneAllowed && <AuthMethodTabs value={method} onChange={setMethod} />}
        {!showEmail && (
          <div id="auth-method-phone-panel" role="tabpanel" aria-labelledby="auth-method-phone">
            <PhoneSignIn redirectTarget={redirectTarget} submitLabel={mode === 'signup' ? '创建账户' : '登录'} ready={hydrated} />
          </div>
        )}

        {showEmail && <div id="auth-method-email-panel" role={phoneAllowed ? 'tabpanel' : undefined}
          aria-labelledby={phoneAllowed ? 'auth-method-email' : undefined} className="space-y-6">
        <div className="grid gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={handleGoogleLogin}
            disabled={isBusy}
            className={`${AUTH_SECONDARY_BUTTON_CLASS} justify-between px-5`}
            aria-label="使用 Google 一键登录"
          >
            <span className="flex items-center gap-2">
              {pendingAction === 'google' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <GoogleIcon className="h-4 w-4" />
              )}
              使用 Google 一键登录
            </span>
            <ArrowRight className="h-4 w-4 opacity-70" />
          </Button>
          <AuthDivider>或使用邮箱</AuthDivider>
        </div>

        <form className="space-y-4" method="post" onSubmit={handleSubmit}>
          {mode === 'signup' && (
            <div className="space-y-2">
              <Label htmlFor="nickname" className={AUTH_LABEL_CLASS}>
                昵称
              </Label>
              <Input
                id="nickname"
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
                placeholder="怎么称呼你"
                autoComplete="nickname"
                className={AUTH_INPUT_CLASS}
              />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="email" className={AUTH_LABEL_CLASS}>
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
              className={AUTH_INPUT_CLASS}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="password" className={AUTH_LABEL_CLASS}>
                密码
              </Label>
              {mode === 'login' && (
                <Link href={FORGOT_PASSWORD_PATH} className={`text-sm ${AUTH_LINK_CLASS}`}>
                  忘记密码？
                </Link>
              )}
            </div>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={mode === 'signup' ? '至少 8 位密码' : '输入你的密码'}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              minLength={8}
              required
              className={AUTH_INPUT_CLASS}
            />
          </div>

          {status && (
            <AuthStatusBanner
              status={status}
              resendHref={buildAuthHref(buildVerifyEmailPath(redirectTarget))}
              onResendClick={() => rememberPendingEmail(email)}
            />
          )}

          <Button type="submit" disabled={isBusy} className={AUTH_PRIMARY_BUTTON_CLASS}>
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

        <AuthPanel>
          <p>
            {mode === 'signup'
              ? '注册后系统会立即发送验证邮件。你必须点击邮件中的链接完成验证后，才能进入聊天或个人中心。'
              : '如果你之前通过邮箱注册但尚未验证，可以直接打开验证状态页重发邮件。'}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Link
              href={buildVerifyEmailPath(redirectTarget)}
              onClick={() => rememberPendingEmail(email)}
              className={AUTH_LINK_CLASS}
            >
              打开验证状态页
            </Link>
            <button
              type="button"
              onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}
              className={AUTH_LINK_CLASS}
            >
              {mode === 'signup' ? '已有账户，返回登录' : '没有账户，立即注册'}
            </button>
          </div>
        </AuthPanel>

        <ul className="space-y-1 text-center text-[13px] leading-6 text-[var(--pub-muted)]">
          {heroPoints.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        </div>}
      </AuthCard>
    </AuthShell>
  );
}

function LoginPageFallback() {
  return <AuthLoading />;
}
