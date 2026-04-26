'use client';

import { memo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  Loader2,
  Mail,
  ShieldCheck,
} from 'lucide-react';
import { createClient } from '@/lib/supabase';
import { getSafeErrorMessage } from '@/lib/safe-error-message';
import { buildAuthHref, resolveAuthAppUrl } from '@/lib/site-config';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  const [resendLoading, setResendLoading] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [statusTone, setStatusTone] = useState<'info' | 'success' | 'error'>('info');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [passwordForm, setPasswordForm] = useState({
    current_password: '',
    new_password: '',
    confirm_password: '',
  });

  const authProvider = user?.auth_provider || 'email';
  const isEmailPasswordAccount = authProvider === 'email';
  const registerDate = user?.created_date
    ? new Date(user.created_date).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
    : '-';

  const handleResendVerificationEmail = async () => {
    if (!user?.email) {
      setStatusTone('error');
      setStatusMessage('当前没有可用邮箱地址，无法发送验证邮件。');
      return;
    }

    setResendLoading(true);
    setStatusMessage(null);

    try {
      const supabase = createClient();
      const emailRedirectTo = new URL('/auth/callback', resolveAuthAppUrl());
      emailRedirectTo.searchParams.set('next', '/profile?tab=security');

      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: user.email,
        options: {
          emailRedirectTo: emailRedirectTo.toString(),
        },
      });

      if (error) {
        setStatusTone('error');
        setStatusMessage(getSafeErrorMessage(error, '验证邮件发送失败，请稍后重试。'));
        return;
      }

      setStatusTone('success');
      setStatusMessage('验证邮件已重新发送，请前往收件箱完成验证。');
    } finally {
      setResendLoading(false);
    }
  };

  const handleChangePassword = async () => {
    if (!passwordForm.current_password || !passwordForm.new_password || !passwordForm.confirm_password) {
      setStatusTone('error');
      setStatusMessage('请完整填写当前密码和新密码。');
      return;
    }

    if (passwordForm.new_password !== passwordForm.confirm_password) {
      setStatusTone('error');
      setStatusMessage('两次输入的新密码不一致。');
      return;
    }

    if (passwordForm.new_password.length < 8) {
      setStatusTone('error');
      setStatusMessage('新密码至少需要 8 位字符。');
      return;
    }

    if (!user?.email) {
      setStatusTone('error');
      setStatusMessage('当前会话缺少邮箱信息，无法修改密码。');
      return;
    }

    setPasswordLoading(true);

    try {
      const supabase = createClient();
      const { error: reauthError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: passwordForm.current_password,
      });

      if (reauthError) {
        setStatusTone('error');
        setStatusMessage('当前密码验证失败，请重新输入。');
        return;
      }

      const { error: updateError } = await supabase.auth.updateUser({
        password: passwordForm.new_password,
      });

      if (updateError) {
        setStatusTone('error');
        setStatusMessage(updateError.message);
        return;
      }

      setStatusTone('success');
      setStatusMessage('密码已更新。');
      setShowPasswordDialog(false);
      setPasswordForm({
        current_password: '',
        new_password: '',
        confirm_password: '',
      });
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
                    onClick={handleResendVerificationEmail}
                    disabled={resendLoading}
                    style={{
                      background: 'transparent',
                      borderColor: 'rgba(255, 215, 0, 0.3)',
                      color: 'var(--color-primary)',
                    }}
                  >
                    {resendLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : '重发验证邮件'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      router.push(
                        buildAuthHref(
                          `/verify-email?email=${encodeURIComponent(user?.email || '')}&redirect=${encodeURIComponent('/profile?tab=security')}`
                        )
                      )
                    }
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    查看说明
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
                  {isEmailPasswordAccount
                    ? '邮箱密码账户可在重新验证当前密码后修改密码'
                    : 'Google 登录账户不提供站内密码修改'}
                </div>
              </div>

              {isEmailPasswordAccount ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowPasswordDialog(true)}
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
