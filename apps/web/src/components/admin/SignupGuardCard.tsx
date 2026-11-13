'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useState } from 'react';
import { Loader2, Save, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { getSafeErrorMessage } from '@/lib/safe-error-message';
import {
  draftFrom, needsPauseConfirm, parseSignupGuardDraft, PAUSE_CONFIRM_TEXT, type SignupGuardDraft, type SignupGuardSettings,
} from './signupGuardDraft';

const cardStyle = { background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' };
type Refused = { today: number; last7Days: number };
export type SignupGuardView = {
  day: string; granted: number; settings: SignupGuardSettings;
  refused: { paused: Refused; sameIp: Refused; dailyCap: Refused };
};

/**
 * BOT-GUARD (Owner 2026-11-13): «注册赠送防刷». Today's grants, the three rules, and what they refused (read only),
 * saved together through admin.updateSignupGuard; the database applies a save to the very next sign-up.
 */
export function SignupGuardCard() {
  const query = trpc.admin.getSignupGuard.useQuery(undefined, { retry: false, refetchOnWindowFocus: false });
  const save = trpc.admin.updateSignupGuard.useMutation({ retry: false });
  const [draft, setDraft] = useState<SignupGuardDraft | null>(null);
  const saved = query.data?.settings;
  useEffect(() => { if (saved) setDraft(draftFrom(saved)); }, [saved]);

  const onSave = async () => {
    if (!draft || !saved) return;
    const parsed = parseSignupGuardDraft(draft);
    if (!parsed.ok) { toast.error(parsed.message); return; }
    if (needsPauseConfirm(saved, parsed.value) && !window.confirm(PAUSE_CONFIRM_TEXT)) return;
    try {
      const result = await save.mutateAsync(parsed.value);
      toast.success(result.auditRecorded ? '已保存，下一个注册的账号就按新规则' : '已保存（操作记录没有写上，请留意）');
      await query.refetch();
    } catch (error) {
      toast.error(getSafeErrorMessage(error, '保存失败，请稍后重试'));
    }
  };

  return (
    <Card className="mb-6" style={cardStyle} data-testid="admin-signup-guard">
      <CardHeader>
        <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          <ShieldCheck className="h-5 w-5" /> 注册赠送防刷
        </CardTitle>
        <CardDescription style={{ color: 'var(--text-tertiary)' }}>
          新账号开户送积分的三条规则。没送到的账号以后也不会补发，用户在积分记录里能看到原因。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {query.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
        {query.error && <p className="text-sm" style={{ color: 'var(--warning)' }}>读取失败，请刷新页面重试。</p>}
        {query.data && draft && (
          <div className="space-y-5">
            <SignupGuardSummary view={query.data} />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="signup-guard-cap" style={{ color: 'var(--text-primary)' }}>每日赠送上限（北京时间每天）</Label>
                <Input id="signup-guard-cap" inputMode="numeric" value={draft.dailyCap}
                  onChange={event => setDraft({ ...draft, dailyCap: event.target.value })} />
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>0 到 100000；填 0 表示今天一律不送。</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="signup-guard-ip" style={{ color: 'var(--text-primary)' }}>同一网络 24 小时内最多送几个号</Label>
                <Input id="signup-guard-ip" inputMode="numeric" value={draft.ipLimit}
                  onChange={event => setDraft({ ...draft, ipLimit: event.target.value })} />
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>1 到 50；家庭、公司、校园网常常共用一个网络。</p>
              </div>
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="signup-guard-paused" style={{ color: 'var(--text-primary)' }}>暂停注册赠送</Label>
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>发现有人刷号时打开：新账号一律不送，保存前会再确认一次。</p>
              </div>
              <Switch id="signup-guard-paused" checked={draft.paused} onCheckedChange={paused => setDraft({ ...draft, paused })} />
            </div>
            <Button onClick={onSave} disabled={save.isPending}>
              {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} 保存防刷规则
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function SignupGuardSummary({ view }: { view: SignupGuardView }) {
  const { settings, refused } = view;
  const rows: [string, Refused][] = [['暂停中', refused.paused], ['同一网络超过上限', refused.sameIp], ['当天送完了', refused.dailyCap]];
  return (
    <div className="space-y-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
      <p data-testid="admin-signup-guard-today">
        今天（北京时间 {view.day}）已送 {view.granted} / 上限 {settings.dailyCap}
        {settings.paused ? '，注册赠送已暂停，新账号一律不送' : settings.dailyCap === 0 ? '，上限为 0，今天新账号一律不送' : ''}。
      </p>
      <table className="w-full text-left text-xs" data-testid="admin-signup-guard-refused">
        <thead><tr><th className="py-1 font-medium">没送的原因</th><th className="py-1 font-medium">今天</th><th className="py-1 font-medium">近 7 天</th></tr></thead>
        <tbody>
          {rows.map(([label, count]) => (
            <tr key={label}><td className="py-1">{label}</td><td className="py-1">{count.today}</td><td className="py-1">{count.last7Days}</td></tr>
          ))}
        </tbody>
      </table>
      {refused.sameIp.today > 0 && (
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          「同一网络超过上限」多的话，可能误伤了共用网络的正常用户，可以把上面的数调大。
        </p>
      )}
    </div>
  );
}
