/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { CheckCircle } from 'lucide-react';
import { formatMinorAmount } from '@/lib/payment-display';
import { ConfirmRefundAction } from './ConfirmRefundAction';
import {
  BILLING_CYCLE_LABELS, FEE_PERMITTED_LABELS, MONTHLY_REFUND_RULES, PLAN_LABELS, SUBSCRIPTION_REFUND_RULES, formatRefundTime,
} from './monthlyRefundView';

export type MonthlyRefundQuoteTerms = {
  orderId: string; ticketId: string;
  plan: string; currency: string; paidMinor: number; basisMinor: number; feeMinor: number; netMinor: number;
  /** International card (Managed Payments) orders only: the tax charged on top of paidMinor, refunded in full. */
  taxMinor?: number;
  credits: number; paidAt: string; submittedAt: string; periodEnd: string; mode: string;
  feePermitted: 'confirmed' | 'not_permitted'; feeEvidence: string; evidenceRefs: string[];
  /** The order's billing cycle, as the server snapshot recorded it. */
  snapshot?: { billing_cycle?: string };
  /** Pro-to-Gold upgrades only: the Pro order that comes back after this refund (original end date kept). */
  priorPro?: { periodEnd: string; autoRenew: boolean };
};

type Props = {
  terms: MonthlyRefundQuoteTerms;
  approving: boolean;
  disabled: boolean;
  onApprove: () => void;
};

const rowStyle = { color: 'var(--text-secondary)' };

/** Read-only quote; the server only returns one when every refund rule passed. */
export function MonthlyRefundQuoteCard({ terms, approving, disabled, onApprove }: Props) {
  // The checklist follows the quoted order itself, not the section it was typed into: both sections call the
  // same server procedures, so only the returned terms say what kind of purchase was checked.
  const rules = terms.snapshot?.billing_cycle === 'yearly' || terms.priorPro ? SUBSCRIPTION_REFUND_RULES : MONTHLY_REFUND_RULES;
  const money = (minor: number) => formatMinorAmount(minor, terms.currency);
  const rows: Array<[string, string]> = [
    ['会员', `${PLAN_LABELS[terms.plan] ?? terms.plan} ${BILLING_CYCLE_LABELS[terms.snapshot?.billing_cycle ?? 'monthly'] ?? '月付'}`
      + `（${terms.priorPro ? '从 Pro 升级，首次购买 Gold' : '首次购买'}）`],
    ['付款时间', formatRefundTime(terms.paidAt)],
    ['工单提交时间', formatRefundTime(terms.submittedAt)],
    ['当前计费周期结束', formatRefundTime(terms.periodEnd)],
    // A card order was charged the pre-tax price plus tax; the fee is on the pre-tax price and the tax comes back in full.
    ...(terms.taxMinor === undefined ? [['实付金额', money(terms.paidMinor)] as [string, string]] : [
      ['实付金额（含税）', money(terms.paidMinor + terms.taxMinor)],
      ['其中税前价', money(terms.paidMinor)],
      ['其中税（全额退回）', money(terms.taxMinor)],
    ] as Array<[string, string]>),
    ['计算基数', money(terms.basisMinor)],
    ['手续费', `${money(terms.feeMinor)}（${FEE_PERMITTED_LABELS[terms.feePermitted]}）`],
    ['退回给用户', money(terms.netMinor)],
    [terms.snapshot?.billing_cycle === 'yearly' ? '收回积分（本单已到账的月度发放）' : '收回积分', `${terms.credits.toLocaleString()} 积分`],
    ...(terms.priorPro ? [['退款后恢复原 Pro', `到原到期日 ${formatRefundTime(terms.priorPro.periodEnd)}，保持停止续费`] as [string, string]] : []),
    ['支付模式', terms.mode === 'test' ? '测试（Stripe 沙盒）' : terms.mode === 'live' ? '正式（真实付款，会退真钱）' : '未知'],
  ];
  return (
    <section data-testid="monthly-refund-quote" className="space-y-4 rounded-xl border p-4"
      style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}>
      <div>
        <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>退款报价（只读）</h2>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-tertiary)' }}>
          这一步没有退款，也没有改动用户的会员和积分。确认无误后再点"批准退款"。
        </p>
      </div>
      <ul className="space-y-1 text-sm" aria-label="已核对的退款条件">
        {rules.map(rule => (
          <li key={rule} className="flex items-start gap-2" style={rowStyle}>
            <CheckCircle className="mt-0.5 h-4 w-4 flex-shrink-0" style={{ color: 'var(--success)' }} />
            <span>{rule}</span>
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4">
            <dt style={{ color: 'var(--text-tertiary)' }}>{label}</dt>
            <dd style={rowStyle}>{value}</dd>
          </div>
        ))}
      </dl>
      <p data-testid="monthly-refund-quote-ids" className="break-all font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>
        订单 {terms.orderId} · 工单 {terms.ticketId}
      </p>
      <p className="break-all text-xs" style={{ color: 'var(--text-disabled)' }}>
        手续费依据 {terms.feeEvidence} · 核对证据 {terms.evidenceRefs.length} 项
      </p>
      <ConfirmRefundAction testId="monthly-refund-approve" label="批准退款" pendingLabel="正在批准…"
        title="确认批准这笔退款？" confirmLabel="批准" pending={approving} disabled={disabled} onConfirm={onApprove}>
        <p className="break-all">订单 {terms.orderId}<br />工单 {terms.ticketId}</p>
        <p>批准后会锁定这份报价：退回 <strong>{money(terms.netMinor)}</strong>，收回 {terms.credits.toLocaleString()} 积分。</p>
        <p>批准不会马上退款。真正退款要在下面的进度卡片里另外点"执行退款"。</p>
        <p>如果批准前订单或工单有变化，服务端会拒绝，需要重新获取报价。</p>
      </ConfirmRefundAction>
    </section>
  );
}
