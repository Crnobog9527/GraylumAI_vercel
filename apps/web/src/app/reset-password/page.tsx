"use client";

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { Loader2, LockKeyhole, LogOut, RefreshCw } from 'lucide-react';
import { ACCOUNT_GATE_MESSAGES, FORGOT_PASSWORD_PATH, RECOVERY_FAILURE_MESSAGES } from '@/lib/passwordRecovery';
import { usePasswordReset } from '@/hooks/use-password-reset';
import { clearAuthFragment } from '@/lib/authFlow';
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

const NOT_RECOVERY_MESSAGE =
  '这个页面只能通过重置密码邮件中的链接打开，并且要在 1 小时内完成设置。已登录时，可以在个人中心的“账户安全”里修改密码。';
const SIGNOUT_PENDING_MESSAGE =
  '密码已经修改，但退出登录没有完成。请检查网络后点“重试退出”，退出后用新密码登录。';
const BLOCKED_SIGNOUT_MESSAGE = '退出登录没有完成，请检查网络后点“重试退出”。';

export default function ResetPasswordPage() {
  const { phase, pending, formError, retry, retrySignOut, submit } = usePasswordReset();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  // An email link's fragment (an error, or tokens of a link sent without PKCE) never stays in the
  // address bar; tokens there are never turned into a session.
  useEffect(() => {
    clearAuthFragment(window);
  }, []);

  if (phase.kind === 'checking') return <AuthPageLoading />;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit(password, confirm);
  };

  let notice: AuthStatus | null = null;
  if (phase.kind === 'no-link') notice = { tone: 'error', message: RECOVERY_FAILURE_MESSAGES.expired };
  if (phase.kind === 'not-recovery') notice = { tone: 'info', message: NOT_RECOVERY_MESSAGE };
  if (phase.kind === 'blocked') {
    const message = ACCOUNT_GATE_MESSAGES[phase.gate];
    notice = { tone: 'error', message: phase.signedOut ? message : `${message}${BLOCKED_SIGNOUT_MESSAGE}` };
  }
  if (phase.kind === 'signout-pending') notice = { tone: 'info', message: SIGNOUT_PENDING_MESSAGE };
  const signOutRetry = phase.kind === 'signout-pending' || (phase.kind === 'blocked' && !phase.signedOut);

  return (
    <AuthPageCard icon={LockKeyhole} title="设置新密码" description="新密码至少 8 位。设置成功后，所有设备都需要用新密码重新登录。">
      {phase.kind === 'ready' ? (
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="new-password" className="text-[#f2f2f2]">
              新密码
            </Label>
            <Input
              id="new-password"
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              placeholder="至少 8 位密码"
              autoComplete="new-password"
              minLength={8}
              required
              className={AUTH_INPUT_CLASS}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-password" className="text-[#f2f2f2]">
              确认新密码
            </Label>
            <Input
              id="confirm-password"
              type="password"
              value={confirm}
              onChange={event => setConfirm(event.target.value)}
              placeholder="再输入一次新密码"
              autoComplete="new-password"
              minLength={8}
              required
              className={AUTH_INPUT_CLASS}
            />
          </div>

          {formError && <AuthStatusBanner status={{ tone: 'error', message: formError }} />}

          <Button type="submit" disabled={pending} className={AUTH_PRIMARY_BUTTON_CLASS}>
            {pending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                保存中...
              </>
            ) : (
              '保存新密码'
            )}
          </Button>
        </form>
      ) : (
        notice && <AuthStatusBanner status={notice} />
      )}

      <div
        className="flex flex-wrap items-center gap-4 rounded-2xl border px-4 py-4 text-sm text-[#afafaf]"
        style={{ borderColor: 'rgba(255,255,255,0.08)' }}
      >
        {signOutRetry && (
          <button
            type="button"
            onClick={() => void retrySignOut()}
            disabled={pending}
            className={`inline-flex items-center gap-1 ${AUTH_LINK_CLASS}`}
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
            重试退出
          </button>
        )}
        {phase.kind === 'blocked' && phase.gate === 'retry' && (
          <button type="button" onClick={() => void retry()} className={`inline-flex items-center gap-1 ${AUTH_LINK_CLASS}`}>
            <RefreshCw className="h-4 w-4" />
            重试
          </button>
        )}
        {phase.kind === 'not-recovery' && (
          <Link href="/profile?tab=security" className={AUTH_LINK_CLASS}>
            前往账户安全
          </Link>
        )}
        {(phase.kind === 'no-link' || phase.kind === 'not-recovery') && (
          <Link href={FORGOT_PASSWORD_PATH} className={AUTH_LINK_CLASS}>
            重新申请重置邮件
          </Link>
        )}
        {/* Still signed in: the login page would send the visitor straight back into the app. */}
        {!signOutRetry && (
          <Link href="/login" className={AUTH_LINK_CLASS}>
            返回登录
          </Link>
        )}
      </div>
    </AuthPageCard>
  );
}
