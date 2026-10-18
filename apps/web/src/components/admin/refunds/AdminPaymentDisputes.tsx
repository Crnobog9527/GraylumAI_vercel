/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';

const statusLabel: Record<string, string> = { pending: '等待处理', frozen: '冻结中', withdrawn: '已撤回',
  superseded: '已被退款取代', review: '待核对', external: '已确认站外付款', confirmed: '已确认停止', manual: '请人工处理',
  not_applicable: '无需续费', needs_response: '等待应对', under_review: '审核中', warning_needs_response: '预警待应对',
  warning_under_review: '预警审核中', warning_closed: '预警已结束', won: '已判赢', lost: '已判输', prevented: '已阻止' };
const label = (state: string) => statusLabel[state] ?? '待核对';

export function AdminPaymentDisputes() {
  const [offset, setOffset] = useState(0);
  const rows = trpc.paymentDisputes.list.useQuery({ offset });
  const utils = trpc.useUtils();
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const withdraw = trpc.paymentDisputes.withdraw.useMutation({
    onSuccess: result => {
      setMessage(`已撤回冻结，恢复 ${result.restored} 积分。订阅继续保持停止续费；如需补发未发出的分期，请人工核对。`);
      setSelected(null);
      void utils.paymentDisputes.invalidate();
      void utils.payments.invalidate();
    },
    onError: () => setMessage('冻结未撤回，请核对付款和拒付状态后重试。'),
  });
  return (
    <section className="space-y-4 p-4 md:p-8" data-testid="payment-disputes">
      <h2 className="text-xl font-bold">付款争议</h2>
      <p className="text-sm">收到拒付后会暂停相关权益和积分，并停止续费。结案不会自动解冻，请先在 Stripe 核对。</p>
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
      {rows.data?.map(row => (
        <article key={row.id} className="space-y-2 rounded-xl border p-4" style={{ borderColor: 'var(--border-primary)' }}>
          <p className="break-all text-sm">订单：{row.order_id ?? '等待匹配'}</p>
          <p>{(Number(row.amount) / 100).toFixed(2)} {row.currency.toUpperCase()} · 拒付：{label(row.status)}</p>
          <p>冻结：{label(row.freeze_state)} · 停续费：{label(row.renewal_stop_state)}</p>
          {row.evidence_due_by ? <p>举证截止：{new Date(row.evidence_due_by).toLocaleString('zh-CN')}</p> : null}
          {row.source_review_required ? <p role="alert">积分来源无法核实，未扣取无法确认的积分，请人工核对。</p> : null}
          {row.freeze_state === 'frozen' ? (
            selected === row.id ? <div className="space-y-2">
              <p>确认撤回这笔冻结？这会恢复仍属于该付款的权益和积分，自动续费继续保持停止。</p>
              <Button disabled={withdraw.isPending} onClick={() => withdraw.mutate({ disputeId: row.id })}>确认撤回冻结</Button>
              <Button variant="outline" disabled={withdraw.isPending} onClick={() => setSelected(null)}>返回</Button>
            </div> : <Button variant="outline" onClick={() => setSelected(row.id)}>撤回冻结</Button>
          ) : null}
        </article>
      ))}
    </section>
  );
}
