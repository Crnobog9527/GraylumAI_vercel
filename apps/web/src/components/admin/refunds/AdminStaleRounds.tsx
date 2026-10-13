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

type Evidence = { model: string | null; streamed: boolean; executionState: string; unavailableReason: string | null;
  calls: number; outputTokens: number; savedReplyChars: number; lastActivityAt: string | null; lastFinishReason: string | null };
/** Known limit (Owner 2026-10-13, option B): content beyond capacity leaves no server trace, so the operator decides. */
export const CAPACITY_RULE = '超出内容容量（用户材料过长）的回合不应补偿；用户反馈过内容太长时不要补偿。';
const stateLabels: Readonly<Record<string, string>> = { prepared: '未开始', running: '进行中', interrupted: '中断', cost_pending: '费用已核实、未收口' };

/** Content-free review facts; a streamed round that produced output may already have been seen. */
export function reviewCaution(evidence: Evidence): string | null {
  if (evidence.savedReplyChars > 0) return '这一轮已保存了回复内容，用户很可能已经拿到答案，一般不应补偿。';
  if (evidence.streamed && evidence.outputTokens > 0) return '这一轮是边生成边显示的，模型已输出内容，用户可能已看到部分回答，请谨慎核对。';
  if (evidence.lastFinishReason === 'tool_calls')
    return '最后一次调用要求继续调用工具，但之后没有新的调用：可能是系统异常，也可能是用户材料超出容量，请结合用户反馈判断。';
  return null;
}

/** The operator-facing sentence for a compensation outcome; an unknown failure never claims a result. */
export function compensationMessage(outcome: { state: string; compensatedCredits: number; auditRecorded?: boolean } | { error: string }): string {
  if ('error' in outcome) return refusals[outcome.error] ?? '补偿失败，结果未确认。请刷新后查看这一轮的状态，不要重复操作。';
  if (outcome.state === 'already_compensated') return '这一轮之前已经补偿过，没有重复退款。';
  // The refund itself is final; only the admin activity entry is missing. Never retry the refund for it.
  return outcome.auditRecorded === false
    ? `已补偿 ${outcome.compensatedCredits} 积分，但管理员操作日志没有记录成功，请把这一轮的计费编号报告给技术处理，不要重复补偿。`
    : `已补偿 ${outcome.compensatedCredits} 积分。`;
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
        <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>{CAPACITY_RULE}</p>
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
                  <p data-testid="stale-round-user">用户 {round.userEmail ?? '（邮箱未读到）'} · 账号 {round.actorId}</p>
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }} data-testid="stale-round-evidence">
                    {round.evidence.model ?? '未知模型'} · {round.evidence.streamed ? '边生成边显示' : '一次性显示'} ·
                    状态 {stateLabels[round.evidence.executionState] ?? round.evidence.executionState}
                    {round.evidence.unavailableReason ? `（${round.evidence.unavailableReason}）` : ''} ·
                    调用 {round.evidence.calls} 次 · 模型输出 {round.evidence.outputTokens} token ·
                    已保存回复 {round.evidence.savedReplyChars} 字
                    {round.evidence.lastFinishReason ? ` · 最后一次调用结束原因 ${round.evidence.lastFinishReason}` : ''}
                    {round.evidence.lastActivityAt ? ` · 最后活动 ${new Date(round.evidence.lastActivityAt).toLocaleString('zh-CN')}` : ''}
                  </p>
                  {reviewCaution(round.evidence)
                    ? <p role="note" className="text-xs" style={{ color: 'var(--warning, var(--error))' }}>{reviewCaution(round.evidence)}</p> : null}
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>执行 {round.executionId} · 计费 {round.runId}</p>
                </div>
                <ConfirmRefundAction testId={`stale-round-compensate-${round.runId}`} label="核对后补偿" pendingLabel="正在补偿…"
                  title="确认补偿这一轮？" confirmLabel="确认补偿" pending={compensate.isPending}
                  onConfirm={() => { setMessage(null); compensate.mutate({ runId: round.runId }); }}>
                  <p>将结束这一轮，并把它已扣的 {round.chargedCredits} 积分全部退回给用户 {round.userEmail ?? round.actorId}。补偿只会发生一次。</p>
                  <p>请确认这一轮确实没有给出回答（已保存回复 {round.evidence.savedReplyChars} 字、模型输出 {round.evidence.outputTokens} token），而且不是用户侧原因。</p>
                  {reviewCaution(round.evidence) ? <p>{reviewCaution(round.evidence)}</p> : null}
                  <p>{CAPACITY_RULE}</p>
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
