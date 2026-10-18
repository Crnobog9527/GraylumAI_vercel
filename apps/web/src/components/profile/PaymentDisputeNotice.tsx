/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { trpc } from '@/trpc/client';
export function PaymentDisputeNotice() {
  const notice = trpc.paymentDisputes.notice.useQuery(undefined, { refetchOnWindowFocus: true, staleTime: 30_000 });
  if (!notice.data?.frozen) return null;
  return <p role="status" className="mb-4 rounded-xl border p-4" style={{ borderColor: 'var(--border-primary)' }}>
    这笔付款有支付争议，相关会员权益和积分暂停使用，有疑问请联系客服。
  </p>;
}
