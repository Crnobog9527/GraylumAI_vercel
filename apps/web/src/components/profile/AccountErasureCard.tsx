'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
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
import { DialogCaptcha } from '@/components/auth/DialogCaptcha';
import { keepDialogOpenForCaptcha } from '@/lib/dialogCaptcha';
import { buildErasureImpactLines, type ImpactLine } from '@/lib/account-erasure';
import { useAccountErasure } from '@/hooks/use-account-erasure';
import { ProgressCredential } from '@/components/account-erasure/ProgressCredential';

const TONE_COLOR: Record<ImpactLine['tone'], string> = {
  block: '#fca5a5',
  warn: 'var(--color-primary)',
  info: 'var(--text-secondary)',
};

const panelStyle = { background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' };
const inputStyle = { background: 'var(--bg-primary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' };
const dangerStyle = { background: '#dc2626', color: '#fff' };
const ghostStyle = { background: 'transparent', borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' };

export function AccountErasureCard({ user }: { user: { email?: string; auth_provider?: string } }) {
  const usesPassword = (user.auth_provider ?? 'email') === 'email';
  const erasure = useAccountErasure({ email: user.email, usesPassword });
  const [acknowledged, setAcknowledged] = useState(false);
  const preview = erasure.preview;
  const lines = preview ? buildErasureImpactLines(preview) : [];
  const blocked = Boolean(preview?.subscriptionRenewing);

  const onOpenChange = (next: boolean) => {
    if (erasure.busy) return;
    if (erasure.step === 'done') {
      void erasure.finish();
      return;
    }
    setAcknowledged(false);
    erasure.setOpen(next);
  };

  return (
    <>
      <div className="mt-6 rounded-2xl p-6" style={{ background: 'var(--bg-secondary)', border: '1px solid rgba(239,68,68,0.35)' }}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-medium" style={{ color: 'var(--text-primary)' }}>注销账号</div>
            <div className="mt-1 text-sm" style={{ color: 'var(--text-tertiary)' }}>
              永久关闭账号并清除私有内容，确认后不能撤销。
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(true)} style={{ ...ghostStyle, color: '#fca5a5' }}>
            注销账号
          </Button>
        </div>
      </div>

      <Dialog open={erasure.open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg" style={panelStyle} onInteractOutside={keepDialogOpenForCaptcha}>
          <DialogHeader>
            <DialogTitle style={{ color: 'var(--text-primary)' }}>
              {erasure.step === 'done' ? (erasure.handoff?.closed ? '账号已关闭' : '注销结果待确认') : '注销账号'}
            </DialogTitle>
            <DialogDescription style={{ color: 'var(--text-secondary)' }}>
              {erasure.step === 'impact' && '请先确认注销会带来的影响。'}
              {erasure.step === 'verify' && (usesPassword ? '请输入当前密码验证身份。' : '我们会向你的邮箱发送验证码。')}
              {erasure.step === 'confirm' && '这是最后一步，确认后立即生效。'}
              {erasure.step === 'done' && '请先保存查询凭证，再退出本机登录。'}
            </DialogDescription>
          </DialogHeader>

          {erasure.step === 'impact' && (
            <div className="space-y-2 py-2 text-sm" aria-live="polite">
              {erasure.previewLoading && <Loader2 className="h-4 w-4 animate-spin" />}
              {erasure.previewFailed && <p style={{ color: TONE_COLOR.block }}>暂时无法读取注销影响，请稍后重试。</p>}
              {lines.map((line) => (
                <p key={line.text} style={{ color: TONE_COLOR[line.tone] }}>{line.text}</p>
              ))}
            </div>
          )}

          {erasure.step === 'verify' && (
            <div className="space-y-3 py-2">
              <DialogCaptcha
                key={erasure.captchaKey}
                onToken={erasure.setCaptchaToken}
                onExpired={erasure.captchaExpired}
                onUnavailable={erasure.captchaUnavailable}
              />
              {!usesPassword && (
                <Button variant="outline" size="sm" disabled={erasure.busy} onClick={erasure.sendCode} style={ghostStyle}>
                  {erasure.codeSent ? '重新发送验证码' : '发送验证码'}
                </Button>
              )}
              <Label htmlFor="erasure-secret" style={{ color: 'var(--text-primary)' }}>
                {usesPassword ? '当前密码' : '邮箱验证码'}
              </Label>
              <Input
                id="erasure-secret"
                type={usesPassword ? 'password' : 'text'}
                inputMode={usesPassword ? undefined : 'numeric'}
                autoComplete={usesPassword ? 'current-password' : 'one-time-code'}
                value={erasure.secret}
                onChange={(event) => erasure.setSecret(event.target.value)}
                style={inputStyle}
              />
            </div>
          )}

          {erasure.step === 'confirm' && (
            <label className="flex items-start gap-2 py-2 text-sm" style={{ color: 'var(--text-primary)' }}>
              <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
              我已了解上述退款规则：如需申请退款，应在注销前通过客服工单处理；确认后账号立即关闭且不能撤销，剩余积分作废。
            </label>
          )}

          {erasure.error && <p className="text-sm" role="alert" style={{ color: TONE_COLOR.block }}>{erasure.error}</p>}

          {erasure.step === 'done' && <div className="space-y-3 text-sm">
            {erasure.handoff?.credential ? <ProgressCredential credential={erasure.handoff.credential} /> : <p role="status">
              {erasure.handoff?.closed ? '账号已关闭，当前无法查询进度。'
                : '未收到注销确认结果，账号可能已关闭，当前无法查询进度。请勿再次申请注销。'}
            </p>}
            {!erasure.handoffStored && <p role="alert">浏览器无法保存会话副本，请在离开前自行保存凭证。</p>}
            <p>凭证在待处理期间有效，注销完成后 30 天失效。遗失或未收到凭证时，不提供找回或重新签发。</p>
          </div>}

          <DialogFooter>
            {erasure.step !== 'done' && (
              <Button variant="outline" disabled={erasure.busy} onClick={() => onOpenChange(false)} style={ghostStyle}>取消</Button>
            )}
            {erasure.step === 'impact' && blocked && (
              <Button disabled={erasure.busy} onClick={erasure.openPortal} style={dangerStyle}>管理订阅 / 取消续费</Button>
            )}
            {erasure.step === 'impact' && !blocked && (
              <Button disabled={!preview || erasure.busy} onClick={() => erasure.setStep('verify')} style={dangerStyle}>
                继续
              </Button>
            )}
            {erasure.step === 'verify' && (
              <Button disabled={erasure.busy} onClick={erasure.verify} style={dangerStyle}>验证身份</Button>
            )}
            {erasure.step === 'confirm' && (
              <Button disabled={!acknowledged || erasure.busy} onClick={erasure.confirm} style={dangerStyle}>
                {erasure.busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                确认注销
              </Button>
            )}
            {erasure.step === 'done' && (
              <Button disabled={erasure.busy} onClick={() => void erasure.finish()} style={dangerStyle}>退出登录并查看进度</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
