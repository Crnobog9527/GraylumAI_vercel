/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { formatMinorAmount } from '@/lib/payment-display';
import { ConfirmRefundAction } from './ConfirmRefundAction';
import type { MonthlyRefundIntent } from './useMonthlyRefund';
import {
  canExecuteMonthlyRefund, executeReasonLabel, stoppedExecutionReason, formatRefundTime, monthlyRefundHoldLabel, monthlyRefundStages,
  monthlyRefundStatusLabel, rejectReasonLabel,
} from './monthlyRefundView';

type Props = {
  intent: MonthlyRefundIntent;
  executeResult: MonthlyRefundIntent | null;
  executing: boolean;
  disabled: boolean;
  onExecute: () => void;
};

const muted = { color: 'var(--text-tertiary)' };

/** Progress of one stored refund decision, plus the separate execute step. */
export function MonthlyRefundStatusCard({ intent, executeResult, executing, disabled, onExecute }: Props) {
  const terms = (intent.terms ?? {}) as { netMinor?: number; currency?: string; credits?: number };
  const refund = intent.recordedRefund as { status?: string } | null | undefined;
  const claimed = typeof intent.claimedAt === 'string';
  const stopped = executeResult && !('terms' in executeResult) ? executeResult : null;
  // A recorded cash mismatch is terminal for this screen: no further attempt until someone reconciles it.
  const conflict = !!intent.terminalConflict || stoppedExecutionReason(stopped) === 'recorded_cash_conflict';
  return (
    <section data-testid="monthly-refund-status" className="space-y-4 rounded-xl border p-4"
      style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>退款进度</h2>
        <span data-testid="monthly-refund-status-label" className="rounded-full px-2.5 py-1 text-xs font-medium"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
          {monthlyRefundStatusLabel(intent.status)}
        </span>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-2" style={{ color: 'var(--text-secondary)' }}>
        {intent.status === 'rejected' ? (
          <>
            <div className="flex justify-between gap-4"><dt style={muted}>拒绝原因</dt>
              <dd>{rejectReasonLabel(intent.rejectionReason)}</dd></div>
            <div className="flex justify-between gap-4"><dt style={muted}>拒绝时间</dt>
              <dd>{formatRefundTime(intent.rejectedAt)}</dd></div>
          </>
        ) : (
          <>
            <div className="flex justify-between gap-4"><dt style={muted}>退回金额</dt>
              <dd>{formatMinorAmount(terms.netMinor, terms.currency)}</dd></div>
            <div className="flex justify-between gap-4"><dt style={muted}>批准时间</dt>
              <dd>{formatRefundTime(intent.approvedAt)}</dd></div>
            <div className="flex justify-between gap-4"><dt style={muted}>会员和积分</dt>
              <dd>{monthlyRefundHoldLabel(intent.hold)}</dd></div>
            <div className="flex justify-between gap-4"><dt style={muted}>支付商退款结果</dt>
              <dd>{refund?.status ? refundStatusLabel(refund.status) : '还没有'}</dd></div>
          </>
        )}
      </dl>
      {intent.status !== 'rejected' && claimed ? (
        <ol className="space-y-1 text-sm" aria-label="执行步骤">
          {monthlyRefundStages(intent.started).map(stage => (
            <li key={stage.key} className="flex justify-between gap-4" style={{ color: 'var(--text-secondary)' }}>
              <span>{stage.label}</span>
              <span style={muted}>{stage.startedAt ? `已开始 ${formatRefundTime(stage.startedAt)}` : '未开始'}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {conflict ? (
        <p role="alert" data-testid="monthly-refund-conflict" className="text-sm" style={{ color: 'var(--error)' }}>
          支付商的退款记录和本地记录对不上，已停止自动处理，需要人工核对，不要再次执行。
        </p>
      ) : null}
      {stopped && !conflict ? (
        <p data-testid="monthly-refund-execute-stopped" role="status" className="text-sm" style={{ color: 'var(--warning)' }}>
          {executeReasonLabel(stoppedExecutionReason(stopped))}
        </p>
      ) : null}
      {canExecuteMonthlyRefund(intent) && !conflict ? (
        <ConfirmRefundAction testId="monthly-refund-execute" destructive label={claimed ? '继续执行' : '执行退款'}
          pendingLabel="正在执行…" title={claimed ? '继续执行这笔退款？' : '确认执行退款？'}
          confirmLabel={claimed ? '继续执行' : '执行退款'} pending={executing} disabled={disabled} onConfirm={onExecute}>
          <p>将向支付商（Stripe 测试模式）退回 <strong>{formatMinorAmount(terms.netMinor, terms.currency)}</strong>，
            并取消这份订阅、收回 {(terms.credits ?? 0).toLocaleString()} 积分。</p>
          <p>执行前服务端会重新核对一次；有变化会停止，不会退款。重复点击不会重复退款。</p>
        </ConfirmRefundAction>
      ) : null}
    </section>
  );
}

function refundStatusLabel(status: string) {
  if (status === 'succeeded') return '已退款';
  if (status === 'pending' || status === 'requires_action') return '处理中';
  if (status === 'failed' || status === 'canceled') return '退款失败';
  return '未知';
}
