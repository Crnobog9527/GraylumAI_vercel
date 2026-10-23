/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConfirmRefundAction } from './ConfirmRefundAction';
import { MonthlyRefundQuoteCard, type MonthlyRefundQuoteTerms } from './MonthlyRefundQuoteCard';
import { MonthlyRefundStatusCard } from './MonthlyRefundStatusCard';
import { useMonthlyRefund, type RefundVariant } from './useMonthlyRefund';
import {
  FEE_PERMITTED_HINT, FEE_PERMITTED_LABELS, REJECT_REASON_LABELS, feePermittedPatch, canRejectMonthlyRefund,
  type FeePermitted, type MonthlyRefundForm, type RejectReason,
} from './monthlyRefundView';

const cardStyle = { background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' };

function Field({ id, idPrefix, label, hint, error, children }: {
  id: keyof MonthlyRefundForm; idPrefix: string; label: string; hint?: string; error?: string; children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`${idPrefix}-${id}`} style={{ color: 'var(--text-primary)' }}>{label}</Label>
      {children}
      {hint && !error ? <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{hint}</p> : null}
      {error ? <p role="alert" className="text-xs" style={{ color: 'var(--error)' }}>{error}</p> : null}
    </div>
  );
}

const COPY: Record<RefundVariant, { title: string; intro: string; idPrefix: string }> = {
  monthly: {
    title: 'Stripe 银行卡月付首购退款', idPrefix: 'refund',
    intro: '只处理 Stripe 银行卡自动续费 Pro / Gold 月付的第一次购买，按用户的账单工单人工审批。'
      + 'Waffo 会员和 Stripe 钱包一次性会员使用下方“一次性会员退款”；续费和积分包不在这里处理；'
      + 'Stripe 银行卡年付和创始会员使用下方“年付和创始会员首购退款”。',
  },
  subscription: {
    title: 'Stripe 银行卡年付和创始会员首购退款', idPrefix: 'subscription-refund',
    intro: '处理 Stripe 银行卡（含国际卡）的年付首购、创始会员首购，以及有明确原单的 Pro 升 Gold 首购，'
      + '按用户的账单工单人工审批。年付只收回本单已经到账的月度积分，没发的部分终止；'
      + '创始会员退款成功后身份和展示墙资格一并结束，已售名额不放回；'
      + 'Pro 升 Gold 退款后恢复原 Pro 到原到期日。续费、月付首购和积分包不在这里处理。',
  },
};

