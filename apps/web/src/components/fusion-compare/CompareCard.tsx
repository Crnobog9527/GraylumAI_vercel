/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Square } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { MessageMarkdown } from '@/components/chat/MessageMarkdown';
import { chargedCredits, columnPhase, compareErrorText, heldCredits, stoppedLabel, type ColumnPhase, type ReadColumn } from './compare-view';
import styles from './compare.module.css';

type View = { compareId: string; state: string; question?: string | null; chargedCredits?: number; columns: ReadColumn[];
  adoption?: { column: number; executionId: string } | null };
type Live = { text: string; streaming: boolean };

const PHASE_LABEL: Record<ColumnPhase, string> = { queued: '排队中', streaming: '生成中', done: '已完成', failed: '没有生成出来，不收费',
  pending: '结果待核对', stopped: '已停止，不收费' };
const newId = () => crypto.randomUUID();

/**
 * One compare in the conversation (FUSION-COMPARE §3.5, §4.4): every model's answer side by side, each streaming on its own
 * request (phones switch columns with tabs); stop all or one; "用这个回答继续" writes the pair into the main conversation,
 * or, when the conversation moved on, hands the answer back as a quote for the composer. After the end each column shows
 * what it actually cost and the total.
 */
export function CompareCard({ compareId, names, onAdopted, onQuote }: {
  compareId: string;
  /** The real configured model names, by model id (Owner 2026-10-17 Q1). */
  names: Record<string, string>;
  onAdopted: () => void;
  onQuote: (text: string) => void;
}) {
  const utils = trpc.useUtils();
  const [live, setLive] = useState<Record<number, Live>>({});
  const [tab, setTab] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(new Set<number>());
  const attempts = useRef(new Map<number, number>());
  const [retryTick, setRetryTick] = useState(0);
  const adoptRequest = useRef<{ column: number; id: string } | null>(null);
  const streaming = Object.values(live).some(column => column.streaming);
  const view = trpc.fusionCompare.read.useQuery({ compareId }, {
    retry: false, refetchInterval: query => {
      const data = query.state.data as View | undefined;
      return !data || data.state === 'running' || streaming ? 2000 : false;
    } });
  const stop = trpc.fusionCompare.stop.useMutation({ onSettled: () => void view.refetch() });
  const adopt = trpc.fusionCompare.adopt.useMutation();
  const data = view.data as View | undefined;

  // Each column that has not been dispatched is asked for once by this tab; a reload asks again and the server answers
  // "already" for a column another request dispatched (it is then read, not streamed).
  useEffect(() => {
    if (!data || data.state !== 'running') return;
    for (const column of data.columns) {
      if (started.current.has(column.column) || columnPhase(column, data.state) !== 'queued') continue;
      started.current.add(column.column);
      void (async () => {
        setLive(old => ({ ...old, [column.column]: { text: '', streaming: true } }));
        try {
          const events = await utils.client.fusionCompare.stream.mutate({ compareId, column: column.column });
          for await (const event of events) {
            if (event.type === 'delta') setLive(old => ({ ...old, [column.column]: { text: (old[column.column]?.text ?? '') + event.text, streaming: true } }));
          }
        } catch (cause) { setError(compareErrorText(cause)); }
        finally {
          setLive(old => ({ ...old, [column.column]: { text: old[column.column]?.text ?? '', streaming: false } }));
          // The column may still be undispatched (the server released its claim after a failure before anything was sent):
          // ask for it again, a few times and not in a tight loop, so it neither needs a page reload nor hammers the server.
          const fresh = (await view.refetch()).data as View | undefined;
          const again = fresh?.columns.find(item => item.column === column.column);
          const tries = (attempts.current.get(column.column) ?? 0) + 1;
          attempts.current.set(column.column, tries);
          if (fresh?.state === 'running' && again && columnPhase(again, fresh.state) === 'queued' && tries < 3) {
            setTimeout(() => { started.current.delete(column.column); setRetryTick(tick => tick + 1); }, 2000);
          }
        }
      })();
    }
  }, [data, compareId, utils, view, retryTick]);

  if (!data) return <section className={styles.card} aria-busy="true"><p className={styles.muted}>正在读取对比…</p></section>;
  const adoptedColumn = data.adoption?.column ?? null;
  const ended = data.state !== 'running' && !streaming;

  async function adoptAnswer(column: number) {
    if (adopt.isPending) return;
    // The same click repeated (double click, retry after a lost response) reuses its request id: written once.
    if (adoptRequest.current?.column !== column) adoptRequest.current = { column, id: newId() };
    try {
      const result = await adopt.mutateAsync({ compareId, column, requestId: adoptRequest.current.id });
      if (result.state === 'stale') { adoptRequest.current = null; onQuote(result.quote); return; }
      await view.refetch();
      onAdopted();
    } catch (cause) { setError(compareErrorText(cause)); }
  }

  return (
    <section className={styles.card} aria-label="多模型对比">
      <header className={styles.head}>
        <strong>多模型对比</strong>
        {data.question && <p className={styles.question}>{data.question}</p>}
        {!ended && <button type="button" className={styles.ghost} disabled={stop.isPending}
          onClick={() => stop.mutate({ compareId })}><Square size={14} /> 全部停止</button>}
      </header>
      <div className={styles.tabs} role="tablist" aria-label="切换模型">
        {data.columns.map(column => <button key={column.column} type="button" role="tab" aria-selected={tab === column.column}
          onClick={() => setTab(column.column)}>{names[column.modelId] ?? '模型'}</button>)}
      </div>
      <div className={styles.columns}>
        {data.columns.map(column => {
          const own = live[column.column];
          const phase: ColumnPhase = own?.streaming ? 'streaming' : columnPhase(column, data.state);
          const text = column.body ?? own?.text ?? '';
          return (
            <article key={column.column} className={styles.column} data-active={tab === column.column} aria-label={names[column.modelId] ?? '模型'}>
              <div className={styles.columnHead}>
                <strong>{names[column.modelId] ?? '模型'}</strong>
                <span className={styles.phase} data-phase={phase}>
                  {phase === 'streaming' && <Loader2 size={13} className={styles.spin} />}
                  {phase === 'pending' ? `结果待核对，暂时冻结 ${heldCredits(column)} 积分` : phase === 'stopped' ? stoppedLabel(column) : PHASE_LABEL[phase]}
                </span>
              </div>
              <div className={styles.answer}>{text ? <MessageMarkdown text={text} streaming={phase === 'streaming'} /> : <p className={styles.muted}>{
                phase === 'queued' || phase === 'streaming' ? '正在生成…' : '没有回答'}</p>}</div>
              <footer className={styles.columnFoot}>
                {ended && <span>实际扣费 {chargedCredits(column)} 积分</span>}
                {phase === 'streaming' && <button type="button" className={styles.ghost} disabled={stop.isPending}
                  onClick={() => stop.mutate({ compareId, column: column.column })}>停止这一列</button>}
                {adoptedColumn === column.column && <span className={styles.adopted}><Check size={14} /> 已用这个回答继续</span>}
                {adoptedColumn === null && phase === 'done' && <button type="button" className={styles.primary} disabled={adopt.isPending}
                  onClick={() => void adoptAnswer(column.column)}>用这个回答继续</button>}
              </footer>
            </article>
          );
        })}
      </div>
      {ended && <p className={styles.total}>本次对比共扣 {data.chargedCredits ?? 0} 积分（各列分别结算，只有生成出回答的列收费）</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </section>
  );
}
