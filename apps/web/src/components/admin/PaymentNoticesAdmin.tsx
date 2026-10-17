/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { formatChangeTime } from './modelIdentityGuardView';
import {
  KIND_LABEL, paymentNoticeError, RESEND_NOTE, resendOutcomeLabel, stateLabel, type PaymentNoticeItem,
} from './paymentNoticesView';

export function PaymentNoticeRow({ item, pending, onResend }: {
  item: PaymentNoticeItem; pending: boolean; onResend: () => void;
}) {
  return <div className="space-y-1 border-b py-3 last:border-b-0" data-testid={`payment-notice-${item.id}`}>
    <p className="font-medium">{KIND_LABEL[item.kind] ?? item.kind}</p>
    <p className="text-sm text-muted-foreground">
      收件人：{item.userEmail ?? '（无邮箱）'}；第一次发送：{formatChangeTime(item.firstAttemptAt) ?? '尚未发送'}；已尝试 {item.attempts} 次
    </p>
    <p role="status">{stateLabel(item)}</p>
    {item.lastErrorCode && <p className="text-sm text-muted-foreground">错误码：{item.lastErrorCode}</p>}
    {item.resendable && <Button type="button" variant="outline" size="sm" disabled={pending} onClick={onResend}
      data-testid={`payment-notice-${item.id}-resend`}>用同一编号重新发送</Button>}
  </div>;
}

export function PaymentNoticesAdmin() {
  const list = trpc.paymentNotices.list.useQuery(undefined, { refetchOnWindowFocus: true });
  const resend = trpc.paymentNotices.resend.useMutation();
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ notice?: string; failure?: string }>({});
  const [confirm, setConfirm] = useState<PaymentNoticeItem | null>(null);

  async function run(item: PaymentNoticeItem) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage({});
    try {
      const result = await resend.mutateAsync({ id: item.id });
      setMessage({ notice: resendOutcomeLabel(result.outcome) });
    } catch (error) {
      setMessage({ failure: paymentNoticeError(error as never, 'resend') });
    } finally {
      running.current = false;
      setBusy(false);
      void list.refetch();
    }
  }

  return <Card data-testid="admin-payment-notices">
    <CardHeader>
      <CardTitle>付款提醒邮件</CardTitle>
      <CardDescription>
        这里只列出需要人工处理的提醒邮件：发送结果不确定、多次失败或转人工的记录。发送正常的不显示。{RESEND_NOTE}
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-2">
      {message.notice && <p role="status">{message.notice}</p>}
      {message.failure && <p role="alert">{message.failure}</p>}
      {list.error && !list.data ? <div role="alert" className="space-y-2">
        <p>{paymentNoticeError(list.error, 'read')}</p>
        <Button variant="outline" onClick={() => { void list.refetch(); }}>重新读取</Button>
      </div> : !list.data ? <p>读取中…</p> : list.data.items.length === 0
        ? <p data-testid="payment-notices-empty">目前没有需要处理的提醒邮件。</p>
        : list.data.items.map(item => <PaymentNoticeRow key={item.id} item={item} pending={busy}
          onResend={() => setConfirm(item)} />)}
    </CardContent>
    <AlertDialog open={confirm !== null} onOpenChange={open => { if (!open) setConfirm(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认重新发送这封提醒？</AlertDialogTitle>
          <AlertDialogDescription>{RESEND_NOTE}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction onClick={() => { const item = confirm; setConfirm(null); if (item) void run(item); }}>
            重新发送
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Card>;
}