/** 后台订阅首购退款（PAY-COMMON / PAY-REFUND）：按工单人工审批，报价、批准、执行分三步，规则全部由服务端判断。 */
export function AdminMonthlyRefunds({ variant = 'monthly' }: { variant?: RefundVariant } = {}) {
  const refund = useMonthlyRefund(variant);
  const copy = COPY[variant];
  const { idPrefix } = copy;
  const { form, errors, rejectReason, setRejectReason } = refund;

  return (
    <div className="space-y-6 p-4 md:p-8" data-testid={`${variant}-refund-section`}>
      <div>
        <h1 className="text-2xl font-bold md:text-3xl" style={{ color: 'var(--text-primary)' }}>{copy.title}</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-tertiary)' }}>{copy.intro}</p>
      </div>

      <section className="space-y-4 rounded-xl border p-4" style={cardStyle} data-testid="monthly-refund-form">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field id="orderId" idPrefix={idPrefix} label="订单编号" hint='在"支付订单"页每笔订单最下面一行' error={errors.orderId}>
            <Input id={`${idPrefix}-orderId`} value={form.orderId} disabled={refund.busy} autoComplete="off" spellCheck={false}
              onChange={event => refund.updateForm({ orderId: event.target.value })} />
          </Field>
          <Field id="ticketId" idPrefix={idPrefix} label="工单编号" hint="用户提交的账单类退款工单" error={errors.ticketId}>
            <Input id={`${idPrefix}-ticketId`} value={form.ticketId} disabled={refund.busy} autoComplete="off" spellCheck={false}
              onChange={event => refund.updateForm({ ticketId: event.target.value })} />
          </Field>
          <Field id="feePermitted" idPrefix={idPrefix} label="能否扣 6% 手续费" hint={FEE_PERMITTED_HINT}
            error={errors.feePermitted}>
            <Select value={form.feePermitted} disabled={refund.busy} onValueChange={value => refund.updateForm(feePermittedPatch(value as FeePermitted, form))}>
              <SelectTrigger id={`${idPrefix}-feePermitted`}><SelectValue placeholder="请选择" /></SelectTrigger>
              <SelectContent>
                {(Object.keys(FEE_PERMITTED_LABELS) as FeePermitted[]).map(key => (
                  <SelectItem key={key} value={key}>{FEE_PERMITTED_LABELS[key]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="feeEvidence" idPrefix={idPrefix} label="手续费核对依据"
            hint="核对记录的编号，例如 legal:us-ca:2026-10" error={errors.feeEvidence}>
            <Input id={`${idPrefix}-feeEvidence`} value={form.feeEvidence} disabled={refund.busy} autoComplete="off" spellCheck={false}
              onChange={event => refund.updateForm({ feeEvidence: event.target.value })} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button data-testid="monthly-refund-quote-button" disabled={refund.busy} onClick={() => void refund.requestQuote()}>
            {refund.quoting ? '正在核对…' : '获取报价'}
          </Button>
          <Button data-testid="monthly-refund-status-button" variant="outline" disabled={refund.busy}
            onClick={() => void refund.loadStatus()}>
            {refund.loadingStatus ? '正在读取…' : '查看进度'}
          </Button>
        </div>
        {refund.quoteError ? (
          <div role="alert" data-testid="monthly-refund-quote-error" className="space-y-1 text-sm" style={{ color: 'var(--error)' }}>
            <p>拿不到报价：{refund.quoteError.text}</p>
            <p data-testid="monthly-refund-quote-next" style={{ color: 'var(--text-tertiary)' }}>
              {refund.quoteError.ineligible ? '这次申请不符合退款条件，可以在下面选择“不符合退款条件”拒绝。'
                : refund.quoteError.specific ? '这是证据或状态问题，请先核对订单和工单，或点"查看进度"确认，不要直接拒绝。'
                  : '常见原因：不是第一次购买或已续费、超过 7 天、积分已经用过、工单不是这位用户的账单工单、订单不是测试模式，'
                    + '或者已经批准或拒绝过。可以点"查看进度"确认；不符合条件时在下面选择拒绝原因。'}
            </p>
          </div>
        ) : null}
        {refund.statusError ? (
          <p role="alert" data-testid="monthly-refund-status-message" className="text-sm"
            style={{ color: 'var(--text-tertiary)' }}>{refund.statusError}</p>
        ) : null}
      </section>

      {refund.quoted ? (
        <MonthlyRefundQuoteCard
          terms={refund.quoted.quote.terms as MonthlyRefundQuoteTerms} approving={refund.approving}
          disabled={refund.busy} onApprove={() => void refund.approveQuote()} />
      ) : null}

      {refund.intent ? (
        <MonthlyRefundStatusCard intent={refund.intent} executeResult={refund.executeResult} executing={refund.executing}
          disabled={refund.busy} onExecute={() => void refund.executeIntent()} />
      ) : null}

      {refund.actionError ? (
        <p role="alert" data-testid="monthly-refund-action-error" className="text-sm" style={{ color: 'var(--error)' }}>
          操作没有完成：{refund.actionError}。请点"查看进度"确认当前状态后再决定下一步。
        </p>
      ) : null}

      {canRejectMonthlyRefund(refund.intent) ? (
        <section className="space-y-3 rounded-xl border p-4" style={cardStyle} data-testid="monthly-refund-reject">
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>拒绝这次退款申请</h2>
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <Select value={rejectReason} onValueChange={value => setRejectReason(value as RejectReason)}>
              <SelectTrigger className="md:w-64" aria-label="拒绝原因"><SelectValue placeholder="选择拒绝原因" /></SelectTrigger>
              <SelectContent>
                {(Object.keys(REJECT_REASON_LABELS) as RejectReason[]).map(key => (
                  <SelectItem key={key} value={key}>{REJECT_REASON_LABELS[key]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ConfirmRefundAction testId="monthly-refund-reject-button" destructive label="拒绝" pendingLabel="正在拒绝…"
              title="确认拒绝这次退款申请？" confirmLabel="拒绝" pending={refund.rejecting}
              disabled={refund.busy || !rejectReason} onConfirm={() => rejectReason && void refund.rejectRequest(rejectReason)}>
              <p>原因：{rejectReason ? REJECT_REASON_LABELS[rejectReason] : '—'}。拒绝后这笔订单不会退款，用户的会员和积分保持不变。</p>
              <p>已经开始执行的退款不能再拒绝。</p>
            </ConfirmRefundAction>
          </div>
        </section>
      ) : null}
    </div>
  );
}
