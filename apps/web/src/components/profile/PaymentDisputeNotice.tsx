/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { trpc } from '@/trpc/client';
export function PaymentDisputeNotice() {
  const notice = trpc.paymentDisputes.notice.useQuery(undefined, { refetchOnWindowFocus: true, staleTime: 30_000 });
  if (!notice.data?.frozen && !notice.data?.lost) return null;
  return <div className="mb-4 space-y-2 rounded-xl border p-4" style={{ borderColor: 'var(--border-primary)' }}>
    {notice.data.frozen ? <p role="status">这笔付款有支付争议，相关会员权益和积分暂停使用，有疑问请联系客服。</p> : null}
    {notice.data.lost ? <p role="status">你有一笔付款的支付争议已结案，这笔付款对应的会员权益和积分已收回，有疑问请联系客服。</p> : null}
  </div>;
}
