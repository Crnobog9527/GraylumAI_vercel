'use client';

import { memo, useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
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
}

export const SecuritySettingsCard = memo(function SecuritySettingsCard({ user }: { user: MockUser }) {
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [showVerifyDialog, setShowVerifyDialog] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [verificationCode, setVerificationCode] = useState('');
  const [passwordForm, setPasswordForm] = useState({
    current_password: '',
    new_password: '',
    confirm_password: ''
  });

  const registerDate = user?.created_date
    ? new Date(user.created_date).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
    : '-';

  const handleSendVerificationEmail = async () => {
    setVerifyLoading(true);
    try {
      // TODO: Call tRPC to send verification email
      console.log('Sending verification email...');
      setTimeout(() => {
        setShowVerifyDialog(true);
        setVerifyLoading(false);
      }, 1000);
    } catch (error) {
      setVerifyLoading(false);
    }
  };

  const handleVerifyEmail = async () => {
    if (!verificationCode || verificationCode.length !== 6) {
      return;
    }
    setVerifyLoading(true);
    try {
      // TODO: Call tRPC to verify email
      console.log('Verifying email with code:', verificationCode);
      setTimeout(() => {
        setShowVerifyDialog(false);
        setVerificationCode('');
        setVerifyLoading(false);
      }, 1000);
    } catch (error) {
      setVerifyLoading(false);
    }
  };

  const handleChangePassword = async () => {
    if (!passwordForm.current_password || !passwordForm.new_password || !passwordForm.confirm_password) {
      return;
    }
    if (passwordForm.new_password !== passwordForm.confirm_password) {
      return;
    }
    if (passwordForm.new_password.length < 8) {
      return;
    }

    setPasswordLoading(true);
    try {
      // TODO: Call tRPC to change password
      console.log('Changing password...');
      setTimeout(() => {
        setShowPasswordDialog(false);
        setPasswordForm({ current_password: '', new_password: '', confirm_password: '' });
        setPasswordLoading(false);
      }, 1000);
    } catch (error) {
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
          boxShadow: '0 4px 20px rgba(0,0,0,0.2)'
        }}
      >
        <h3 className="text-lg font-bold mb-6" style={{ color: 'var(--text-primary)' }}>账户安全</h3>

        <div className="space-y-6">
          {/* 登录方式 */}
          <div
            className="p-4 rounded-xl"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="font-medium" style={{ color: 'var(--text-primary)' }}>登录方式</div>
              <span
                className="text-sm px-3 py-1 rounded-full"
                style={{ background: 'rgba(255, 215, 0, 0.1)', color: 'var(--color-primary)' }}
              >
                邮箱密码
              </span>
            </div>
            <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{user?.email}</div>
          </div>

          {/* 邮箱验证 */}
          <div
            className="p-4 rounded-xl"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium" style={{ color: 'var(--text-primary)' }}>邮箱验证</div>
                <div className="text-sm mt-1" style={{ color: 'var(--text-tertiary)' }}>
                  {user?.email_verified ? '已验证' : '未验证'}
                </div>
              </div>
              {user?.email_verified ? (
                <CheckCircle2 className="h-5 w-5" style={{ color: 'var(--success)' }} />
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSendVerificationEmail}
                  disabled={verifyLoading}
                  style={{
                    background: 'transparent',
                    borderColor: 'rgba(255, 215, 0, 0.3)',
                    color: 'var(--color-primary)'
                  }}
                >
                  {verifyLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    '验证邮箱'
                  )}
                </Button>
              )}
            </div>
          </div>

          {/* 修改密码 */}
          <div
            className="p-4 rounded-xl"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium" style={{ color: 'var(--text-primary)' }}>修改密码</div>
                <div className="text-sm mt-1" style={{ color: 'var(--text-tertiary)' }}>定期更新密码以保障账户安全</div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowPasswordDialog(true)}
                style={{
                  background: 'transparent',
                  borderColor: 'rgba(255, 215, 0, 0.3)',
                  color: 'var(--color-primary)'
                }}
              >
                修改
              </Button>
            </div>
          </div>

          {/* 账户注册时间 */}
          <div
            className="p-4 rounded-xl"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}
          >
            <div className="flex items-center justify-between">
              <div className="font-medium" style={{ color: 'var(--text-primary)' }}>注册时间</div>
              <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                {registerDate}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 邮箱验证对话框 */}
      <Dialog open={showVerifyDialog} onOpenChange={setShowVerifyDialog}>
        <DialogContent
          className="sm:max-w-md"
          style={{
            background: 'var(--bg-secondary)',
            borderColor: 'var(--border-primary)',
            color: 'var(--text-primary)'
          }}
        >
          <DialogHeader>
            <DialogTitle style={{ color: 'var(--text-primary)' }}>邮箱验证</DialogTitle>
            <DialogDescription style={{ color: 'var(--text-secondary)' }}>
              验证码已发送至 {user?.email}，请查收邮箱
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="code" style={{ color: 'var(--text-primary)' }}>验证码</Label>
              <Input
                id="code"
                placeholder="请输入6位验证码"
                value={verificationCode}
                onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                maxLength={6}
                style={{
                  background: 'var(--bg-primary)',
                  borderColor: 'var(--border-primary)',
                  color: 'var(--text-primary)'
                }}
              />
            </div>
            <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              验证码有效期30分钟，未收到邮件？
              <button
                onClick={handleSendVerificationEmail}
                className="ml-1 hover:underline"
                style={{ color: 'var(--color-primary)' }}
                disabled={verifyLoading}
              >
                重新发送
              </button>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowVerifyDialog(false)}
              style={{
                background: 'transparent',
                borderColor: 'var(--border-primary)',
                color: 'var(--text-secondary)'
              }}
            >
              取消
            </Button>
            <Button
              onClick={handleVerifyEmail}
              disabled={verifyLoading || verificationCode.length !== 6}
              style={{
                background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                color: 'var(--bg-primary)'
              }}
            >
              {verifyLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  验证中...
                </>
              ) : (
                '确认验证'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 修改密码对话框 */}
      <Dialog open={showPasswordDialog} onOpenChange={setShowPasswordDialog}>
        <DialogContent
          className="sm:max-w-md"
          style={{
            background: 'var(--bg-secondary)',
            borderColor: 'var(--border-primary)',
            color: 'var(--text-primary)'
          }}
        >
          <DialogHeader>
            <DialogTitle style={{ color: 'var(--text-primary)' }}>修改密码</DialogTitle>
            <DialogDescription style={{ color: 'var(--text-secondary)' }}>
              请输入当前密码和新密码
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="current" style={{ color: 'var(--text-primary)' }}>当前密码</Label>
              <Input
                id="current"
                type="password"
                placeholder="请输入当前密码"
                value={passwordForm.current_password}
                onChange={(e) => setPasswordForm({ ...passwordForm, current_password: e.target.value })}
                style={{
                  background: 'var(--bg-primary)',
                  borderColor: 'var(--border-primary)',
                  color: 'var(--text-primary)'
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new" style={{ color: 'var(--text-primary)' }}>新密码</Label>
              <Input
                id="new"
                type="password"
                placeholder="至少8位字符"
                value={passwordForm.new_password}
                onChange={(e) => setPasswordForm({ ...passwordForm, new_password: e.target.value })}
                style={{
                  background: 'var(--bg-primary)',
                  borderColor: 'var(--border-primary)',
                  color: 'var(--text-primary)'
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm" style={{ color: 'var(--text-primary)' }}>确认新密码</Label>
              <Input
                id="confirm"
                type="password"
                placeholder="再次输入新密码"
                value={passwordForm.confirm_password}
                onChange={(e) => setPasswordForm({ ...passwordForm, confirm_password: e.target.value })}
                style={{
                  background: 'var(--bg-primary)',
                  borderColor: 'var(--border-primary)',
                  color: 'var(--text-primary)'
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
                color: 'var(--text-secondary)'
              }}
            >
              取消
            </Button>
            <Button
              onClick={handleChangePassword}
              disabled={passwordLoading}
              style={{
                background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                color: 'var(--bg-primary)'
              }}
            >
              {passwordLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  修改中...
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
