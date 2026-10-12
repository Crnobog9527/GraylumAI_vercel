/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { ConfirmRefundAction } from './ConfirmRefundAction';

const cardStyle = { background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' };
const refusals: Readonly<Record<string, string>> = {
  STALE_ROUND_NOT_ELIGIBLE: '这一轮已不符合补偿条件（可能已结束、用户已停止或出现了结果未知的调用），没有退款。请刷新后再看。',
  STALE_ROUND_NOT_FOUND: '找不到这一轮，没有退款。请刷新后再看。',
};

/** The operator-facing sentence for a compensation outcome; an unknown failure never claims a result. */
export function compensationMessage(outcome: { state: string; compensatedCredits: number } | { error: string }): string {
  if ('error' in outcome) return refusals[outcome.error] ?? '补偿失败，结果未确认。请刷新后查看这一轮的状态，不要重复操作。';
  return outcome.state === 'already_compensated' ? '这一轮之前已经补偿过，没有重复退款。' : `已补偿 ${outcome.compensatedCredits} 积分。`;
}

/**
 * 未收口回合补偿（Owner 2026-10-12）：每日对账列出超过 24 小时仍未结束、已扣积分、没有结果未知调用的回合。
 * 管理员核对这一轮确实没有给出回答、且不是用户自己的原因后补偿；服务端整轮结束并按原扣费逐笔退回，只会退一次。
 */
export function AdminStaleRounds() {
  const utils = trpc.useUtils();
  const report = trpc.adminStaleRounds.list.useQuery();
  const [message, setMessage] = useState<string | null>(null);
  const compensate = trpc.adminStaleRounds.compensate.useMutation({
    onSuccess: result => { setMessage(compensationMessage(result)); void utils.adminStaleRounds.list.invalidate(); },
    onError: error => setMessage(compensationMessage({ error: error.message })),
  });

  return (
    <section className="space-y-4 rounded-xl border p-4 mx-4 md:mx-8 mb-8" style={cardStyle} data-testid="stale-rounds">
      <div>
        <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>未收口回合补偿</h2>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-tertiary)' }}>
          已扣积分、超过 24 小时仍未结束、也没有结果未知调用的对话回合。先核对这一轮确实没有给出回答、且不是用户自己的原因，再补偿。
        </p>
      </div>
      {message ? <p role="status" className="text-sm" style={{ color: 'var(--text-secondary)' }}>{message}</p> : null}
      {report.isLoading ? <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>正在读取…</p>
        : report.error ? <p role="alert" className="text-sm" style={{ color: 'var(--error)' }}>读取失败，请稍后刷新。</p>
        : !report.data?.findings.length ? <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>目前没有需要处理的回合。</p>
        : (
          <ul className="space-y-3">
            {report.data.findings.map(round => (
              <li key={round.runId} className="flex flex-col gap-2 rounded-lg border p-3 md:flex-row md:items-center md:justify-between"
                style={{ borderColor: 'var(--border-primary)' }} data-testid="stale-round">
                <div className="space-y-1 text-sm break-all" style={{ color: 'var(--text-secondary)' }}>
                  <p>已扣 {round.chargedCredits} 积分 · 开始于 {new Date(round.since).toLocaleString('zh-CN')}</p>
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>执行 {round.executionId} · 计费 {round.runId}</p>
                </div>
                <ConfirmRefundAction testId={`stale-round-compensate-${round.runId}`} label="核对后补偿" pendingLabel="正在补偿…"
                  title="确认补偿这一轮？" confirmLabel="确认补偿" pending={compensate.isPending}
                  onConfirm={() => { setMessage(null); compensate.mutate({ runId: round.runId }); }}>
                  <p>将结束这一轮，并把它已扣的 {round.chargedCredits} 积分全部退回给用户。补偿只会发生一次。</p>
                  <p>请确认这一轮确实没有给出回答，而且不是用户自己停止或其他用户侧原因。</p>
                </ConfirmRefundAction>
              </li>
            ))}
          </ul>
        )}
      {report.data?.truncated ? (
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          共 {report.data.total} 个回合，这里只显示前 {report.data.findings.length} 个，处理完后刷新查看其余的。
        </p>
      ) : null}
    </section>
  );
}
