/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/trpc/client";
import { BenchmarkTable } from "./benchmark-table";
import { CandidateCardView } from "./candidate-card";
import { KeywordCardView } from "./keyword-card";
import { shortfallChoiceInput, ShortfallCardView, type ShortfallCard, type ShortfallChoice } from "./shortfall-card";
import type { ResearchCall } from "./research-model";
import {
  isResearchEvent, REPORT_MIN_QUALIFIED, researchConfirmedInput, researchRefreshInput, toBenchmarkRows, toSessionCards, withResearchCall,
  type CallsByExecution, type StoredBenchmark, type StoredCard,
} from "./research-session-model";
import type { CandidateSubmission, CardConfirmation, KeywordSubmission } from "./selection-card-model";
import styles from "./research.module.css";

const NO_CALLS: readonly ResearchCall[] = [];
/** How long the refresh buttons stay locked after a refresh message when the page never starts a turn for it. */
export const REFRESH_LOCK_MS = 8000;

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
    // Benchmark rows are written after a call's final event; the panel re-reads them once the turn is saved.
    if (event.type === "research_call") setCalls(current => withResearchCall(current, executionId, event));
    else if (sessionId) void utils.research.cards.invalidate({ sessionId });
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
  /**
   * The conversation cannot take an answer right now: a reply is running, the draft is read-only, or another step
   * than the latest mentor turn's is shown (the continuation is sent on the shown step).
   */
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
export function ResearchSessionBenchmarks({ sessionId, disabled = false, onRefresh }: {
  sessionId: string;
  /** The conversation cannot take a message now (a reply is running, another step is shown). */
  disabled?: boolean;
  /** Called with the granted refresh id and the row once the host issued the one-time grant. */
  onRefresh?: (grant: { refreshId: string; platform: string; account: string }) => Promise<void>;
}) {
  const createRefresh = trpc.research.createRefresh.useMutation();
  const table = trpc.research.benchmarks.useQuery({ sessionId }, { staleTime: 30_000 });
  const [lock, setLock] = useState<"idle" | "creating" | "sent">("idle");
  const turnSeen = useRef(false);
  // One refresh at a time for the whole table: from the click until the message it started has been answered. A
  // message the page did not take (it was busy) never starts a turn, so the lock also ends after a short wait.
  useEffect(() => {
    if (lock !== "sent") return;
    if (disabled) { turnSeen.current = true; return; }
    if (turnSeen.current) { turnSeen.current = false; setLock("idle"); return; }
    const timer = setTimeout(() => setLock("idle"), REFRESH_LOCK_MS);
    return () => clearTimeout(timer);
  }, [lock, disabled]);
  const shortfall = trpc.research.shortfall.useQuery({ sessionId }, { staleTime: 30_000 });
  const { rows, fetchedAt } = toBenchmarkRows((table.data?.items ?? []) as StoredBenchmark[]);
  if (rows.length === 0) return table.error ? <p role="alert" className={styles.problem}>对标表没有读到，请刷新页面再试。</p> : null;
  const qualified = rows.filter(row => row.qualified).length;
  return (
    <BenchmarkTable rows={rows} fetchedAt={fetchedAt} refreshDisabled={disabled || lock !== "idle"}
      onRefresh={onRefresh && (async row => {
        if (lock !== "idle") throw new Error("RESEARCH_REFRESH_BUSY");
        setLock("creating");
        try {
          const { refreshId } = await createRefresh.mutateAsync({ sessionId, platform: row.platform, account: row.account });
          await onRefresh({ refreshId, platform: row.platform, account: row.account });
        } catch (error) {
          setLock("idle");
          throw error;
        }
        turnSeen.current = false;
        setLock("sent");
      })}>
      {qualified < REPORT_MIN_QUALIFIED && (qualified > 0 && shortfall.data?.card?.choice === "generate"
        ? <p className={styles.hint}>你已选择用现有 {qualified} 个对标先生成报告，报告里会注明对标样本不足。</p>
        : <p className={styles.hint}>
          生成定位报告需要至少 {REPORT_MIN_QUALIFIED} 个可以照着学的对标账号，目前 {qualified} 个。可以换关键词再找，或直接贴对标账号的主页链接。</p>)}
    </BenchmarkTable>
  );
}

/**
 * The shortfall choice card (0318), once the host offered it. The choice is stored once; `onChosen` then lets the
 * page tell the coach what the user picked.
 */
export function ResearchShortfallCard({ sessionId, disabled, onChosen }: {
  sessionId: string;
  disabled: boolean;
  onChosen?: (choice: ShortfallChoice, qualified: number) => void;
}) {
  const utils = trpc.useUtils();
  const shortfall = trpc.research.shortfall.useQuery({ sessionId }, { staleTime: 30_000 });
  const choose = trpc.research.chooseShortfall.useMutation();
  const card = shortfall.data?.card as ShortfallCard | null | undefined;
  if (!card) return null;
  return (
    <ShortfallCardView card={card} disabled={disabled} onChoose={async choice => {
      const saved = await choose.mutateAsync({ cardId: card.cardId, choice });
      await utils.research.shortfall.invalidate({ sessionId });
      onChosen?.(choice, saved.chosenQualified ?? card.offeredQualified);
    }}/>
  );
}

/**
 * Cards, then the benchmark table, under the positioning conversation. `settledTurns` counts the session's saved
 * mentor turns: each new one re-reads both, since a turn's account fetches commit their rows only as it finishes.
 * `onSend` sends one mentor message on the page's behalf: after a card is confirmed, and for a refresh (with the
 * one-time grant the host issued).
 */
export function ResearchSessionPanel({ settledTurns, onSend, ...props }: Omit<Parameters<typeof ResearchSessionCards>[0], "onConfirmed"> & {
  settledTurns: number;
  onSend: (text: string, researchRefreshId?: string) => void | Promise<void>;
}) {
  const utils = trpc.useUtils();
  const { sessionId } = props;
  const seen = useRef(settledTurns);
  useEffect(() => {
    if (seen.current === settledTurns) return;
    seen.current = settledTurns;
    void utils.research.cards.invalidate({ sessionId });
    void utils.research.benchmarks.invalidate({ sessionId });
    void utils.research.shortfall.invalidate({ sessionId });
  }, [settledTurns, sessionId, utils]);
  return (
    <>
      <ResearchSessionCards {...props} onConfirmed={confirmation => void onSend(researchConfirmedInput(confirmation))}/>
      <ResearchShortfallCard sessionId={sessionId} disabled={props.disabled}
        onChosen={(choice, qualified) => void onSend(shortfallChoiceInput(choice, qualified))}/>
      <ResearchSessionBenchmarks sessionId={sessionId} disabled={props.disabled}
        onRefresh={async grant => void onSend(researchRefreshInput(grant.platform, grant.account), grant.refreshId)}/>
    </>
  );
}
