/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { formatChangeTime } from './modelIdentityGuardView';
import {
  clearWarning, platformSecretError, REPLACE_NOTE, SLOT_INFO, sourceLabel,
  type PlatformSecretItem, type PlatformSecretSlot,
} from './platformSecretsView';

export interface PlatformSecretRowProps {
  item: PlatformSecretItem;
  draft: string;
  pending: boolean;
  notice: string | null;
  failure: string | null;
  onDraft: (value: string) => void;
  onSave: () => void;
  onClear: () => void;
}

/** One key. The input is never prefilled: nothing on this page can read a stored key back. */
export function PlatformSecretRow({ item, draft, pending, notice, failure, onDraft, onSave, onClear }: PlatformSecretRowProps) {
  const info = SLOT_INFO[item.slot];
  const changedAt = formatChangeTime(item.updatedAt);
  return <div className="space-y-2 border-b py-4 last:border-b-0" data-testid={`platform-secret-${item.slot}`}>
    <div>
      <p className="font-medium">{info.name}</p>
      <p className="text-sm text-muted-foreground">用于：{info.usage}</p>
    </div>
    <p role="status" data-testid={`platform-secret-${item.slot}-source`}>{sourceLabel(item)}</p>
    {changedAt && <p className="text-sm text-muted-foreground">
      最近一次修改：{item.updatedByEmail ?? '系统'}，{changedAt}
    </p>}
    <form className="flex flex-wrap items-center gap-2" autoComplete="off"
      onSubmit={event => { event.preventDefault(); if (!pending && draft.trim()) onSave(); }}>
      <Input type="password" autoComplete="new-password" spellCheck={false} className="max-w-md"
        aria-label={`${info.name} 新密钥`} data-testid={`platform-secret-${item.slot}-input`}
        placeholder={item.configured ? '输入新密钥以替换' : `粘贴密钥${info.hint ? `（${info.hint}）` : ''}`}
        value={draft} onChange={event => onDraft(event.target.value)} disabled={pending} />
      <Button type="submit" disabled={pending || !draft.trim()}>
        {pending ? '处理中…' : item.configured ? '替换' : '保存'}
      </Button>
      {item.configured && <Button type="button" variant="outline" disabled={pending} onClick={onClear}>清除</Button>}
    </form>
    {item.configured && REPLACE_NOTE[item.slot] && <p className="text-sm text-muted-foreground">{REPLACE_NOTE[item.slot]}</p>}
    {notice && !failure && <p role="status">{notice}</p>}
    {failure && <p role="alert">{failure}</p>}
  </div>;
}

export function PlatformSecretsSettings() {
  const utils = trpc.useUtils();
  const view = trpc.platformSecrets.status.useQuery(undefined, { refetchOnWindowFocus: true });
  const save = trpc.platformSecrets.set.useMutation();
  const clear = trpc.platformSecrets.clear.useMutation();
  const [drafts, setDrafts] = useState<Partial<Record<PlatformSecretSlot, string>>>({});
  const running = useRef(false);
  const [busy, setBusy] = useState<PlatformSecretSlot | null>(null);
  const [messages, setMessages] = useState<Partial<Record<PlatformSecretSlot, { notice?: string; failure?: string }>>>({});
  const [confirmClear, setConfirmClear] = useState<PlatformSecretItem | null>(null);

  async function run(item: PlatformSecretItem, action: 'save' | 'clear') {
    if (running.current) return;
    running.current = true;
    setBusy(item.slot);
    setMessages(m => ({ ...m, [item.slot]: {} }));
    try {
      const result = action === 'save'
        ? await save.mutateAsync({ slot: item.slot, value: drafts[item.slot] ?? '', expectedRevision: item.revision })
        : await clear.mutateAsync({ slot: item.slot, expectedRevision: item.revision });
      utils.platformSecrets.status.setData(undefined, result);
      const next = result.slots.find(s => s.slot === item.slot);
      setMessages(m => ({ ...m, [item.slot]: { notice: result.statusRefreshFailed
        ? `已${action === 'save' ? '保存' : '清除'}，但操作人信息刷新失败，请刷新页面。` : action === 'save'
        ? `已保存，末 4 位 ${next?.last4 ?? ''}（1 分钟内全站生效）。` : '已清除（1 分钟内全站生效）。' } }));
    } catch (error) {
      setMessages(m => ({ ...m, [item.slot]: { failure: platformSecretError(error as never, action) } }));
      void view.refetch();
    } finally {
      // The typed key leaves the page whatever the outcome.
      setDrafts(d => ({ ...d, [item.slot]: '' }));
      running.current = false;
      setBusy(null);
    }
  }

  return <Card data-testid="admin-platform-secrets">
    <CardHeader>
      <CardTitle>第三方密钥</CardTitle>
      <CardDescription>
        模型、搜索和发布服务的密钥。保存后加密存放，任何人都不能在这里看到原文，只显示最后 4 位；
        每次保存、替换、清除都会记录操作人和时间。数据库、支付等系统密钥仍在 Vercel 设置，不在这里。
      </CardDescription>
    </CardHeader>
    <CardContent>
      {view.error && !view.data ? <div role="alert" className="space-y-2">
        <p>{platformSecretError(view.error, 'read')}</p>
        <Button variant="outline" onClick={() => { void view.refetch(); }}>重新读取</Button>
      </div> : !view.data ? <p>读取中…</p> : view.data.slots.map(item => <PlatformSecretRow key={item.slot} item={item}
        draft={drafts[item.slot] ?? ''} pending={busy !== null}
        notice={messages[item.slot]?.notice ?? null} failure={messages[item.slot]?.failure ?? null}
        onDraft={value => setDrafts(d => ({ ...d, [item.slot]: value }))}
        onSave={() => { void run(item, 'save'); }} onClear={() => setConfirmClear(item)} />)}
    </CardContent>
    <AlertDialog open={confirmClear !== null} onOpenChange={open => { if (!open) setConfirmClear(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认清除 {confirmClear ? SLOT_INFO[confirmClear.slot].name : ''} 密钥？</AlertDialogTitle>
          <AlertDialogDescription>{confirmClear ? clearWarning(confirmClear) : ''}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction onClick={() => { const item = confirmClear; setConfirmClear(null); if (item) void run(item, 'clear'); }}>
            确认清除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Card>;
}
