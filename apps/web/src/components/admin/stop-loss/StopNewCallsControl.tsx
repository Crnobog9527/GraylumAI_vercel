/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { stopLossErrorMessage } from './stopLossFormat';

/**
 * Site-wide emergency stop for new model calls (runtime_rate_limits.stopNewCalls).
 * The dedicated endpoint changes only the flag in one database transaction, so it never
 * touches the rate limits. Resuming is only possible here.
 */
export function StopNewCallsControl() {
  const utils = trpc.useUtils();
  const view = trpc.runtimeRateLimits.get.useQuery(undefined, { refetchOnMount: 'always' });
  const setStop = trpc.runtimeRateLimits.setStopNewCalls.useMutation();
  const [confirming, setConfirming] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const stopped = view.data?.config.stopNewCalls;

  async function apply(target: boolean) {
    setConfirming(null);
    setBusy(true);
    setNotice(null);
    setFailure(null);
    try {
      const result = await setStop.mutateAsync({ stopped: target });
      utils.runtimeRateLimits.get.setData(undefined, prev => prev && { ...prev, ...result });
      void utils.runtimeRateLimits.get.invalidate();
      // The message always follows the server read-back, never the requested value.
      setNotice(result.config.stopNewCalls
        ? '已停止新的模型调用（已回读确认）。已经开始的调用会按原流程结算。'
        : '已恢复新的模型调用（已回读确认）。');
    } catch (error) {
      setFailure(stopLossErrorMessage(error as Parameters<typeof stopLossErrorMessage>[0], 'save'));
    } finally { setBusy(false); }
  }

  return <section aria-labelledby="stop-new-calls-title" className="space-y-3 rounded-md border p-4">
    <h3 id="stop-new-calls-title" className="font-medium">紧急停止新的模型调用</h3>
    <p className="text-sm">
      停止后，全站新的模型调用都会被拒绝，用户会看到“AI 服务已暂停新调用”的提示；
      已经发出的调用照常结算，不会被取消。恢复需要在这里手动操作。
    </p>
    {view.error ? <div role="alert" className="space-y-2">
      <p>{stopLossErrorMessage(view.error, 'read')}</p>
      <Button variant="outline" onClick={() => { void view.refetch(); }}>重新读取</Button>
    </div> : stopped === undefined ? <p>读取中…</p> : <>
      <p role="status" data-testid="stop-new-calls-state">
        当前状态：{stopped ? '已停止新调用' : '正常运行'}
      </p>
      <Button variant={stopped ? 'outline' : 'destructive'} disabled={busy}
        onClick={() => { setNotice(null); setFailure(null); setConfirming(!stopped); }}>
        {busy ? '处理中…' : stopped ? '恢复新调用' : '停止新调用'}
      </Button>
    </>}
    {notice && !failure && <p role="status">{notice}</p>}
    {failure && <div role="alert" className="space-y-2">
      <p>{failure}</p>
      <Button variant="outline" onClick={() => { setFailure(null); void view.refetch(); }}>重新读取</Button>
    </div>}
    <AlertDialog open={confirming !== null} onOpenChange={open => { if (!open) setConfirming(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirming ? '确认停止全站新的模型调用？' : '确认恢复新的模型调用？'}</AlertDialogTitle>
          <AlertDialogDescription>
            {confirming
              ? '确认后所有用户都无法发起新的模型调用，直到有人在这里点“恢复新调用”。'
              : '确认后用户可以重新发起模型调用，每日美元上限（如已设置）仍然生效。'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction onClick={() => { if (confirming !== null) void apply(confirming); }}>
            {confirming ? '确认停止' : '确认恢复'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>;
}
