/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

const cardStyle = { background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' };
const muted = { color: 'var(--text-tertiary)' };
const CAP = /^(0|[1-9]\d{0,3})(\.\d{1,6})?$/;

const ERRORS: Record<string, string> = {
  PUBLISH_MONITOR_REVIEW_MODEL_UNAVAILABLE: '这个模型不存在、已停用，或者不是可用的服务商，请换一个。',
};
const errorText = (error: unknown) => {
  const code = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  return ERRORS[code] ?? '暂时无法读取或保存复盘设置，请稍后再试。';
};

type Saved = { enabled: boolean; modelId: string | null; maxCostUsd: string };

/**
 * 每周复盘设置（PUBLISH-MONITOR PR-6 后端，PR-7 页面；方案第 5.3 节）：开关、复盘用的模型、每次花费上限（美元）。
 * 不选模型时沿用对话模型。服务端会再校验模型；保存后新开始的复盘使用新设置。
 */
export function PublishMonitorReviewSettings() {
  const settings = trpc.publishMonitor.review.adminSettings.useQuery(undefined, { staleTime: 0, retry: false });
  if (settings.isLoading) return <Shell><p style={muted}>正在读取复盘设置…</p></Shell>;
  if (!settings.data) {
    return (
      <Shell>
        <p role="alert" style={{ color: 'var(--color-destructive)' }}>{errorText(settings.error)}</p>
        <Button variant="outline" onClick={() => void settings.refetch()}>重新读取</Button>
      </Shell>
    );
  }
  return <Shell><Form key={JSON.stringify(settings.data)} saved={settings.data} onSaved={() => settings.refetch()} /></Shell>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <Card data-testid="admin-publish-monitor-review" style={cardStyle}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          <BarChart3 className="h-5 w-5" style={{ color: 'var(--color-primary)' }} />每周复盘
        </CardTitle>
        <CardDescription style={muted}>
          Gold 用户的每周自动复盘和数据复盘页的“每周复盘”。关掉后不再启动新的复盘；花费上限是每次复盘最多花多少美元，
          填 0 时不会启动收费复盘。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function Form({ saved, onSaved }: { saved: Saved; onSaved: () => Promise<unknown> }) {
  const [enabled, setEnabled] = useState(saved.enabled);
  const [modelId, setModelId] = useState(saved.modelId ?? '');
  const [cap, setCap] = useState(saved.maxCostUsd);
  const [notice, setNotice] = useState('');
  const models = trpc.settings.getSummaryModels.useQuery({ use: 'skill' }, { retry: false });
  const save = trpc.publishMonitor.review.saveAdminSettings.useMutation();
  const capValid = CAP.test(cap);
  async function submit() {
    setNotice('');
    await save.mutateAsync({ enabled, modelId: modelId || null, maxCostUsd: cap });
    setNotice('已保存');
    await onSaved();
  }
  return (
    <>
      <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
        <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="开启每周复盘" />开启每周复盘
      </label>
      <label className="block space-y-1 text-sm" style={{ color: 'var(--text-primary)' }}>
        <span>复盘用的模型</span>
        <select aria-label="复盘用的模型" className="h-9 w-full rounded-md border px-2"
          style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-primary)' }}
          value={modelId} onChange={event => setModelId(event.target.value)}>
          <option value="">沿用对话模型</option>
          {(models.data ?? []).map(m => <option key={m.id} value={m.id} disabled={!m.available && m.id !== modelId}>
            {m.name}{m.available ? '' : `（${m.reason}）`}</option>)}
        </select>
      </label>
      <label className="block space-y-1 text-sm" style={{ color: 'var(--text-primary)' }}>
        <span>每次复盘花费上限（美元）</span>
        <Input aria-label="每次复盘花费上限（美元）" inputMode="decimal" value={cap} onChange={event => setCap(event.target.value.trim())} />
        {!capValid && <span role="alert" style={{ color: 'var(--color-destructive)' }}>请填 0 到 9999 之间的数字，最多 6 位小数。</span>}
      </label>
      {save.error && <p role="alert" style={{ color: 'var(--color-destructive)' }}>{errorText(save.error)}</p>}
      {notice && <p role="status" style={{ color: 'var(--success)' }}>{notice}</p>}
      <Button disabled={!capValid || save.isPending} onClick={() => void submit().catch(() => undefined)}>保存</Button>
    </>
  );
}
