/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import { Layers, Loader2, Save } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getSafeErrorMessage } from '@/lib/safe-error-message';
import { FUSION_COMPARE_MAX, FUSION_COMPARE_MIN, fusionCompareInput, readFusionCompareLimit } from './membershipEntitlementDraft';

export const FUSION_COMPARE_SETTING_KEY = 'fusion_compare_max_models';
const cardStyle = { background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' };

/**
 * Fusion 设置（D3）：对比模式最多可选的模型数，所有获准使用对比的等级共用。只存一份，
 * 在 system_settings 里；服务端单项和批量保存都限制为 2–8 的整数。
 * `onSaved` re-reads the settings dashboard and resolves false when that read failed.
 */
export function FusionCompareSetting({ saved, onSaved }: { saved: unknown; onSaved: () => Promise<boolean> }) {
  const current = readFusionCompareLimit(saved);
  const [draft, setDraft] = useState<string | null>(null);
  const [result, setResult] = useState<'read' | 'unread' | null>(null);
  const update = trpc.settings.updateSystemSettings.useMutation({
    onSuccess: async () => {
      const readBack = await onSaved();
      setDraft(null);
      setResult(readBack ? 'read' : 'unread');
    },
  });
  const text = draft ?? (current === null ? '' : String(current));
  const value = fusionCompareInput(text);
  const problem = draft !== null && value === null ? `须为 ${FUSION_COMPARE_MIN} 至 ${FUSION_COMPARE_MAX} 的整数` : null;
  return (
    <Card data-testid="admin-settings-fusion-section" style={cardStyle}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          <Layers className="h-5 w-5" style={{ color: 'var(--color-primary)' }} />
          Fusion 设置
        </CardTitle>
        <CardDescription style={{ color: 'var(--text-tertiary)' }}>
          对比模式里用户最多可以同时选择几个模型（最少 {FUSION_COMPARE_MIN} 个）。对所有允许使用对比模式的等级统一生效；
          评审模式的模型数量不受这里限制。Fusion 还没有上线，保存后在上线时生效。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <Label htmlFor="admin-setting-fusion-compare" style={{ color: 'var(--text-secondary)' }}>对比模型数量上限</Label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            id="admin-setting-fusion-compare"
            data-testid="admin-setting-fusion-compare"
            inputMode="numeric"
            value={text}
            placeholder="未配置"
            disabled={update.isPending}
            aria-invalid={Boolean(problem)}
            onChange={event => {
              setResult(null);
              if (update.error) update.reset();
              setDraft(event.target.value);
            }}
            className="w-full sm:max-w-[8rem]"
          />
          <Button
            data-testid="admin-setting-fusion-compare-save"
            size="sm"
            disabled={update.isPending || draft === null || value === null}
            onClick={() => { if (value !== null) update.mutate({ key: FUSION_COMPARE_SETTING_KEY, value }); }}
            className="w-full bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90 sm:w-auto"
          >
            {update.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Save className="mr-1 h-3 w-3" />}
            保存
          </Button>
        </div>
        <div className="text-xs" aria-live="polite">
          {problem ? <p role="alert" style={{ color: 'var(--error)' }}>{problem}</p>
            : update.error ? <p role="alert" style={{ color: 'var(--error)' }}>{update.error.data?.code === 'BAD_REQUEST'
              ? `服务端拒绝了这个值：须为 ${FUSION_COMPARE_MIN} 至 ${FUSION_COMPARE_MAX} 的整数。`
              : getSafeErrorMessage(update.error, '保存 Fusion 设置失败，请稍后重试')}</p>
            : draft !== null ? <p style={{ color: 'var(--text-tertiary)' }}>有未保存的修改</p>
            : result === 'read' ? <p role="status" style={{ color: 'var(--success)' }}>已保存并读回</p>
            : result === 'unread' ? <p role="alert" style={{ color: 'var(--error)' }}>已提交保存，但重新读取失败；请刷新页面确认当前值。</p>
            : current === null ? (
              <p role="alert" style={{ color: 'var(--error)' }}>
                当前没有有效的配置，Fusion 上线后新的对比请求会被拒绝；请填写并保存。
              </p>
            ) : <p style={{ color: 'var(--text-tertiary)' }}>当前值 {current}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
