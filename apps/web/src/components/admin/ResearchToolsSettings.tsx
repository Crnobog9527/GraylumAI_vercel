/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useEffect, useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { formatChangeTime } from './modelIdentityGuardView';
import {
  RESEARCH_VENDORS, VENDOR_LABELS, buildInput, enableBlockedReason, researchToolsError, sourceLabel, toDraft,
  type ResearchToolsDraft, type ResearchToolsView, type ResearchVendor,
} from './researchToolsDraft';

export interface ResearchToolsPanelProps {
  view: ResearchToolsView;
  draft: ResearchToolsDraft;
  onChange: (draft: ResearchToolsDraft) => void;
  onSave: () => void;
  saving: boolean;
  notice: string | null;
  failure: string | null;
}

function VendorRow({ view, draft, vendor, onChange, saving }: Omit<ResearchToolsPanelProps, 'onSave' | 'notice' | 'failure'> & { vendor: ResearchVendor }) {
  const label = VENDOR_LABELS[vendor];
  const blocked = enableBlockedReason(view, draft, vendor);
  const attested = view.config.vendors[vendor].hardCapAttested;
  const setVendor = (patch: Partial<ResearchToolsDraft['vendors'][ResearchVendor]>) =>
    onChange({ ...draft, vendors: { ...draft.vendors, [vendor]: { ...draft.vendors[vendor], ...patch } } });
  const switchId = `research-vendor-${vendor}`;
  return <div className="space-y-2 rounded-md border p-3" data-testid={`research-vendor-${vendor}-row`}>
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={switchId} className="font-medium">{label.name}<span className="ml-2 text-sm text-muted-foreground">{label.use}</span></label>
      <Switch id={switchId} data-testid={switchId} checked={draft.vendors[vendor].enabled}
        disabled={saving || (blocked !== null && !draft.vendors[vendor].enabled)}
        aria-describedby={blocked ? `${switchId}-reason` : undefined}
        onCheckedChange={checked => setVendor({ enabled: checked })} />
    </div>
    {blocked && <p id={`${switchId}-reason`} className="text-sm text-amber-600" data-testid={`${switchId}-blocked`}>{blocked}</p>}
    {attested
      ? <p className="text-sm text-muted-foreground" data-testid={`${switchId}-attested`}>
        已登记平台硬上限：{view.hardCapAttestedBy[vendor] ?? '未知账号'}，{formatChangeTime(attested.at) ?? attested.at}
      </p>
      : <label className="flex items-start gap-2 text-sm">
        <Checkbox data-testid={`${switchId}-attest`} checked={draft.vendors[vendor].attest} disabled={saving}
          onCheckedChange={checked => setVendor({ attest: checked === true, enabled: checked === true ? draft.vendors[vendor].enabled : false })} />
        <span>我确认已在 {label.name} 后台设好硬上限（预付余额或消费上限）。保存时会记录我的账号和时间。</span>
      </label>}
  </div>;
}

