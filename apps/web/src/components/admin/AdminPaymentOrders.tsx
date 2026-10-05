/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import AdminErrorState from '@/components/admin/AdminErrorState';
import { getBillingRecordStatusPresentation } from '@/components/profile/billingRecordStatus';
import { AmountFactList, DocumentStatusBadge, PaymentDocumentLinks } from '@/components/payments/PaymentDocumentLinks';
import {
  ADMIN_REQUIRED_FACT_KINDS, buildAmountFactRows, formatMinorAmount, getPaymentChannelLabel, type AmountFact,
} from '@/lib/payment-display';
import {
  adminOrdersPageCount, adminOrdersPageInput, getBillingCycleLabel, getItemTypeLabel, getPaymentModeLabel,
  getPaymentStatusLabel,
} from './adminOrderView';

function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

/** 后台支付订单（PAY-COMMON PR-3）：只显示接口返回的字段，不含用户资料。 */
export function AdminPaymentOrders() {
  const [page, setPage] = useState(0);
  const input = adminOrdersPageInput(page);
  const { data, error, isLoading, isFetching, refetch } = trpc.payments.listAdminOrders.useQuery(input, { retry: false });

  if (error && !data) return <AdminErrorState error={error} onRetry={() => void refetch()} />;
  const total = data?.total ?? 0;
  const pageCount = adminOrdersPageCount(total, input.limit);

  return (
    <div className="space-y-6 p-4 md:p-8">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl" style={{ color: 'var(--text-primary)' }}>支付订单</h1>
        <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
          所有用户的购买订单，按下单时间从新到旧 · 共 {total.toLocaleString()} 笔
        </p>
      </div>

      {isLoading ? (
        <p className="py-8 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>正在加载订单…</p>
      ) : (data?.items.length ?? 0) === 0 ? (
        <p data-testid="admin-orders-empty" className="py-8 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
          还没有订单
        </p>
      ) : (
        <div className="space-y-3" data-testid="admin-orders-list">
          {data?.items.map(order => {
            const status = getBillingRecordStatusPresentation(order.status);
            return (
              <div key={order.id} data-testid="admin-order-row" className="rounded-xl border p-4"
                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}>
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
                      <span className="font-semibold">{getItemTypeLabel(order.itemType)}</span>
                      <span style={{ color: 'var(--text-tertiary)' }}>{getBillingCycleLabel(order.billingCycle)}</span>
                      <span className="rounded-full px-2.5 py-1 text-xs font-medium"
                        style={{ background: status.background, color: status.color }}>{status.label}</span>
                      <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        {getPaymentStatusLabel(order.paymentStatus)}
                      </span>
                      <DocumentStatusBadge status={order.documentStatus} />
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
                      <span>{formatMinorAmount(order.amountMinor, order.currency)}</span>
                      <span>{getPaymentChannelLabel(order.paymentChannelLabel)} · {getPaymentModeLabel(order.paymentMode)}</span>
                      <span>下单 {formatDate(order.createdAt)}</span>
                      <span>到账 {formatDate(order.fulfilledAt)}</span>
                      {order.invoiceNumber && <span>发票号 {order.invoiceNumber}</span>}
                    </div>
                    <AmountFactList testId="admin-order-amount-facts" rows={buildAmountFactRows(order.amountFacts as AmountFact[],
                      { required: ADMIN_REQUIRED_FACT_KINDS })} />
                    <p className="break-all font-mono text-xs" style={{ color: 'var(--text-disabled)' }}>订单 {order.id}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <PaymentDocumentLinks record={order} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 text-sm" style={{ color: 'var(--text-tertiary)' }}>
        <span>第 {page + 1} / {pageCount} 页</span>
        <Button size="sm" variant="outline" aria-label="上一页" disabled={page === 0 || isFetching}
          onClick={() => setPage(value => Math.max(0, value - 1))}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="outline" aria-label="下一页" disabled={page + 1 >= pageCount || isFetching}
          onClick={() => setPage(value => value + 1)}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      {error && data ? (
        <p role="alert" className="text-sm" style={{ color: 'var(--error)' }}>刷新订单失败，下面显示的是上一次读到的内容。</p>
      ) : null}
    </div>
  );
}
