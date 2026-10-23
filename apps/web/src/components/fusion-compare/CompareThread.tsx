/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { trpc } from '@/trpc/client';
import { CompareCard } from './CompareCard';

export type CompareCardRow = { compareId: string; state: string; createdAt: string; adoption?: { executionId?: string } | null };
type Card = CompareCardRow;

/** Where each card goes in the transcript: after the last turn that started before it (-1: before every turn), so a compare
 * sits where it was asked and later turns follow it. */
export function placeCompareCards(cards: readonly Card[], turns: ReadonlyArray<{ createdAt?: string }> | undefined): Map<number, Card[]> {
  const placed = new Map<number, Card[]>();
  for (const card of cards) {
    let at = -1;
    const asked = Date.parse(card.createdAt);
    (turns ?? []).forEach((turn, index) => { if (turn.createdAt && Date.parse(turn.createdAt) <= asked) at = index; });
    placed.set(at, [...(placed.get(at) ?? []), card]);
  }
  return placed;
}

/**
 * The compares of one conversation, for the free-conversation page (FUSION-COMPARE §3.4): `cards` to place by time next to the
 * history, `adoptedExecutions` to show those answers as ordinary replies (the server writes the execution id at adoption, so
 * the page cannot mark anything itself), and the real model names for the column titles.
 */
export function useCompareThread(sessionId: string | null) {
  // The conversation's existing compares are listed whatever the switch, the plan or the allowlist say now: only the new-compare
  // button depends on eligibility. A compare still running must keep its controls (dispatch, stop) and a finished one its answers.
  const list = trpc.fusionCompare.list.useQuery({ sessionId: sessionId ?? '' }, { enabled: Boolean(sessionId), retry: false });
  const data = list.data as { cards: Card[]; names: Record<string, string> } | undefined;
  const cards = data?.cards ?? [];
  // Real model names of exactly the models these cards used (server-resolved), not today's allowlist.
  const names = data?.names ?? {};
  const adoptedExecutions = new Set(cards.map(card => card.adoption?.executionId).filter((id): id is string => Boolean(id)));
  return { cards, names, adoptedExecutions, refresh: () => list.refetch() };
}

/** One card per compare, oldest first; `onAdopted` lets the page re-read its history, `onQuote` prefills the composer. */
export function CompareThread({ cards, names, onAdopted, onQuote }: {
  cards: Card[]; names: Record<string, string>; onAdopted: () => void; onQuote: (text: string) => void;
}) {
  return <>{cards.map(card => <CompareCard key={card.compareId} compareId={card.compareId} names={names}
    onAdopted={onAdopted} onQuote={onQuote} />)}</>;
}
