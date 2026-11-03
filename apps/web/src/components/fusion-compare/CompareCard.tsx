/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { useTurnCompareLive } from './turn-compare-live';
import { MessageMarkdown } from '@/components/chat/MessageMarkdown';
import { allSettled, billingSettled, chargedCredits, totalChargedCredits, columnPhase, compareErrorText, heldCredits,
  stoppedLabel, type ColumnPhase, type ReadColumn } from './compare-view';
import styles from './compare.module.css';

type View = { compareId: string; state: string; question?: string | null; chargedCredits?: number; columns: ReadColumn[];
  adoption?: { column: number; executionId?: string } | null };

const PHASE_LABEL: Record<ColumnPhase, string> = { queued: '排队中', streaming: '生成中', done: '已完成', failed: '没有生成出来，不收费',
  pending: '结果待核对', settling: '积分结算中', stopped: '已停止，不收费' };

/**
 * One compare in the conversation (FUSION-COMPARE §3.5, §4.4; CORE-PATH-V2 V2-10): every model's answer side by side. All the
 * columns stream in the one request that started the compare (this tab follows them through the live store, a reload reads the saved
 * state), so there is no stop button. "用这个回答继续" writes the pair into the main conversation, or, when the conversation moved
 * on, hands the answer back as a quote for the composer. After the end each column shows what it actually cost and the total.
 */
export function CompareCard({ compareId, names, onAdopted, onQuote }: {
  compareId: string;
  /** The real configured model names, by model id (Owner 2026-10-17 Q1). */
  names: Record<string, string>;
  onAdopted: () => void;
  onQuote: (text: string) => void;
}) {
  const utils = trpc.useUtils();
  const [tab, setTab] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const refreshedBilling = useRef('');
  const liveTurn = useTurnCompareLive(compareId, true);
  const view = trpc.fusionCompare.turnRead.useQuery({ compareId }, { retry: false, refetchInterval: query => {
    const data = query.state.data as View | undefined;
    if (!data || data.state === 'running' || liveTurn.open) return 2000;
    // Ended but a dispatched column's cost is not confirmed yet: keep looking, slowly, until its billing closes.
    return allSettled(data.columns) ? false : 10_000;
  } });
  const adopt = trpc.fusionCompare.turnAdopt.useMutation();
  const data = view.data as View | undefined;

  // Settlement may finish after the answers. Refresh the wallet and ledger for each new financial snapshot.
  useEffect(() => {
    if (!data) return;
    const settled = data.columns.filter(billingSettled);
    if (!settled.length) return;
    const signature = JSON.stringify([compareId, settled.map(column => [column.runId, chargedCredits(column)])]);
    if (refreshedBilling.current === signature) return;
    refreshedBilling.current = signature;
    void utils.credits.getBalance.invalidate();
    void utils.credits.getCreditTransactions.invalidate();
    void utils.credits.getCreditsSummary.invalidate();
  }, [data, compareId, utils]);

  if (!data) return <section className={styles.card} aria-busy="true"><p className={styles.muted}>正在读取对比…</p></section>;
  const adoptedColumn = data.adoption?.column ?? null;
  const ended = data.state !== 'running' && !liveTurn.open && allSettled(data.columns);

  async function adoptAnswer(column: number) {
    if (adopt.isPending) return;
    try {
      const result = await adopt.mutateAsync({ compareId, column });
      if (result.state === 'stale') { onQuote(result.quote); return; }
      await view.refetch();
      onAdopted();
    } catch (cause) { setError(compareErrorText(cause)); }
  }

  return (
    <section className={styles.card} aria-label="多模型对比">
      <header className={styles.head}>
        <strong>多模型对比</strong>
        {data.question && <p className={styles.question}>{data.question}</p>}
      </header>
      <div className={styles.tabs} role="tablist" aria-label="切换模型">
        {data.columns.map(column => <button key={column.column} type="button" role="tab" aria-selected={tab === column.column}
          onClick={() => setTab(column.column)}>{names[column.modelId] ?? '模型'}</button>)}
      </div>
      <div className={styles.columns}>
        {data.columns.map(column => {
          const own = { text: liveTurn.text[column.column] ?? '', streaming: liveTurn.open && !liveTurn.answered.includes(column.column) };
          const shown = columnPhase(column, data.state);
          // A column nobody has answered yet is being written (this tab's stream, or another's): never "queued".
          const phase: ColumnPhase = own.streaming ? 'streaming' : shown === 'queued' && data.state === 'running' ? 'streaming' : shown;
          const text = column.body ?? own.text;
          return (
            <article key={column.column} className={styles.column} data-active={tab === column.column} aria-label={names[column.modelId] ?? '模型'}>
              <div className={styles.columnHead}>
                <strong>{names[column.modelId] ?? '模型'}</strong>
                <span className={styles.phase} data-phase={phase}>
                  {phase === 'streaming' && <Loader2 size={13} className={styles.spin} />}
                  {phase === 'pending' || phase === 'settling' ? `${PHASE_LABEL[phase]}，暂时冻结 ${heldCredits(column)} 积分`
                    : phase === 'stopped' ? stoppedLabel(column) : PHASE_LABEL[phase]}
                </span>
              </div>
              <div className={styles.answer}>{text ? <MessageMarkdown text={text} streaming={phase === 'streaming'} /> : <p className={styles.muted}>{
                phase === 'queued' || phase === 'streaming' ? '正在生成…' : '没有回答'}</p>}</div>
              <footer className={styles.columnFoot}>
                {ended && <span>实际扣费 {chargedCredits(column)} 积分</span>}
                {adoptedColumn === column.column && <span className={styles.adopted}><Check size={14} /> 已用这个回答继续</span>}
                {adoptedColumn === null && phase === 'done' && <button type="button" className={styles.primary} disabled={adopt.isPending}
                  onClick={() => void adoptAnswer(column.column)}>用这个回答继续</button>}
              </footer>
            </article>
          );
        })}
      </div>
      {ended && <p className={styles.total}>本次对比共扣 {totalChargedCredits(data.columns)} 积分（各列分别结算：未产生用量的列不收费）</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </section>
  );
}
