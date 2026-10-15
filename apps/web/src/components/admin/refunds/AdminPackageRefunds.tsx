/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConfirmRefundAction } from './ConfirmRefundAction';
import { usePackageRefund } from './usePackageRefund';
import { FEE_PERMITTED_LABELS, REJECT_REASON_LABELS, type FeePermitted, type RejectReason } from './monthlyRefundView';

const cardStyle = { background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' };
const money = (minor: number | undefined, currency: string) => `${((minor ?? 0) / 100).toFixed(2)} ${currency.toUpperCase()}`;
const STATUS_TEXT: Record<string, string> = {
  approved: '已批准，等待执行', rejected: '已拒绝', dispatching: '正在发起退款', pending: '退款处理中',
  succeeded: '退款已完成', failed: '退款失败，积分已退回', review_required: '结果待核对，请点"核对结果"',
};

/** 后台积分包退款（MASTER_PLAN 第 51 项，记录 AA）：7 天内、付款后整个账户没有任何积分消耗才可退；规则由服务端判断。 */
export function AdminPackageRefunds() {
  const refund = usePackageRefund();
  const { form, errors, quote, intent } = refund;
  const status = typeof intent?.status === 'string' ? intent.status : null;
  const field = (id: 'orderId' | 'ticketId' | 'feeEvidence', label: string, hint: string) => (
    <div className="space-y-1.5">
      <Label htmlFor={`package-refund-${id}`} style={{ color: 'var(--text-primary)' }}>{label}</Label>
      <Input id={`package-refund-${id}`} value={form[id]} disabled={refund.busy} autoComplete="off" spellCheck={false}
        onChange={event => refund.updateForm({ [id]: event.target.value })} />
      {errors[id] ? <p role="alert" className="text-xs" style={{ color: 'var(--error)' }}>{errors[id]}</p>
        : <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{hint}</p>}
    </div>
  );

  return (
    <div className="space-y-6 p-4 md:p-8" data-testid="package-refunds">
      <div>
        <h2 className="text-xl font-bold md:text-2xl" style={{ color: 'var(--text-primary)' }}>积分包退款</h2>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-tertiary)' }}>
          付款 7 天内、而且付款后整个账户没有用过任何积分才可退，整包积分扣回。国际卡（Managed Payments）的税全额退还，6% 手续费只按税前金额算。目前只支持测试模式。
        </p>
      </div>
      <section className="space-y-4 rounded-xl border p-4" style={cardStyle}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {field('orderId', '订单编号', '在"支付订单"页每笔订单最下面一行')}
          {field('ticketId', '工单编号', '用户提交的账单类退款工单')}
          <div className="space-y-1.5">
            <Label htmlFor="package-refund-feePermitted" style={{ color: 'var(--text-primary)' }}>能否扣 6% 手续费</Label>
            <Select value={form.feePermitted} disabled={refund.busy} onValueChange={value => refund.updateForm({ feePermitted: value as FeePermitted })}>
              <SelectTrigger id="package-refund-feePermitted"><SelectValue placeholder="请选择" /></SelectTrigger>
              <SelectContent>
                {(Object.keys(FEE_PERMITTED_LABELS) as FeePermitted[]).map(key => (
                  <SelectItem key={key} value={key}>{FEE_PERMITTED_LABELS[key]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.feePermitted ? <p role="alert" className="text-xs" style={{ color: 'var(--error)' }}>{errors.feePermitted}</p>
              : <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>按用户所在地法律核对；不确定时先核对，不要猜</p>}
          </div>
          {field('feeEvidence', '手续费核对依据', '核对记录的编号，例如 legal:us-ca:2026-10')}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button data-testid="package-refund-quote-button" disabled={refund.busy} onClick={() => void refund.requestQuote()}>获取报价</Button>
          <Button data-testid="package-refund-status-button" variant="outline" disabled={refund.busy} onClick={() => void refund.loadStatus()}>查看进度</Button>
        </div>
        {refund.error ? <p role="alert" data-testid="package-refund-error" className="text-sm" style={{ color: 'var(--error)' }}>{refund.error}</p> : null}
      </section>

      {quote ? (
        <section className="space-y-3 rounded-xl border p-4" style={cardStyle} data-testid="package-refund-quote">
          <h3 className="font-semibold" style={{ color: 'var(--text-primary)' }}>退款报价</h3>
          <dl className="grid grid-cols-2 gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            <dt>税前金额</dt><dd>{money(quote.basisMinor, quote.currency)}</dd>
            <dt>手续费（6%）</dt><dd>{money(quote.feeMinor, quote.currency)}</dd>
            <dt>税（全额退还）</dt><dd>{money(quote.taxMinor, quote.currency)}</dd>
            <dt>退给用户</dt><dd data-testid="package-refund-net">{money(quote.netMinor, quote.currency)}</dd>
            <dt>扣回积分</dt><dd>{quote.credits}</dd>
          </dl>
          <ConfirmRefundAction testId="package-refund-approve-button" label="批准退款" pendingLabel="正在批准…"
            title="确认批准这次积分包退款？" confirmLabel="批准" pending={refund.busy} disabled={refund.busy} onConfirm={() => void refund.approve()}>
            <p>批准后还要再点"执行退款"才会真正退钱。退给用户 {money(quote.netMinor, quote.currency)}，扣回 {quote.credits} 积分。</p>
          </ConfirmRefundAction>
        </section>
      ) : null}

      {intent ? (
        <section className="space-y-3 rounded-xl border p-4" style={cardStyle} data-testid="package-refund-status">
          <p className="text-sm" style={{ color: 'var(--text-primary)' }}>当前状态：{status ? STATUS_TEXT[status] ?? status : '—'}</p>
          <div className="flex flex-wrap gap-2">
            {status === 'approved' ? (
              <ConfirmRefundAction testId="package-refund-execute-button" label="执行退款" pendingLabel="正在执行…"
                title="确认执行这次退款？" confirmLabel="执行" pending={refund.busy} disabled={refund.busy} onConfirm={() => void refund.execute()}>
                <p>会立即在 Stripe 发起退款并扣回积分。执行后不能撤销。</p>
              </ConfirmRefundAction>
            ) : null}
            {status && ['dispatching', 'pending', 'review_required'].includes(status) ? (
              <Button data-testid="package-refund-reconcile-button" variant="outline" disabled={refund.busy}
                onClick={() => void refund.reconcile()}>核对结果</Button>
            ) : null}
          </div>
        </section>
      ) : null}

      {!status || status === 'approved' ? (
        <section className="flex flex-col gap-2 rounded-xl border p-4 md:flex-row md:items-center" style={cardStyle}>
          <Select value={refund.rejectReason} onValueChange={value => refund.setRejectReason(value as RejectReason)}>
            <SelectTrigger className="md:w-64" aria-label="积分包退款拒绝原因"><SelectValue placeholder="选择拒绝原因" /></SelectTrigger>
            <SelectContent>
              {(Object.keys(REJECT_REASON_LABELS) as RejectReason[]).map(key => (
                <SelectItem key={key} value={key}>{REJECT_REASON_LABELS[key]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ConfirmRefundAction testId="package-refund-reject-button" destructive label="拒绝" pendingLabel="正在拒绝…"
            title="确认拒绝这次积分包退款申请？" confirmLabel="拒绝" pending={refund.busy}
            disabled={refund.busy || !refund.rejectReason} onConfirm={() => void refund.reject()}>
            <p>拒绝后这笔订单不会退款，用户的积分保持不变。</p>
          </ConfirmRefundAction>
        </section>
      ) : null}
    </div>
  );
}
