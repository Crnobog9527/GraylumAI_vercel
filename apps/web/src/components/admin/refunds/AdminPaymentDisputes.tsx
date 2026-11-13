/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { DisputeEvidencePanel } from './DisputeEvidencePanel';

const statusLabel: Record<string, string> = { pending: '等待处理', frozen: '冻结中', withdrawn: '已撤回',
  superseded: '已被退款取代', review: '待核对', external: '已确认站外付款', confirmed: '已确认停止', manual: '请人工处理',
  not_applicable: '无需续费', needs_response: '等待应对', under_review: '审核中', warning_needs_response: '预警待应对',
  warning_under_review: '预警审核中', warning_closed: '预警已结束', won: '已判赢', lost: '已判输', prevented: '已阻止' };
const label = (state: string) => statusLabel[state] ?? '待核对';

// 只有已判赢或预警已结束，撤回才没有钱被扣回的风险；其余状态（含未知）都要二次确认。
const safeToWithdraw = new Set(['won', 'warning_closed']);

export function WithdrawConfirm({ status, pending, onConfirm, onCancel, providerLabel = '原支付渠道' }:
  { status: string; providerLabel?: string; pending: boolean; onConfirm: () => void; onCancel: () => void }) {
  const risky = !safeToWithdraw.has(status);
  const [understood, setUnderstood] = useState(false);
  return <div className="space-y-2">
    <p>确认撤回这笔冻结？这会恢复仍属于该付款的权益和积分，自动续费继续保持停止。</p>
    {risky ? <div role="alert" className="space-y-2 rounded-lg border p-3 font-bold text-red-600" data-testid="withdraw-risk">
      <p>注意：这笔拒付{status === 'lost' ? '已判输' : '还没判赢'}（当前：{label(status)}）。撤回后用户可以继续使用这些积分和会员权益，钱可能已被银行扣回。</p>
      <label className="flex items-center gap-2 font-normal">
        <input type="checkbox" checked={understood} onChange={e => setUnderstood(e.target.checked)} />
        我已在{providerLabel}核对，仍要撤回
      </label>
    </div> : null}
    <Button disabled={pending || (risky && !understood)} onClick={onConfirm}>确认撤回冻结</Button>
    <Button variant="outline" disabled={pending} onClick={onCancel}>返回</Button>
  </div>;
}

// CHARGEBACK G1: the Owner confirms a lost dispute by hand (Owner 2026-11-14). Stripe must already show "lost";
// Waffo has no outcome feed, so its rows ask the admin to check the Waffo dashboard first.
export function ConfirmLost({ provider, pending, onConfirm, onCancel }:
  { provider: string; pending: boolean; onConfirm: () => void; onCancel: () => void }) {
  return <div className="space-y-2" data-testid="confirm-lost">
    <p>确认这笔拒付判输并结案？结案后：这笔付款冻结的积分作为最终收回（不会再多扣）；如果是会员付款，这份会员结束、
      以后的按月积分不再发放，是创始会员的结束创始身份。结案后不能再撤回冻结。</p>
    {provider === 'waffo' ? <p role="alert" className="font-bold">Waffo 不会把判决结果推送给我们，请先在 Waffo 后台核实这笔已判输。</p> : null}
    <Button disabled={pending} onClick={onConfirm}>确认判输结案</Button>
    <Button variant="outline" disabled={pending} onClick={onCancel}>返回</Button>
  </div>;
}

const EMAIL_NOTE: Record<string, string> = {
  sent: '已给用户发"请重新订阅"邮件。',
  not_sent: '这笔不需要发"请重新订阅"邮件。',
  not_won: '这笔拒付不是判赢，没有发邮件。',
  failed: '"请重新订阅"邮件没发出，请在付款提醒页重发。',
};
export function withdrawMessage(result: { restored: number; backfilled?: number; email?: string; duplicate?: boolean }) {
  if (result.duplicate) return '这笔冻结之前已经撤回过，没有重复操作。';
  return `已撤回冻结，恢复 ${result.restored} 积分，补发冻结期间的按月积分 ${result.backfilled ?? 0}。`
    + `订阅继续保持停止续费。${EMAIL_NOTE[result.email ?? ''] ?? ''}`;
}

