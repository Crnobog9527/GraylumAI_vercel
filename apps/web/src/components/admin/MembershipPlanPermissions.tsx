/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import { Crown, Loader2, Save } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { getSafeErrorMessage } from '@/lib/safe-error-message';
import {
  describeBytes, mbTextToBytes, planDraftFromRow, planUpdateInput, storageProblem,
  type MembershipPlanRow, type PlanDraft,
} from './membershipEntitlementDraft';

const LEVEL_COLORS: Record<string, string> = {
  free: 'bg-gray-500/20 text-gray-400',
  pro: 'bg-blue-500/20 text-blue-400',
  gold: 'bg-amber-500/20 text-amber-400',
};
const cardStyle = { background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' };
const panelStyle = { background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)' };

function saveErrorText(error: { message: string; data?: { code?: string } | null }) {
  // Input validation failures are rejected by the server; its raw issue list is not shown here.
  return error.data?.code === 'BAD_REQUEST'
    ? '服务端拒绝了这些值：资料库空间须为不小于 0 的整数字节，请检查后重试。'
    : getSafeErrorMessage(error, '保存会员权限失败，请稍后重试');
}

type SwitchField = 'allowExport' | 'allowBatchExport' | 'allowFusionReview' | 'allowFusionCompare';
const SWITCHES: Array<{ field: SwitchField; label: string; testId: string }> = [
  { field: 'allowExport', label: '允许导出对话', testId: 'allow-export' },
  { field: 'allowBatchExport', label: '允许批量导出', testId: 'allow-batch-export' },
  { field: 'allowFusionReview', label: 'Fusion 评审模式', testId: 'allow-fusion-review' },
  { field: 'allowFusionCompare', label: 'Fusion 对比模式', testId: 'allow-fusion-compare' },
];

/**
 * 会员等级权限（ENTITLEMENTS PR-2）。每个等级单独保存；保存成功后从后台重新读取，
 * 页面只显示读回的值。这里的开关只是配置入口，是否允许使用由服务端判定。
 */
/** `onSaved` re-reads the settings dashboard and resolves false when that read failed. */
export function MembershipPlanPermissions({ plans, onSaved }: { plans: MembershipPlanRow[]; onSaved: () => Promise<boolean> }) {
  return (
    <Card data-testid="admin-settings-membership-section" style={cardStyle}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          <Crown className="h-5 w-5 text-amber-500" />
          会员等级权限配置
        </CardTitle>
        <CardDescription style={{ color: 'var(--text-tertiary)' }}>
          配置各会员等级的导出权限、Fusion 模式和资料库总空间
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-4 space-y-2 rounded-lg p-4 text-sm" style={panelStyle}>
          <p style={{ color: 'var(--text-secondary)' }}>
            套餐价格、积分发放和 Stripe Price ID 在
            <a href="/admin/packages" className="ml-1 underline hover:no-underline" style={{ color: 'var(--color-primary)' }}>套餐管理</a>
            维护；这里只配置会员权限。
          </p>
          <p data-testid="membership-entitlements-not-live" style={{ color: 'var(--text-secondary)' }}>
            Fusion 评审 / 对比和资料库上传还没有上线：这里保存的是这些功能上线后各等级的权限，现在保存不会让用户看到或用上它们。
            修改只影响之后新发起的操作，进行中的不受影响。
          </p>
        </div>
        {plans.length === 0 ? (
          <div className="rounded-lg p-6 text-center" style={{ background: 'var(--bg-tertiary)', border: '1px dashed var(--border-primary)' }}>
            <Crown className="mx-auto mb-4 h-12 w-12 text-amber-500 opacity-50" />
            <p style={{ color: 'var(--text-secondary)' }}>暂无会员套餐，请先在「套餐管理」中创建会员套餐</p>
          </div>
        ) : (
          <div className="space-y-6">
            {plans.map(plan => <PlanPermissionRow key={plan.id} plan={plan} onSaved={onSaved} />)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PlanPermissionRow({ plan, onSaved }: { plan: MembershipPlanRow; onSaved: () => Promise<boolean> }) {
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [saved, setSaved] = useState(false);
  // Saved, but the read-back failed: the row keeps the saved values and stays locked until a read
  // succeeds, so a later edit cannot resubmit the old snapshot and silently undo the save.
  const [unread, setUnread] = useState(false);
  const [rereading, setRereading] = useState(false);
  const readBack = async () => {
    const ok = await onSaved();
    if (ok) setDraft(null);
    setUnread(!ok);
    setSaved(ok);
  };
  const update = trpc.admin.updateMembershipPlan.useMutation({ onSuccess: readBack });
  const reread = async () => {
    setRereading(true);
    try { await readBack(); } finally { setRereading(false); }
  };
  const locked = update.isPending || unread || rereading;
  const view = draft ?? planDraftFromRow(plan);
  const problem = storageProblem(view);
  const bytes = mbTextToBytes(view.storageMb);
  const edit = (next: Partial<PlanDraft>) => {
    setSaved(false);
    if (update.error) update.reset();
    setDraft({ ...view, ...next });
  };
  const save = () => {
    const input = planUpdateInput(plan.id, view);
    if (input) update.mutate(input);
  };
  const id = `membership-plan-${plan.level}`;
  return (
    <div data-testid={id} className="rounded-lg p-4" style={panelStyle}>
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <Badge className={LEVEL_COLORS[plan.level] || 'bg-gray-500/20 text-gray-400'}>{plan.level.toUpperCase()}</Badge>
          <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{plan.name}</span>
        </div>
        <Button
          data-testid={`membership-plan-save-${plan.level}`}
          size="sm"
          onClick={save}
          disabled={locked || !draft || Boolean(problem)}
          className="w-full bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90 md:w-auto"
        >
          {update.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Save className="mr-1 h-3 w-3" />}
          保存
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {SWITCHES.map(({ field, label, testId }) => (
          <div key={field} className="flex items-center justify-between gap-3 md:justify-start">
            <Label htmlFor={`${id}-${testId}`} className="text-sm" style={{ color: 'var(--text-secondary)' }}>{label}</Label>
            <div className="flex items-center gap-2">
              <Switch
                id={`${id}-${testId}`}
                data-testid={`${id}-${testId}`}
                checked={view[field]}
                disabled={locked}
                onCheckedChange={checked => edit({ [field]: checked })}
              />
              <span className="w-12 text-sm" style={{ color: view[field] ? 'var(--success)' : 'var(--text-disabled)' }}>
                {view[field] ? '已启用' : '已禁用'}
              </span>
            </div>
          </div>
        ))}
        <div className="space-y-1 md:col-span-2">
          <Label htmlFor={`${id}-storage`} className="text-sm" style={{ color: 'var(--text-secondary)' }}>资料库总空间（MB，1 MB = 1,000,000 字节）</Label>
          <Input
            id={`${id}-storage`}
            data-testid={`${id}-storage`}
            inputMode="decimal"
            value={view.storageMb}
            disabled={locked}
            aria-invalid={Boolean(problem)}
            onChange={event => edit({ storageMb: event.target.value })}
            className="w-full md:max-w-xs"
          />
          <p className="text-xs" role={problem ? 'alert' : undefined} style={{ color: problem ? 'var(--error)' : 'var(--text-tertiary)' }}>
            {problem ?? `= ${describeBytes(bytes ?? 0)}`}
          </p>
        </div>
      </div>
      <div className="mt-3 text-xs" aria-live="polite">
        {unread ? (
          <div role="alert" className="flex flex-wrap items-center gap-2" style={{ color: 'var(--error)' }}>
            <span>已提交保存，但重新读取失败。为避免用旧值覆盖，这一行暂时不能修改。</span>
            <Button data-testid={`${id}-reread`} size="sm" variant="outline" disabled={rereading} onClick={() => void reread()}>
              {rereading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
              重新读取
            </Button>
          </div>
        ) : update.error ? (
          <p role="alert" style={{ color: 'var(--error)' }}>{saveErrorText(update.error)}</p>
        ) : draft ? (
          <p style={{ color: 'var(--text-tertiary)' }}>有未保存的修改</p>
        ) : saved ? (
          <p role="status" style={{ color: 'var(--success)' }}>已保存并读回</p>
        ) : null}
      </div>
    </div>
  );
}
