"use client";

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle2, Loader2, LogOut, MailCheck, RefreshCw } from 'lucide-react';
import { createClient } from '@/lib/supabase';
import { isEmailVerified, sanitizeRedirectTarget } from '@/lib/auth';
import { buildAuthHref, resolveAuthAppUrl } from '@/lib/site-config';
import { Button } from '@/components/ui/button';
import {
  buildAuthCallbackUrl,
  parseVerifyReason,
  readAuthFragment,
  resendErrorMessage,
  VERIFY_NEEDS_LOGIN_MESSAGE,
  VERIFY_REASON_MESSAGES,
} from '@/lib/authFlow';
import { Input } from '@/components/ui/input';
import { clearPendingEmail, rememberPendingEmail, restorePendingEmail } from '@/lib/pendingAuthEmail';
import { cn } from '@/lib/utils';
import {
  AUTH_INPUT_CLASS, AUTH_LINK_CLASS, AUTH_PRIMARY_BUTTON_CLASS, AUTH_SECONDARY_BUTTON_CLASS, AuthCard, AuthHead, AuthLoading, AuthPanel, AuthShell,
} from '@/components/auth/AuthShell';

type VerifyTone = 'info' | 'success' | 'error';

const REDIRECT_DISPLAY_LIMIT = 48;

function displayRedirect(target: string) {
  return target.length > REDIRECT_DISPLAY_LIMIT ? `${target.slice(0, REDIRECT_DISPLAY_LIMIT - 1)}…` : target;
}

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
  // The URL never carries the email: it comes from the session (read-only) or this tab's storage
  // (editable prefill); with neither (another device, an expired link) the visitor types it.
  const [emailEditable, setEmailEditable] = useState(false);
  const [redirectTarget, setRedirectTarget] = useState('/app/profile');
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
      const nextEmail = restorePendingEmail(window);
      const nextRedirect = sanitizeRedirectTarget(searchParams.get('redirect'));
      const reason = parseVerifyReason(searchParams.get('reason'));

      setEmail(nextEmail);
      setRedirectTarget(nextRedirect);
      // An email link may carry its error (or tokens) in the fragment; keep it out of the address bar.
      if (readAuthFragment(window.location.hash)) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }

      const supabase = createClient();
      const { data } = await supabase.auth.getUser();

      if (data.user?.email) {
        setEmail(data.user.email);
      }
      // Without a session the saved email is only a prefill: it may be from an earlier attempt in
      // this tab, so the visitor can still correct it before resending.
      setEmailEditable(!data.user?.email);

      if (isEmailVerified(data.user)) {
        clearPendingEmail();
        router.replace(nextRedirect);
        return;
      }

      setChecking(false);
      setMessage({
        tone: reason === 'expired' ? 'error' : 'info',
        text: reason
          ? VERIFY_REASON_MESSAGES[reason]
          : data.user
            ? '邮箱账户必须完成验证后，才能进入聊天、个人中心和其他受保护功能。'
            : VERIFY_NEEDS_LOGIN_MESSAGE,
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
      clearPendingEmail();
      router.replace(redirectTarget);
      return;
    }

    // Without a session here the status is unknown: the link may have been confirmed elsewhere.
    setMessage({
      tone: 'info',
      text: data.user
        ? '还没有检测到验证完成。请点击邮件中的确认链接，然后再刷新状态。'
        : VERIFY_NEEDS_LOGIN_MESSAGE,
    });
    setRefreshing(false);
  };

  const handleResend = async () => {
    if (!email) {
      setMessage({
        tone: 'error',
        text: emailEditable ? '请先填写注册时使用的邮箱。' : '当前没有可用邮箱地址，请返回登录页重新发起注册。',
      });
      return;
    }

    setResending(true);
    const supabase = createClient();

    const { error } = await supabase.auth.resend({
      type: 'signup',
      email,
      options: {
        emailRedirectTo: buildAuthCallbackUrl(resolveAuthAppUrl(window.location.origin), redirectTarget),
      },
    });

    if (error) {
      setMessage({
        tone: 'error',
        text: resendErrorMessage(error),
      });
      setResending(false);
      return;
    }

    rememberPendingEmail(email); // a typed email survives a refresh of this page
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
    rememberPendingEmail(email);
    router.replace(buildAuthHref('/login'));
  };

  if (checking) return <AuthLoading />;

  const noticeTone = { error: 'var(--gl-error)', success: 'var(--gl-success)', info: 'var(--gl-warning)' }[message.tone];
  const noticeBackground = { error: 'var(--gl-error-bg)', success: 'var(--gl-success-bg)', info: 'var(--gl-warning-bg)' }[message.tone];

  return (
    <AuthShell>
      <AuthCard>
        <AuthHead
          icon={<MailCheck className="h-7 w-7" aria-hidden="true" />}
          title="检查你的邮箱"
          lead="邮箱注册账户在完成验证前不可访问核心业务。验证成功后，你会自动进入原本要访问的页面。"
        />

        <AuthPanel>
          <div className="flex items-center justify-between gap-4">
            <span className="shrink-0 text-[var(--pub-muted)]">当前邮箱</span>
            {emailEditable ? (
              <Input
                type="email"
                autoComplete="email"
                aria-label="注册时使用的邮箱"
                placeholder="name@example.com"
                value={email}
                onChange={event => setEmail(event.target.value.trim())}
                className={cn(AUTH_INPUT_CLASS, 'h-10 max-w-xs text-right')}
              />
            ) : (
              <span className="break-all text-right text-[var(--pub-ink)]">{email || '未提供'}</span>
            )}
          </div>
        </AuthPanel>

        <div
          className="rounded-xl border px-4 py-4 text-sm leading-6"
          aria-live="polite"
          style={{ borderColor: noticeTone, background: noticeBackground, color: noticeTone }}
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
          <Button
            type="button"
            onClick={handleRefreshStatus}
            disabled={refreshing || signingOut}
            className={cn(AUTH_PRIMARY_BUTTON_CLASS, 'h-12 px-4 text-[15px]')}
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
            className={AUTH_SECONDARY_BUTTON_CLASS}
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

        <AuthPanel className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            验证成功后将进入{' '}
            <span className="break-all font-mono text-[var(--pub-ink)]" title={redirectTarget}>
              {displayRedirect(redirectTarget)}
            </span>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-3 whitespace-nowrap">
            <Link
              href={buildAuthHref('/login')}
              onClick={() => rememberPendingEmail(email)}
              className={AUTH_LINK_CLASS}
            >
              返回登录页
            </Link>
            <button
              type="button"
              onClick={handleSignOut}
              disabled={signingOut}
              className={cn('inline-flex items-center gap-1', AUTH_LINK_CLASS)}
            >
              {signingOut ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <LogOut className="h-4 w-4" />
              )}
              退出当前会话
            </button>
          </div>
        </AuthPanel>
      </AuthCard>
    </AuthShell>
  );
}

function VerifyEmailFallback() {
  return <AuthLoading />;
}