export function AdminPaymentDisputes() {
  const [offset, setOffset] = useState(0);
  const rows = trpc.paymentDisputes.list.useQuery({ offset });
  const utils = trpc.useUtils();
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [externalSelected, setExternalSelected] = useState<string | null>(null);
  const resolveExternal = trpc.paymentDisputes.resolveExternal.useMutation({
    onSuccess: () => {
      setMessage('已确认站外付款并结案，停止重试匹配。'); setExternalSelected(null);
      void utils.paymentDisputes.invalidate();
    },
    onError: () => setMessage('未能结案，请核实是否已有对应订单。'),
  });
  const [lostSelected, setLostSelected] = useState<string | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState<string | null>(null);
  const confirmLost = trpc.paymentDisputes.confirmLost.useMutation({
    onSuccess: () => {
      setMessage('已判输结案：这笔付款冻结的积分作为最终收回。'); setLostSelected(null);
      void utils.paymentDisputes.invalidate();
      void utils.payments.invalidate();
    },
    onError: () => setMessage('未能结案，请先在原支付渠道核实这笔拒付已判输。'),
  });
  const withdraw = trpc.paymentDisputes.withdraw.useMutation({
    onSuccess: result => {
      setMessage(withdrawMessage(result));
      setSelected(null);
      void utils.paymentDisputes.invalidate();
      void utils.payments.invalidate();
    },
    onError: () => setMessage('冻结未撤回，请核对付款和拒付状态后重试。'),
  });
  return (
    <section id="payment-disputes" className="scroll-mt-4 space-y-4 p-4 md:p-8" data-testid="payment-disputes">
      <h2 className="text-xl font-bold">付款争议</h2>
      <p className="text-sm">收到拒付后会暂停相关权益和积分，并停止续费。结案不会自动解冻，请先在该笔记录的原支付渠道核对。</p>
      {message ? <p role="status">{message}</p> : null}
      {rows.isError ? <p role="alert">拒付记录暂时无法读取。</p> : null}
      {rows.isLoading ? <p>正在读取…</p> : null}
      {!rows.isError && !rows.isLoading && rows.data?.length === 0 ? <p>暂无付款争议。</p> : null}
      <nav aria-label="付款争议分页" className="flex items-center gap-2">
        <Button variant="outline" disabled={offset === 0 || rows.isFetching || withdraw.isPending}
          onClick={() => { setOffset(n => Math.max(0, n - 100)); setSelected(null); }}>上一页</Button>
        <span>第 {offset / 100 + 1} 页</span>
        <Button variant="outline" disabled={rows.isError || rows.isFetching || withdraw.isPending || (rows.data?.length ?? 0) < 100}
          onClick={() => { setOffset(n => n + 100); setSelected(null); }}>下一页</Button>
      </nav>
      {rows.data?.map(row => {
        const providerLabel = row.provider === 'waffo' ? 'Waffo' : row.provider === 'stripe' ? 'Stripe' : '原支付渠道';
        return (
          <article key={row.id} className="space-y-2 rounded-xl border p-4" style={{ borderColor: 'var(--border-primary)' }}>
            <p className="break-all text-sm">{providerLabel} 拒付编号：{row.provider_dispute_id ?? '暂时无法读取'}</p>
            <p className="break-all text-sm">商户：{row.merchant_namespace ?? '暂时无法读取'} · 环境：
              {row.mode === 'test' ? '测试' : row.mode === 'live' ? '正式' : '暂时无法读取'}</p>
            <p className="break-all text-sm">订单：{row.order_id ?? '等待匹配'}</p>
            <p>{typeof row.amount === 'number' && Number.isSafeInteger(row.amount) && row.amount > 0
              && typeof row.currency === 'string' && /^[a-zA-Z]{3}$/.test(row.currency)
              ? `${(row.amount / 100).toFixed(2)} ${row.currency.toUpperCase()}` : '金额待核实'} · 拒付：{label(row.status)}</p>
            <p>冻结：{row.lost_confirmed_at ? '已收回' : label(row.freeze_state)} · 停续费：{label(row.renewal_stop_state)}</p>
            {row.evidence_due_by ? <p>举证截止：{new Date(row.evidence_due_by).toLocaleString('zh-CN')}</p> : null}
            {row.source_review_required ? <p role="alert">积分来源无法核实，未扣取无法确认的积分，请人工核对。</p> : null}
            {!row.order_id && row.provider_dispute_id && row.merchant_namespace && ['test', 'live'].includes(row.mode)
              && ['pending', 'review'].includes(row.freeze_state) ? (
              externalSelected === row.id ? <div className="space-y-2">
                <p>请先在对应商户和环境的 {providerLabel} 中核实拒付 {row.provider_dispute_id} 是与 Graylum 订单无关的站外付款。确认后将结案并停止重试匹配。</p>
                <Button disabled={resolveExternal.isPending}
                  onClick={() => resolveExternal.mutate({ disputeId: row.id })}>确认站外结案</Button>
                <Button variant="outline" disabled={resolveExternal.isPending} onClick={() => setExternalSelected(null)}>返回</Button>
              </div> : <Button variant="outline"
                onClick={() => { setExternalSelected(row.id); setSelected(null); }}>已核实站外付款</Button>
            ) : null}
            {row.order_id ? (evidenceOpen === row.id ? <DisputeEvidencePanel disputeId={row.id} onClose={() => setEvidenceOpen(null)} />
              : <Button variant="outline" onClick={() => setEvidenceOpen(row.id)}>申诉材料</Button>) : null}
            {row.lost_confirmed_at ? <p className="font-bold">已判输结案（{new Date(row.lost_confirmed_at).toLocaleString('zh-CN')}）</p> : null}
            {row.freeze_state === 'withdrawn' && row.status === 'lost' ? <p role="alert">
              这笔拒付在撤回冻结后被判输，系统不会自动再扣，请人工核对处理。</p> : null}
            {row.freeze_state === 'frozen' && !row.lost_confirmed_at && (row.status === 'lost' || row.provider === 'waffo') ? (
              lostSelected === row.id ? <ConfirmLost provider={row.provider} pending={confirmLost.isPending}
                onConfirm={() => confirmLost.mutate({ disputeId: row.id })} onCancel={() => setLostSelected(null)} />
              : <Button variant="outline" onClick={() => { setLostSelected(row.id); setSelected(null); setExternalSelected(null); }}>
                确认判输结案</Button>
            ) : null}
            {row.freeze_state === 'frozen' && !row.lost_confirmed_at ? (
              selected === row.id ? <WithdrawConfirm status={row.status} pending={withdraw.isPending} providerLabel={providerLabel}
                onConfirm={() => withdraw.mutate({ disputeId: row.id })} onCancel={() => setSelected(null)} />
              : <Button variant="outline" onClick={() => { setSelected(row.id); setExternalSelected(null); setLostSelected(null); }}>
                撤回冻结</Button>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}
