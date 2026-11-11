/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';

type Decision = 'clawback' | 'kept';
const METHOD: Record<string, string> = { card: '国际银行卡', card_cn: '中国大陆银行卡', wechat_pay: '微信支付', alipay: '支付宝' };
const money = (minor: number | null, currency: string | null) => typeof minor === 'number' && currency
  ? `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}` : '金额待核实';
const credits = (n: number | null) => typeof n === 'number' ? `${n} 积分` : '待核实';

/**
 * Deep review 2026-11-11 item 14: a credit pack refunded outside Graylum (Stripe Dashboard, Stripe or Link support) is held
 * until a person decides (Owner 2026-10-14: record only, no automatic clawback). The Feishu alert asks the Owner to decide how
 * many credits to take back; this is where. One decision per pack, confirmed before it is sent, never changed afterwards.
 */
export function AdminPackRefundReviews() {
  const rows = trpc.admin.listPackRefundReviews.useQuery();
  const utils = trpc.useUtils();
  const [selected, setSelected] = useState<{ orderId: string; decision: Decision } | null>(null);
  const [message, setMessage] = useState('');
  const settle = trpc.admin.settlePackRefundReview.useMutation({
    onSuccess: result => {
      setMessage(result.decision === 'clawback'
        ? `已收回 ${result.creditsTakenBack} 积分${result.creditsShortfall ? `，余额不足的 ${result.creditsShortfall} 积分由 Graylum 承担` : ''}。`
        : '已选择不收回，积分恢复为可用余额。');
      setSelected(null);
      void utils.admin.listPackRefundReviews.invalidate();
    },
    onError: error => setMessage(error.message || '未能处理，请刷新后重试。'),
  });
  return (
    <section id="pack-refund-reviews" className="scroll-mt-4 space-y-4 p-4 md:p-8" data-testid="pack-refund-reviews">
      <h2 className="text-xl font-bold">站外退款的积分包</h2>
      <p className="text-sm">这些积分包在 Stripe 后台或支付渠道客服处被全额退款，积分已冻结、用户暂时用不了。请决定是否收回还没用掉的积分：
        选“收回”会扣回这个积分包剩余的积分（余额不够的部分由 Graylum 承担）；选“不收回”会解冻，积分变成普通余额。处理后不能更改。</p>
      {message ? <p role="status">{message}</p> : null}
      {rows.isError ? <p role="alert">待处理的积分包退款暂时无法读取。</p> : null}
      {rows.isLoading ? <p>正在读取…</p> : null}
      {!rows.isError && !rows.isLoading && rows.data?.length === 0 ? <p>暂无待处理的积分包退款。</p> : null}
      {rows.data?.map(row => (
        <article key={row.orderId} className="space-y-2 rounded-xl border p-4" style={{ borderColor: 'var(--border-primary)' }}
          data-testid={`pack-refund-review-${row.orderId}`}>
          <p className="break-all text-sm">订单：{row.orderId} · 用户：{row.userId}</p>
          <p>{row.method ? METHOD[row.method] ?? row.method : '付款方式待核实'} · 退款 {money(row.refundedMinor, row.currency)}
            （原付 {money(row.chargedMinor, row.currency)}）{row.refundedAt ? ` · ${new Date(row.refundedAt).toLocaleString('zh-CN')}` : ''}</p>
          <p>积分包积分：{credits(row.packCredits)} · 退款时用户余额：{credits(row.balanceAtRefund)}</p>
          {selected?.orderId === row.orderId ? (
            <div className="space-y-2">
              <p role="alert">{selected.decision === 'clawback'
                ? '确认收回这个积分包还没用掉的积分？' : '确认不收回？积分会解冻，用户可以继续使用。'}处理后不能更改。</p>
              <Button disabled={settle.isPending} data-testid="pack-refund-review-confirm"
                onClick={() => settle.mutate({ orderId: row.orderId, decision: selected.decision })}>确认</Button>
              <Button variant="outline" disabled={settle.isPending} onClick={() => setSelected(null)}>返回</Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => { setSelected({ orderId: row.orderId, decision: 'clawback' }); setMessage(''); }}>
                收回剩余积分</Button>
              <Button variant="outline" onClick={() => { setSelected({ orderId: row.orderId, decision: 'kept' }); setMessage(''); }}>
                不收回</Button>
            </div>
          )}
        </article>
      ))}
    </section>
  );
}
