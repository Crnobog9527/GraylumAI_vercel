'use client';

import { memo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  Loader2,
  Mail,
  ShieldCheck,
} from 'lucide-react';
import { createClient } from '@/lib/supabase';
import { buildAuthHref } from '@/lib/site-config';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { keepDialogOpenForCaptcha } from '@/lib/dialogCaptcha';
import { invisibleCaptchaOptions } from '@/lib/invisibleCaptcha';
import { FORGOT_PASSWORD_PATH } from '@/lib/passwordRecovery';
import { createPasswordChanger, passwordChangeEntry, SET_PASSWORD_BY_EMAIL_HINT } from '@/lib/passwordChange';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface MockUser {
  email?: string;
  email_verified?: boolean;
  created_date?: string;
  auth_provider?: 'email' | 'google' | 'unknown';
}

export const SecuritySettingsCard = memo(function SecuritySettingsCard({ user }: { user: MockUser }) {
  const router = useRouter();
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [statusTone, setStatusTone] = useState<'info' | 'success' | 'error'>('info');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  // One changer per page: after an unanswered update it stops further attempts (see passwordChange.ts).
  const [passwordChanger] = useState(() => createPasswordChanger({
    // Invisible hCaptcha: a fresh single-use token per attempt; a challenge appears only if needed.
    captcha: () => invisibleCaptchaOptions(),
    signInWithPassword: credentials => createClient().auth.signInWithPassword(credentials),
    updatePassword: password => createClient().auth.updateUser({ password }),
  }));
  const [changeLocked, setChangeLocked] = useState(false);
  const [passwordForm, setPasswordForm] = useState({
    current_password: '',
    new_password: '',
    confirm_password: '',
  });

  const authProvider = user?.auth_provider || 'email';
  // Not hidden by provider: a Google account may have set a password, which GoTrue does not show.
  const passwordEntry = passwordChangeEntry({ email: user?.email, auth_provider: authProvider });
  const registerDate = user?.created_date
    ? new Date(user.created_date).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
    : '-';

  const clearPasswordForm = () => setPasswordForm({ current_password: '', new_password: '', confirm_password: '' });

  const handleChangePassword = async () => {
    setPasswordLoading(true);
    try {
      const result = await passwordChanger.change(user?.email, {
        current: passwordForm.current_password,
        next: passwordForm.new_password,
        confirm: passwordForm.confirm_password,
      });

      if (!result.ok && result.locked) {
        // Maybe saved: no retry from this form, the visitor checks by signing in again.
        setChangeLocked(true);
        setShowPasswordDialog(false);
        clearPasswordForm();
        setStatusTone('info');
        setStatusMessage(result.message);
        return;
      }

      if (!result.ok) {
        setStatusTone('error');
        setStatusMessage(result.message);
        return;
      }

      setStatusTone('success');
      setStatusMessage('密码已更新。');
      setShowPasswordDialog(false);
      clearPasswordForm();
    } finally {
      setPasswordLoading(false);
    }
  };

  return (
    <>
      <div
        className="rounded-2xl p-6"
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
        }}
      >
        <h3 className="mb-6 text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
          账户安全
        </h3>

        <div className="space-y-6">
          <div
            className="rounded-xl p-4"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}
          >
            <div className="mb-2 flex items-center justify-between">
              <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                登录方式
              </div>
              <span
                className="rounded-full px-3 py-1 text-sm"
                style={{ background: 'rgba(255, 215, 0, 0.1)', color: 'var(--color-primary)' }}
              >
                {authProvider === 'google' ? 'Google 授权登录' : '邮箱密码'}
              </span>
            </div>
            <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
              {user?.email}
            </div>
          </div>

          <div
            className="rounded-xl p-4"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                  邮箱验证
                </div>
                <div className="mt-1 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                  {user?.email_verified
                    ? '已验证'
                    : authProvider === 'google'
                      ? 'Google 账户默认已完成邮箱验证'
                      : '未验证'}
                </div>
              </div>

              {user?.email_verified ? (
                <CheckCircle2 className="h-5 w-5" style={{ color: 'var(--success)' }} />
              ) : authProvider === 'google' ? (
                <ShieldCheck className="h-5 w-5" style={{ color: 'var(--color-primary)' }} />
              ) : (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      router.push(
                        buildAuthHref(
                          `/verify-email?email=${encodeURIComponent(user?.email || '')}&redirect=${encodeURIComponent('/profile?tab=security')}`
                        )
                      )
                    }
                    style={{
                      background: 'transparent',
                      borderColor: 'rgba(255, 215, 0, 0.3)',
                      color: 'var(--color-primary)',
                    }}
                  >
                    前往验证页重发
                  </Button>
                </div>
              )}
            </div>
          </div>

          <div
            className="rounded-xl p-4"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                  修改密码
                </div>
                <div className="mt-1 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                  {passwordEntry.description}
                </div>
              </div>

              {passwordEntry.available ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={changeLocked}
                  onClick={() => { setStatusMessage(null); setShowPasswordDialog(true); }}
                  style={{
                    background: 'transparent',
                    borderColor: 'rgba(255, 215, 0, 0.3)',
                    color: 'var(--color-primary)',
                  }}
                >
                  修改
                </Button>
              ) : (
                <Mail className="h-5 w-5" style={{ color: 'var(--text-disabled)' }} />
              )}
            </div>
          </div>

          {statusMessage && (
            <div
              className="rounded-xl p-4 text-sm"
              aria-live="polite"
              style={{
                background:
                  statusTone === 'error'
                    ? 'rgba(239, 68, 68, 0.12)'
                    : statusTone === 'success'
                      ? 'rgba(34, 197, 94, 0.12)'
                      : 'rgba(255, 215, 0, 0.12)',
                color:
                  statusTone === 'error'
                    ? '#fca5a5'
                    : statusTone === 'success'
                      ? '#86efac'
                      : 'var(--color-primary)',
                border: '1px solid rgba(255,255,255,0.06)',
              }}
            >
              {statusMessage}
            </div>
          )}

          <div
            className="rounded-xl p-4"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}
          >
            <div className="flex items-center justify-between">
              <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                注册时间
              </div>
              <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                {registerDate}
              </span>
            </div>
          </div>
        </div>
      </div>

      <Dialog open={showPasswordDialog} onOpenChange={setShowPasswordDialog}>
        <DialogContent
          onInteractOutside={keepDialogOpenForCaptcha}
          className="sm:max-w-md"
          style={{
            background: 'var(--bg-secondary)',
            borderColor: 'var(--border-primary)',
            color: 'var(--text-primary)',
          }}
        >
          <DialogHeader>
            <DialogTitle style={{ color: 'var(--text-primary)' }}>修改密码</DialogTitle>
            <DialogDescription style={{ color: 'var(--text-secondary)' }}>
              请输入当前密码并设置新的账户密码。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="current-password" style={{ color: 'var(--text-primary)' }}>
                当前密码
              </Label>
              <Input
                id="current-password"
                type="password"
                placeholder="请输入当前密码"
                value={passwordForm.current_password}
                onChange={(event) =>
                  setPasswordForm({ ...passwordForm, current_password: event.target.value })
                }
                style={{
                  background: 'var(--bg-primary)',
                  borderColor: 'var(--border-primary)',
                  color: 'var(--text-primary)',
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password" style={{ color: 'var(--text-primary)' }}>
                新密码
              </Label>
              <Input
                id="new-password"
                type="password"
                placeholder="至少 8 位字符"
                value={passwordForm.new_password}
                onChange={(event) =>
                  setPasswordForm({ ...passwordForm, new_password: event.target.value })
                }
                style={{
                  background: 'var(--bg-primary)',
                  borderColor: 'var(--border-primary)',
                  color: 'var(--text-primary)',
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password" style={{ color: 'var(--text-primary)' }}>
                确认新密码
              </Label>
              <Input
                id="confirm-password"
                type="password"
                placeholder="再次输入新密码"
                value={passwordForm.confirm_password}
                onChange={(event) =>
                  setPasswordForm({ ...passwordForm, confirm_password: event.target.value })
                }
                style={{
                  background: 'var(--bg-primary)',
                  borderColor: 'var(--border-primary)',
                  color: 'var(--text-primary)',
                }}
              />
            </div>
            {statusTone === 'error' && statusMessage && (
              <p className="text-sm" role="alert" style={{ color: '#fca5a5' }}>
                {statusMessage}
              </p>
            )}
            {/* For accounts without a current password (for example signed up with Google only). */}
            <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
              {SET_PASSWORD_BY_EMAIL_HINT}
              <Link
                href={buildAuthHref(FORGOT_PASSWORD_PATH)}
                className="ml-1 underline-offset-4 hover:underline"
                style={{ color: 'var(--color-primary)' }}
              >
                通过邮件设置密码
              </Link>
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowPasswordDialog(false)}
              style={{
                background: 'transparent',
                borderColor: 'var(--border-primary)',
                color: 'var(--text-secondary)',
              }}
            >
              取消
            </Button>
            <Button
              onClick={handleChangePassword}
              disabled={passwordLoading}
              style={{
                background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                color: 'var(--bg-primary)',
              }}
            >
              {passwordLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  更新中...
                </>
              ) : (
                '确认修改'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});