/** Presentational panel; the container below wires it to researchTools.get / set. */
export function ResearchToolsPanel(props: ResearchToolsPanelProps) {
  const { view, draft, onChange, onSave, saving, notice, failure } = props;
  const source = sourceLabel(view.source);
  const changedAt = formatChangeTime(view.updatedAt);
  return <div className="space-y-4">
    {source && <p role="status" className="text-sm text-amber-600" data-testid="research-tools-source">{source}</p>}
    <div className="flex items-center justify-between gap-3">
      <label htmlFor="research-tools-enabled" className="font-medium">联网搜索总开关</label>
      <Switch id="research-tools-enabled" data-testid="research-tools-enabled" checked={draft.enabled} disabled={saving}
        onCheckedChange={checked => onChange({ ...draft, enabled: checked })} />
    </div>
    {RESEARCH_VENDORS.map(vendor => <VendorRow key={vendor} vendor={vendor} view={view} draft={draft} onChange={onChange} saving={saving} />)}
    <details>
      <summary className="cursor-pointer text-sm">高级设置（已验证平台、对标平台、线路、调用上限）</summary>
      <p className="mt-2 text-sm text-muted-foreground">
        保存前服务器会完整检查：只接受已接入的线路，对标平台只能是能取到粉丝数和发布时间的平台。
      </p>
      <Textarea className="mt-2 font-mono text-xs" rows={14} data-testid="research-tools-advanced" value={draft.advanced} disabled={saving}
        onChange={event => onChange({ ...draft, advanced: event.target.value })} />
    </details>
    <Button data-testid="research-tools-save" disabled={saving} onClick={onSave}>{saving ? '保存中…' : '保存联网搜索设置'}</Button>
    <p className="text-sm text-muted-foreground" data-testid="research-tools-last-change">
      {changedAt ? `最近一次修改：${view.updatedByEmail ?? '未知账号'}，${changedAt}（版本 ${view.revision}）` : '还没有人修改过。'}
    </p>
    {!view.historyAvailable && <p className="text-sm text-muted-foreground">修改记录暂时读不到，不影响已保存的设置。</p>}
    {view.history.length > 0 && <details>
      <summary className="cursor-pointer text-sm">最近的修改记录</summary>
      <ul className="mt-2 space-y-1 text-sm" data-testid="research-tools-history">
        {view.history.map(item => <li key={`${item.at}-${item.revision}`}>
          {formatChangeTime(item.at) ?? item.at}：{item.operatorEmail ?? '未知账号'}，总开关{item.enabled ? '开' : '关'}
          {item.hardCapAttested.length > 0 ? `，登记硬上限：${item.hardCapAttested.join('、')}` : ''}
        </li>)}
      </ul>
    </details>}
    {notice && !failure && <p role="status" data-testid="research-tools-notice">{notice}</p>}
    {failure && <p role="alert" data-testid="research-tools-failure">{failure}</p>}
  </div>;
}

export function ResearchToolsSettings() {
  const utils = trpc.useUtils();
  const view = trpc.researchTools.get.useQuery(undefined, { refetchOnWindowFocus: false });
  const save = trpc.researchTools.set.useMutation();
  const [draft, setDraft] = useState<ResearchToolsDraft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const data = view.data as ResearchToolsView | undefined;
  useEffect(() => { if (data) setDraft(toDraft(data)); }, [data]);

  async function onSave() {
    if (!data || !draft) return;
    setNotice(null);
    setFailure(null);
    const built = buildInput(data, draft);
    if (!built.ok) { setFailure(built.error); return; }
    try {
      const result = await save.mutateAsync(built.input as never);
      utils.researchTools.get.setData(undefined, result);
      setNotice('联网搜索设置已保存（已回读确认）。');
    } catch (error) {
      setFailure(researchToolsError(error as Parameters<typeof researchToolsError>[0], 'save'));
      const reread = await view.refetch();
      if (reread.error) setFailure('保存没有成功，重新读取也失败了。请点“重新读取”拿到最新设置后再保存。');
    }
  }

  return <Card data-testid="admin-research-tools">
    <CardHeader>
      <CardTitle>联网搜索与社媒数据</CardTitle>
      <CardDescription>
        控制 TikHub、Parallel、Firecrawl 三家供应商。每家都要先在供应商后台设好硬上限并在这里登记，才能打开。
        本块单独保存，不包含在“保存所有设置”里。
      </CardDescription>
    </CardHeader>
    <CardContent>
      {view.error && !data ? <div role="alert" className="space-y-2">
        <p>{researchToolsError(view.error, 'read')}</p>
        <Button variant="outline" onClick={() => { void view.refetch(); }}>重新读取</Button>
      </div> : !data || !draft ? <p>读取中…</p> : <>
        {/* A failed reread keeps the cached data on screen; saving stays blocked until a fresh read. */}
        {view.error && <div role="alert" className="mb-3 space-y-2" data-testid="research-tools-stale">
          <p>{researchToolsError(view.error, 'read')} 当前显示的可能不是最新设置，读取成功前不能保存。</p>
          <Button variant="outline" onClick={() => { void view.refetch(); }}>重新读取</Button>
        </div>}
        <ResearchToolsPanel view={data} draft={draft} onChange={next => { setNotice(null); setDraft(next); }}
          onSave={() => { void onSave(); }}
          saving={save.isPending || Boolean(view.error)} notice={notice} failure={failure} />
      </>}
    </CardContent>
  </Card>;
}
