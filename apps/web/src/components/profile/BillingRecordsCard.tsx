'use client';

import { ScrollText } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { AmountFactList, DocumentStatusBadge, PaymentDocumentLinks } from '@/components/payments/PaymentDocumentLinks';
import { buildUserAmountFactRows, getPaymentChannelLabel, getTaxInclusivePaid } from '@/lib/payment-display';
import { getBillingRecordStatusPresentation } from './billingRecordStatus';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { ProfileSection } from './ProfileSection';

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
  const { data: records = [], isLoading, isError, refetch } = trpc.payments.listBillingRecords.useQuery();

  return (
    <ProfileSection className="mt-6 md:p-8">
      <div className="mb-6 flex items-center gap-3">
        <div
          className="rounded-lg p-2"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
        >
          <ScrollText className="h-5 w-5" style={{ color: 'var(--text-primary)' }} />
        </div>
        <div>
          <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
            账单记录
          </h3>
          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
            查看每笔订单的状态、支付渠道，以及支付渠道提供的发票和收据。
          </p>
        </div>
      </div>

      {isLoading ? (
        <PageSkeleton compact rows={3} label="账单记录读取中" />
      ) : isError ? (
        <div
          role="alert"
          data-testid="billing-records-error"
          className="rounded-xl border px-4 py-6 text-center text-sm"
          style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-primary)', color: 'var(--text-tertiary)' }}
        >
          账单记录暂时读取失败，这不代表你没有订单。
          <button type="button" className="ml-2 underline" style={{ color: 'var(--color-primary)' }} onClick={() => void refetch()}>
            重新加载
          </button>
        </div>
      ) : records.length === 0 ? (
        <div
          className="rounded-xl border px-4 py-6 text-center text-sm"
          style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-primary)', color: 'var(--text-tertiary)' }}
        >
          暂无账单记录。完成购买后，这里会显示订单状态和凭证。
        </div>
      ) : (
        <div className="space-y-4">
          {records.map((record) => {
            const statusPresentation = getBillingRecordStatusPresentation(record.status);

            return (
              <div
                key={record.id}
                className="rounded-xl border p-4"
                style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-primary)' }}
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
                          background: record.itemType === 'membership_plan' ? 'var(--bg-tertiary)' : 'var(--info-bg)',
                          color: record.itemType === 'membership_plan' ? 'var(--text-primary)' : 'var(--info)',
                        }}
                      >
                        {record.itemType === 'membership_plan' ? '订阅账单' : '一次性支付'}
                      </span>
                      <span
                        className="rounded-full px-2.5 py-1 text-xs font-medium"
                        style={{
                          background: statusPresentation.background,
                          color: statusPresentation.color,
                        }}
                      >
                        {statusPresentation.label}
                      </span>
                      <DocumentStatusBadge status={record.documentStatus} light />
                    </div>

                    <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                      {record.description}
                    </div>

                    <div className="flex flex-wrap gap-4 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                      <span>{formatMoney(Number(getTaxInclusivePaid(record.amountFacts)?.total ?? record.amountTotal),
                        record.currency)}</span>
                      <span>{formatDate(record.fulfilledAt ?? record.createdAt)}</span>
                      <span>支付渠道 {getPaymentChannelLabel(record.paymentChannelLabel)}</span>
                      {record.invoiceNumber && <span>发票号 {record.invoiceNumber}</span>}
                    </div>
                    <AmountFactList rows={buildUserAmountFactRows(record.amountFacts)} />
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <PaymentDocumentLinks record={record} light />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </ProfileSection>
  );
}
