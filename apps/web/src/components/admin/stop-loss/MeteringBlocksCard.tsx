/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { STOP_LOSS_QUERY_OPTIONS } from './stopLossFormat';

/** "0.300000000000" -> "$0.3": the exact stored amount without its padding zeros; a missing cost is said, never shown as 0. */
export function exactUsd(value: string | null) {
  if (value === null) return '未知';
  return `$${value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value}`;
}

const REVIEW_FAILURES: Record<string, string> = { TURN_ADMIN_DENIED: '没有权限。' };

/**
 * The models every user is refused right now (metering block): one of the model's calls cost more than the bound frozen for it, so the
 * system stopped new calls to it until an administrator has checked its price. "已核对价格，恢复调用" lets the model through again; it
 * changes no price, no charge and no settlement, is idempotent and leaves an audit row.
 */
export function MeteringBlocksCard() {
  const view = trpc.billingReport.meteringBlocks.useQuery(undefined, STOP_LOSS_QUERY_OPTIONS);
  const utils = trpc.useUtils();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const review = trpc.billingReport.reviewMeteringBlock.useMutation({
    onSuccess: (result) => {
      setNotes((all) => ({ ...all, [result.modelId]: result.reviewed > 0
        ? `已恢复调用（核对了 ${result.reviewed} 条超上限的调用记录）。` : '这个模型已经恢复，没有再改。' }));
      void utils.billingReport.meteringBlocks.invalidate();
    },
    onError: (error, variables) => setNotes((all) => ({ ...all,
      [variables.modelId]: REVIEW_FAILURES[error.message] ?? '恢复失败，模型仍然暂停。请稍后重试。' })),
  });
  const confirmReview = (block: { modelId: string; model: string | null }) => {
    const question = `确认恢复模型「${block.model ?? block.modelId}」的调用？请先在“模型管理”核对它的价格和线路。`
      + '恢复只是放行新调用，不改任何价格、扣费和结算；之后如果再有调用超过上限，会再次暂停。此操作会留下审计记录。';
    if (window.confirm(question)) review.mutate({ modelId: block.modelId });
  };
  const data = view.data;
  // A model just let through leaves the list; its note stays below it.
  const listed = new Set(data?.available ? data.blocks.map(block => block.modelId) : []);
  const reviewedNotes = Object.entries(notes).filter(([modelId]) => !listed.has(modelId));
  return <section aria-labelledby="metering-blocks-title" className="space-y-3 rounded-md border p-4" data-testid="metering-blocks">
    <h3 id="metering-blocks-title" className="font-medium">被暂停的模型</h3>
    <p className="text-sm">
      某个模型有一次调用的费用超过了开始调用时冻结的上限，系统就会暂停所有用户对这个模型的新调用（被拦下的对话不扣积分），直到这里确认。
      多半是供应商调了价、而我们的价格快照还没更新：先到“模型管理”核对价格和线路，再点“已核对价格，恢复调用”。
    </p>
    {view.error ? <div role="alert">无法读取，请稍后重试。</div>
      : !data ? <p>读取中…</p>
      : !data.available ? <p role="alert">列表暂不可用（数据库读取函数尚未应用或读取失败）；这里不显示“没有”冒充正常。</p>
      : data.blocks.length === 0 ? <p>当前没有被暂停的模型。</p>
      : <div className="overflow-x-auto"><table className="w-full min-w-max text-sm"><thead><tr>
        <th className="text-left">模型</th><th className="text-right">超上限的调用</th><th className="text-left">最早一次</th>
        <th className="text-left">超得最多的一次（回合）</th><th className="text-right">冻结上限</th>
        <th className="text-right">名义费用</th><th className="text-right">实际费用</th><th className="text-left">操作</th>
      </tr></thead><tbody>{data.blocks.map((block) => <tr key={block.modelId}>
        <td>{block.model ?? block.modelId}</td><td className="text-right">{block.calls}</td><td>{block.firstAt ?? '—'}</td>
        <td>{block.turnId}</td><td className="text-right">{exactUsd(block.upperUsd)}</td>
        <td className="text-right">{exactUsd(block.nominalUsd)}</td><td className="text-right">{exactUsd(block.actualUsd)}</td>
        <td><Button variant="outline" disabled={review.isPending} onClick={() => confirmReview(block)}>已核对价格，恢复调用</Button>
          {notes[block.modelId] && <span role="status" className="ml-2 text-xs">{notes[block.modelId]}</span>}</td>
      </tr>)}</tbody></table></div>}
    {reviewedNotes.map(([modelId, note]) => <p key={modelId} role="status" className="text-sm">{note}</p>)}
  </section>;
}
