'use client';

import { ExternalLink, FileText, Receipt, ScrollText } from 'lucide-react';
import { trpc } from '@/trpc/client';

function formatMoney(amount: number, currency: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(amount);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export default function BillingRecordsCard() {
  const { data: records = [], isLoading } = trpc.payments.listBillingRecords.useQuery();

  return (
    <div
      className="mt-6 rounded-2xl p-6 md:p-8"
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
      }}
    >
      <div className="mb-6 flex items-center gap-3">
        <div
          className="rounded-lg p-2"
          style={{ background: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(245, 158, 11, 0.25)' }}
        >
          <ScrollText className="h-5 w-5 text-amber-400" />
        </div>
        <div>
          <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
            账单记录
          </h3>
          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
            查看 Stripe 已开具的发票 PDF、在线发票和收据链接。
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="py-8 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
          正在加载账单记录...
        </div>
      ) : records.length === 0 ? (
        <div
          className="rounded-xl border px-4 py-6 text-center text-sm"
          style={{ background: 'var(--bg-primary)', borderColor: 'rgba(255,255,255,0.08)', color: 'var(--text-tertiary)' }}
        >
          暂无可展示的 Stripe 账单记录。支付成功后，这里会自动同步发票和收据入口。
        </div>
      ) : (
        <div className="space-y-4">
          {records.map((record) => (
            <div
              key={record.id}
              className="rounded-xl border p-4"
              style={{ background: 'var(--bg-primary)', borderColor: 'rgba(255,255,255,0.08)' }}
            >
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {record.title}
                    </span>
                    <span
                      className="rounded-full px-2.5 py-1 text-xs font-medium"
                      style={{
                        background: record.itemType === 'membership_plan' ? 'rgba(255,215,0,0.12)' : 'rgba(59,130,246,0.12)',
                        color: record.itemType === 'membership_plan' ? '#facc15' : '#60a5fa',
                      }}
                    >
                      {record.itemType === 'membership_plan' ? '订阅账单' : '一次性支付'}
                    </span>
                    <span className="text-xs" style={{ color: 'var(--text-disabled)' }}>
                      {record.status}
                    </span>
                  </div>

                  <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {record.description}
                  </div>

                  <div className="flex flex-wrap gap-4 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                    <span>{formatMoney(record.amountTotal, record.currency)}</span>
                    <span>{formatDate(record.fulfilledAt ?? record.createdAt)}</span>
                    {record.invoiceNumber && <span>发票号 {record.invoiceNumber}</span>}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {record.invoicePdfUrl && (
                    <a
                      href={record.invoicePdfUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium"
                      style={{ background: 'rgba(255,215,0,0.12)', color: '#facc15' }}
                    >
                      <FileText className="h-4 w-4" />
                      PDF 发票
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  )}
                  {record.hostedInvoiceUrl && (
                    <a
                      href={record.hostedInvoiceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium"
                      style={{ background: 'rgba(59,130,246,0.12)', color: '#60a5fa' }}
                    >
                      <ScrollText className="h-4 w-4" />
                      在线发票
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  )}
                  {record.receiptUrl && (
                    <a
                      href={record.receiptUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium"
                      style={{ background: 'rgba(34,197,94,0.12)', color: '#4ade80' }}
                    >
                      <Receipt className="h-4 w-4" />
                      Stripe 收据
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
