/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";

import { useCallback, useState } from "react";
import { trpc } from "@/trpc/client";
import { BenchmarkTable } from "./benchmark-table";
import { CandidateCardView } from "./candidate-card";
import { KeywordCardView } from "./keyword-card";
import type { ResearchCall } from "./research-model";
import {
  isResearchEvent, REPORT_MIN_QUALIFIED, toBenchmarkRows, toSessionCards, withResearchCall,
  type CallsByExecution, type StoredBenchmark, type StoredCard,
} from "./research-session-model";
import type { CandidateSubmission, CardConfirmation, KeywordSubmission } from "./selection-card-model";
import styles from "./research.module.css";

const NO_CALLS: readonly ResearchCall[] = [];

/**
 * The research calls of this page's mentor turns, from the stream. `observe` takes every Agent turn event and
 * keeps the research ones; a selection card makes the session's stored cards be read again, so the card shown is
 * always the host's copy.
 */
export function useResearchCalls(sessionId: string | null | undefined) {
  const utils = trpc.useUtils();
  const [calls, setCalls] = useState<CallsByExecution>(() => new Map());
  const observe = useCallback((executionId: string, event: { type: string }) => {
    if (!isResearchEvent(event)) return;
    if (event.type === "research_call") {
      setCalls(current => withResearchCall(current, executionId, event));
      // A finished account fetch may have added or changed a benchmark row.
      if (sessionId && event.state !== "running" && event.toolName === "benchmark_fetch") {
        void utils.research.benchmarks.invalidate({ sessionId });
      }
    } else if (sessionId) void utils.research.cards.invalidate({ sessionId });
  }, [sessionId, utils]);
  const of = useCallback((executionId: string) => calls.get(executionId) ?? NO_CALLS, [calls]);
  return { observe, of };
}

/**
 * The session's selection cards in the conversation (plan §1.6), oldest first: confirmed ones as a read-only echo,
 * open ones to answer. Each card is confirmed once through `research.confirmCard`; `onConfirmed` then lets the
 * page continue the conversation. Renders nothing while the session has no cards.
 */
export function ResearchSessionCards({ sessionId, disabled, onConfirmed }: {
  sessionId: string;
  /** The conversation cannot take an answer right now (a reply is running, the draft is read-only). */
  disabled: boolean;
  onConfirmed?: (confirmation: CardConfirmation) => void;
}) {
  const utils = trpc.useUtils();
  const cards = trpc.research.cards.useQuery({ sessionId }, { staleTime: 30_000 });
  const confirm = trpc.research.confirmCard.useMutation();
  const rows = toSessionCards((cards.data?.items ?? []) as StoredCard[]);
  if (rows.length === 0) {
    return cards.error ? <p role="alert" className={styles.problem}>选择卡没有读到，请刷新页面再试。</p> : null;
  }
  const submit = async (cardId: string, submission: KeywordSubmission | CandidateSubmission) => {
    const confirmation = await confirm.mutateAsync({ cardId, ...submission }) as CardConfirmation;
    onConfirmed?.(confirmation);
    void utils.research.cards.invalidate({ sessionId });
    return confirmation;
  };
  return (
    <div aria-label="研究选择卡" className="space-y-3">
      {rows.map(({ card, confirmation }) => card.kind === "keywords"
        ? <KeywordCardView key={card.cardId} card={card} confirmation={confirmation} disabled={disabled}
          onConfirm={submission => submit(card.cardId, submission)}/>
        : <CandidateCardView key={card.cardId} card={card} confirmation={confirmation} disabled={disabled}
          onConfirm={submission => submit(card.cardId, submission)}/>)}
    </div>
  );
}

/**
 * This session's benchmark table (plan §1.4) under the conversation, from `research.benchmarks`; nothing until the
 * first account is fetched. Says how many qualified benchmarks the positioning report still needs.
 */
export function ResearchSessionBenchmarks({ sessionId }: { sessionId: string }) {
  const table = trpc.research.benchmarks.useQuery({ sessionId }, { staleTime: 30_000 });
  const { rows, fetchedAt } = toBenchmarkRows((table.data?.items ?? []) as StoredBenchmark[]);
  if (rows.length === 0) return table.error ? <p role="alert" className={styles.problem}>对标表没有读到，请刷新页面再试。</p> : null;
  const qualified = rows.filter(row => row.qualified).length;
  return (
    <BenchmarkTable rows={rows} fetchedAt={fetchedAt}>
      {qualified < REPORT_MIN_QUALIFIED && <p className={styles.hint}>
        生成定位报告需要至少 {REPORT_MIN_QUALIFIED} 个合格的对标账号，目前 {qualified} 个。可以换关键词再找，或直接贴对标账号的主页链接。</p>}
    </BenchmarkTable>
  );
}

/** Cards, then the benchmark table, under the positioning conversation. */
export function ResearchSessionPanel(props: Parameters<typeof ResearchSessionCards>[0]) {
  return (
    <>
      <ResearchSessionCards {...props}/>
      <ResearchSessionBenchmarks sessionId={props.sessionId}/>
    </>
  );
}
