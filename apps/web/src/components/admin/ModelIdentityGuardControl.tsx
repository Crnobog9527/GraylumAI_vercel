/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { formatChangeTime, modelIdentityGuardError, stateLabel } from './modelIdentityGuardView';

/**
 * MODEL-IDENTITY-GUARD one-click switch. Saves on its own (not part of "保存所有设置").
 * Every change records the operator and time on the server; the page only shows read-back state.
 */
export function ModelIdentityGuardControl() {
  const utils = trpc.useUtils();
  const view = trpc.modelIdentity.get.useQuery(undefined, { refetchOnWindowFocus: true });
  const save = trpc.modelIdentity.set.useMutation();
  const [confirming, setConfirming] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const config = view.data?.config;

  async function apply(target: boolean) {
    if (!config) return;
    setConfirming(null);
    setNotice(null);
    setFailure(null);
    try {
      const result = await save.mutateAsync({ enabled: target, expectedRevision: config.revision });
      utils.modelIdentity.get.setData(undefined, result);
      setNotice(`模型身份保护${stateLabel(result.config.enabled)}（已回读确认）。`);
    } catch (error) {
      setFailure(modelIdentityGuardError(error as Parameters<typeof modelIdentityGuardError>[0], 'save'));
      void view.refetch();
    }
  }

  const changedAt = formatChangeTime(config?.updatedAt);
  return <Card data-testid="admin-model-identity-guard">
    <CardHeader>
      <CardTitle>模型身份保护</CardTitle>
      <CardDescription>
        开启时，用户看不到真实的模型品牌和型号，问到时统一回复品牌话术（Fusion 评审团除外）。
        关闭后页面恢复显示模型名称，但网页和服务器之间的数据里仍然不带模型的技术编号。
        本块单独保存，不包含在“保存所有设置”里。
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      {view.error && !config ? <div role="alert" className="space-y-2">
        <p>{modelIdentityGuardError(view.error, 'read')}</p>
        <Button variant="outline" onClick={() => { void view.refetch(); }}>重新读取</Button>
      </div> : !config ? <p>读取中…</p> : <>
        <p role="status" data-testid="model-identity-guard-state">当前状态：{stateLabel(config.enabled)}</p>
        <p className="text-sm text-muted-foreground" data-testid="model-identity-guard-last-change">
          {changedAt
            ? `最近一次修改：${view.data?.updatedByEmail ?? '未知账号'}，${changedAt}`
            : '还没有人修改过，使用默认设置（开启）。'}
        </p>
        <Button variant={config.enabled ? 'destructive' : 'default'} disabled={save.isPending}
          onClick={() => { setNotice(null); setFailure(null); setConfirming(!config.enabled); }}>
          {save.isPending ? '处理中…' : config.enabled ? '关闭身份保护' : '开启身份保护'}
        </Button>
        {(view.data?.history.length ?? 0) > 0 && <details>
          <summary className="cursor-pointer text-sm">最近的修改记录</summary>
          <ul className="mt-2 space-y-1 text-sm" data-testid="model-identity-guard-history">
            {view.data!.history.map(item => <li key={`${item.at}-${item.enabled}`}>
              {formatChangeTime(item.at) ?? item.at}：{item.operatorEmail ?? '未知账号'} {item.enabled ? '开启' : '关闭'}
            </li>)}
          </ul>
        </details>}
      </>}
      {notice && !failure && <p role="status">{notice}</p>}
      {failure && <p role="alert">{failure}</p>}
    </CardContent>
    <AlertDialog open={confirming !== null} onOpenChange={open => { if (!open) setConfirming(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirming ? '确认开启模型身份保护？' : '确认关闭模型身份保护？'}</AlertDialogTitle>
          <AlertDialogDescription>
            {confirming
              ? '开启后，之后发出的消息会统一使用品牌身份，页面不再显示模型名称。'
              : '关闭后，之后发出的消息不再加品牌身份说明，模型可能会说出自己的真实品牌；页面恢复显示模型名称。'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction onClick={() => { if (confirming !== null) void apply(confirming); }}>
            {confirming ? '确认开启' : '确认关闭'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Card>;
}
