/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useRef, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { settingsErrorText, type FusionSettingsValue } from './fusionReviewSettingsView';

type CompareSettings = FusionSettingsValue['compare'];
const muted = { color: 'var(--text-tertiary)' };
const COMPARE_ERRORS: Record<string, string> = {
  FUSION_SETTINGS_INVALID: '对比设置不符合要求：默认勾选要在可选模型里，数量在最少勾选数和上限之间。',
  FUSION_COMPARE_OUTPUT_LIMIT: '有模型的回答上限比这里设的小，会被悄悄截短，请换模型或调低回答上限。',
  FUSION_COMPARE_LIMIT_EXCEEDED: '最少勾选数或默认组超过了上面的对比模型数量上限，请先调整。',
};
const errorText = (error: unknown) => {
  const code = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  return COMPARE_ERRORS[code] ?? settingsErrorText(error);
};
/** Local draft problems; the server re-checks everything, including that each allowed model passes the compare admission. */
export function compareDraftProblems(c: CompareSettings, maxModels: number): string[] {
  const problems: string[] = [];
  if (c.minModels < 2 || c.minModels > maxModels) problems.push(`最少勾选数要在 2 到 ${maxModels} 之间。`);
  if (c.defaultModelIds.some(id => !c.allowedModelIds.includes(id))) problems.push('默认勾选的模型必须在可选模型里。');
  if (c.defaultModelIds.length < c.minModels || c.defaultModelIds.length > maxModels) problems.push(`默认勾选要有 ${c.minModels} 到 ${maxModels} 个。`);
  if (c.enabled && !c.maxBudgetUsd) problems.push('开启对比前要填写单次最高预算。');
  return problems;
}

/**
 * 多模型对比设置（FUSION-COMPARE §3.3，Master Plan §4.5）：开关、可选模型（只列出通过对比准入的）、每次打开默认勾选哪几个、
 * 最少勾选数（Owner 2026-10-03：2 ≤ 最少 ≤ 上限）、每列回答上限、单次最高预算。整份 Fusion 设置一起保存（fusionSettings.update）。
 */
export function FusionCompareGroupSettings({ maxModels }: { maxModels: number }) {
  const settings = trpc.fusionSettings.get.useQuery(undefined, { staleTime: 0, retry: false });
  if (settings.isLoading) return <p style={muted}>正在读取对比设置…</p>;
  // A read failure is a status line, not an alert: this form sits inside the Fusion settings card, whose own read errors are the alert.
  if (!settings.data) return <p role="status" style={{ color: 'var(--color-destructive)' }}>对比设置：{settingsErrorText(settings.error)}</p>;
  return <CompareForm key={JSON.stringify(settings.data.compare)} saved={settings.data} maxModels={maxModels} onSaved={() => settings.refetch()} />;
}

function CompareForm({ saved, maxModels, onSaved }: { saved: FusionSettingsValue; maxModels: number; onSaved: () => Promise<unknown> }) {
  const [compare, setCompare] = useState<CompareSettings>(saved.compare);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const models = trpc.fusionSettings.models.useQuery(undefined, { staleTime: 0, retry: false });
  const update = trpc.fusionSettings.update.useMutation();
  const inFlight = useRef(false);
  const set = (patch: Partial<CompareSettings>) => { setCompare(value => ({ ...value, ...patch })); setNotice(null); };
  const usable = (models.data?.models ?? []).filter(model => model.compare);
  const problems = compareDraftProblems(compare, maxModels);
  const dirty = JSON.stringify(compare) !== JSON.stringify(saved.compare);
  const toggle = (list: string[], id: string) => list.includes(id) ? list.filter(value => value !== id) : [...list, id];

  async function save() {
    if (inFlight.current || !dirty || problems.length) return;
    inFlight.current = true;
    try {
      await update.mutateAsync({ ...saved, compare });
      setNotice({ ok: true, text: '已保存。新开始的对比使用这个设置，进行中的按开始时的设置完成。' });
      await onSaved();
    } catch (error) { setNotice({ ok: false, text: errorText(error) }); }
    finally { inFlight.current = false; }
  }

  return (
    <div className="space-y-4 border-t pt-4" style={{ borderColor: 'var(--border-primary)' }} data-testid="admin-settings-fusion-compare">
      <div className="flex items-center gap-3">
        <Switch id="fusion-compare-enabled" checked={compare.enabled} onCheckedChange={enabled => set({ enabled })} />
        <Label htmlFor="fusion-compare-enabled" style={{ color: 'var(--text-secondary)' }}>开启多模型对比（关掉后输入框不显示入口）</Label>
      </div>
      {models.error ? <p role="status" style={{ color: 'var(--color-destructive)' }}>模型列表读不到：测试窗口可能没开或已过期。</p> : null}
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>可选模型和默认勾选（用户看到的是这里的真实模型名）</legend>
        {usable.length === 0 && !models.isLoading ? <p style={muted}>还没有模型通过对比准入（需要对比用途的计费档案和报价）。</p> : null}
        {[...usable, ...compare.allowedModelIds.filter(id => !usable.some(model => model.id === id)).map(id => ({ id, name: `${id}（当前不可用）` }))]
          .map(model => (
            <div key={model.id} className="flex flex-wrap items-center gap-4 rounded-md border p-2" style={{ borderColor: 'var(--border-primary)' }}>
              <span className="min-w-0 flex-1 text-sm" style={{ overflowWrap: 'anywhere' }}>{model.name}</span>
              <label className="flex items-center gap-2 text-sm"><Checkbox checked={compare.allowedModelIds.includes(model.id)}
                onCheckedChange={() => { const allowed = toggle(compare.allowedModelIds, model.id);
                  set({ allowedModelIds: allowed, defaultModelIds: compare.defaultModelIds.filter(id => allowed.includes(id)) }); }} />可选</label>
              <label className="flex items-center gap-2 text-sm"><Checkbox checked={compare.defaultModelIds.includes(model.id)}
                disabled={!compare.allowedModelIds.includes(model.id)}
                onCheckedChange={() => set({ defaultModelIds: toggle(compare.defaultModelIds, model.id) })} />默认勾选</label>
            </div>
          ))}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5"><Label htmlFor="fusion-compare-min">每次最少勾选几个（2–{maxModels}）</Label>
          <Input id="fusion-compare-min" type="number" min={2} max={maxModels} value={compare.minModels}
            onChange={event => set({ minModels: Number(event.target.value) })} /></div>
        <div className="space-y-1.5"><Label htmlFor="fusion-compare-tokens">每列回答上限（token，含思考）</Label>
          <Input id="fusion-compare-tokens" type="number" min={512} max={32768} value={compare.answerOutputTokens}
            onChange={event => set({ answerOutputTokens: Number(event.target.value) })} /></div>
        <div className="space-y-1.5"><Label htmlFor="fusion-compare-budget">单次最高预算（美元）</Label>
          <Input id="fusion-compare-budget" inputMode="decimal" value={compare.maxBudgetUsd ?? ''}
            onChange={event => set({ maxBudgetUsd: event.target.value.trim() || null })} /></div>
      </div>
      {problems.length ? <ul className="text-sm" style={{ color: 'var(--color-destructive)' }}>{problems.map(text => <li key={text}>{text}</li>)}</ul> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void save()} disabled={!dirty || problems.length > 0 || update.isPending}>
          {update.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}保存对比设置</Button>
        {notice ? <p role={notice.ok ? 'status' : 'alert'} className="text-sm"
          style={{ color: notice.ok ? 'var(--text-secondary)' : 'var(--color-destructive)' }}>{notice.text}</p> : null}
      </div>
    </div>
  );
}
