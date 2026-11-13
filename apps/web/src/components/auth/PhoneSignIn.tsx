/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import Link from 'next/link';
import { useId } from 'react';
import { Loader2 } from 'lucide-react';
import { SMS_CODE_LENGTH, SMS_CODE_MINUTES } from '@repo/api/src/shared/mainlandPhone';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { usePhoneSignIn } from '@/hooks/use-phone-sign-in';
import { AuthStatusBanner } from './AuthStatusBanner';
import {
  AUTH_INPUT_CLASS, AUTH_LABEL_CLASS, AUTH_LINK_CLASS, AUTH_PRIMARY_BUTTON_CLASS, AUTH_SECONDARY_BUTTON_CLASS,
} from './AuthShell';
import styles from './auth-shell.module.css';

export type AuthMethod = 'phone' | 'email';

/** 手机号 / 邮箱 (PHONE-OTP): tabs over the two sign-in forms; Simplified Chinese login page only. */
export function AuthMethodTabs({ value, onChange }: { value: AuthMethod; onChange: (value: AuthMethod) => void }) {
  const options: ReadonlyArray<{ value: AuthMethod; label: string }> = [{ value: 'phone', label: '手机号' }, { value: 'email', label: '邮箱' }];
  return (
    <div role="tablist" aria-label="登录方式" className={styles.methods}>
      {options.map(option => (
        <button key={option.value} type="button" role="tab" id={`auth-method-${option.value}`} aria-selected={value === option.value}
          aria-controls={`auth-method-${option.value}-panel`} className={styles.method} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Mainland phone sign-in (PHONE-OTP, Owner 2026-11-07): +86 number and the two separate PIPL boxes →
 * six-digit code (5 minutes) → signed in; a new number becomes an account. No password. `submitLabel`: 登录 or 创建账户.
 */
export function PhoneSignIn({ redirectTarget, submitLabel, ready }: { redirectTarget: string; submitLabel: string; ready: boolean }) {
  const flow = usePhoneSignIn(redirectTarget);
  const id = useId();
  // Off until the page's scripts have taken the form over, like the email form.
  const busy = flow.pending !== null || !ready;
  const status = flow.error ? <AuthStatusBanner status={{ tone: 'error', message: flow.error }} /> : null;

  if (flow.step === 'code') {
    return (
      <form className="space-y-4" method="post" onSubmit={(event) => { event.preventDefault(); void flow.verify(); }}>
        <p className={styles.fine} aria-live="polite">验证码已发送至 {flow.maskedPhone}，{SMS_CODE_MINUTES} 分钟内有效。</p>
        <div className="space-y-2">
          <Label htmlFor={`${id}-code`} className={AUTH_LABEL_CLASS}>验证码</Label>
          <Input id={`${id}-code`} name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" autoFocus
            maxLength={SMS_CODE_LENGTH} value={flow.code} onChange={(event) => flow.onCodeChange(event.target.value)}
            placeholder="6 位数字" className={`${AUTH_INPUT_CLASS} ${styles.code}`} aria-describedby={`${id}-code-hint`} />
          <p id={`${id}-code-hint`} className={styles.fine}>填满 6 位会自动{submitLabel}。</p>
        </div>
        {status}
        <Button type="submit" disabled={busy} className={AUTH_PRIMARY_BUTTON_CLASS}>
          {flow.pending === 'verify' ? <><Loader2 className="h-4 w-4 animate-spin" />验证中...</> : submitLabel}
        </Button>
        <div className="grid gap-3 sm:grid-cols-2">
          <Button type="button" variant="outline" disabled={busy || flow.waitSeconds > 0} onClick={() => void flow.send()}
            className={AUTH_SECONDARY_BUTTON_CLASS}>
            {flow.pending === 'send' ? '发送中...' : flow.waitSeconds > 0 ? `${flow.waitSeconds} 秒后可重新获取` : '重新获取验证码'}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={flow.changeNumber} className={AUTH_SECONDARY_BUTTON_CLASS}>
            换个手机号
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form className="space-y-4" method="post" noValidate onSubmit={(event) => { event.preventDefault(); void flow.send(); }}>
      <div className="space-y-2">
        <Label htmlFor={`${id}-phone`} className={AUTH_LABEL_CLASS}>手机号</Label>
        <div className={styles.tel}>
          <span className={styles.cc} aria-hidden="true">+86</span>
          <Input id={`${id}-phone`} type="tel" name="phone" inputMode="numeric" autoComplete="tel-national" enterKeyHint="send"
            placeholder="11 位手机号" maxLength={13} value={flow.phone} onChange={(event) => flow.setPhone(event.target.value)}
            className={AUTH_INPUT_CLASS} aria-describedby={`${id}-phone-hint`} />
        </div>
        <p id={`${id}-phone-hint`} className={styles.fine}>仅支持中国大陆（+86）手机号；未注册的号码验证后会自动创建账户，不用设密码。</p>
      </div>
      <label className={styles.check}>
        <input type="checkbox" name="privacyConsent" checked={flow.privacy} onChange={(event) => flow.setPrivacy(event.target.checked)} />
        <span>我已阅读并同意 <Link href="/privacy" target="_blank" rel="noopener" className={AUTH_LINK_CLASS}>隐私政策</Link></span>
      </label>
      <label className={styles.check}>
        <input type="checkbox" name="transferConsent" checked={flow.transfer} onChange={(event) => flow.setTransfer(event.target.checked)} />
        <span>我同意将手机号等个人信息传输到中国大陆境外（美国）存储和处理（个人信息出境）</span>
      </label>
      {status}
      <Button type="submit" disabled={busy} className={AUTH_PRIMARY_BUTTON_CLASS}>
        {!ready ? '加载中...' : flow.pending === 'send' ? <><Loader2 className="h-4 w-4 animate-spin" />发送中...</> : '获取验证码'}
      </Button>
    </form>
  );
}
