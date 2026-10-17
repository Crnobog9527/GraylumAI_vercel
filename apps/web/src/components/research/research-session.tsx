/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";

import { useCallback, useState } from "react";
import { trpc } from "@/trpc/client";
import { CandidateCardView } from "./candidate-card";
import { KeywordCardView } from "./keyword-card";
import type { ResearchCall } from "./research-model";
import {
  isResearchEvent, toSessionCards, withResearchCall, type CallsByExecution, type StoredCard,
} from "./research-session-model";
import type { CardConfirmation } from "./selection-card-model";
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
  /** The conversation cannot take an answer right now (a reply is running, the draft is read-only). */
  disabled: boolean;
  onConfirmed?: (confirmation: CardConfirmation) => void;
}) {
  const utils = trpc.useUtils();
  const cards = trpc.research.cards.useQuery({ sessionId }, { staleTime: 30_000 });
  const confirm = trpc.research.confirmCard.useMutation();
  const rows = cards.data ? toSessionCards(cards.data.items as StoredCard[]) : [];
  if (rows.length === 0) {
    return cards.error ? <p role="alert" className={styles.problem}>选择卡没有读到，请刷新页面再试。</p> : null;
  }
  const submit = async (cardId: string, submission: object) => {
    const confirmation = await confirm.mutateAsync({ cardId, ...submission }) as CardConfirmation;
    await utils.research.cards.invalidate({ sessionId });
    onConfirmed?.(confirmation);
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
