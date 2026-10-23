/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RT-5 phase 2: research in the positioning conversation. The Agent turn stream reports each research call
// (running, then its end state) and each selection card as it happens; the stream is display only, so cards are
// read back through `research.cards` (a reload, another tab) and calls are kept for as long as this page lives.
// Pure functions only.
import type { ResearchTurnEvent } from "../../../../../packages/api/src/shared/researchTurn";
import type { BenchmarkRow } from "./benchmark-table-model";
import { platformLabel, type ResearchCall } from "./research-model";
import type { CardConfirmation, SelectionCard } from "./selection-card-model";

export type ResearchEvent = ResearchTurnEvent;

/** Research calls this page saw, per execution, in the order they started. */
export type CallsByExecution = ReadonlyMap<string, readonly ResearchCall[]>;

/** Same cap as the server (`RESEARCH_EVENT_LIMIT`): a turn never shows more calls than its stream could carry. */
export const MAX_CALLS_PER_EXECUTION = 128;

export function isResearchEvent(event: { type: string }): event is ResearchEvent {
  return event.type === "research_call" || event.type === "research_card";
}

/**
 * One `research_call` event applied: a new call is appended, a later state of a known call replaces it in place
 * (a paused call resumes with the same id: running → succeeded). A finished call never goes back to running.
 * Returns the same map when nothing changed.
 */
export function withResearchCall(calls: CallsByExecution, executionId: string,
  event: Extract<ResearchEvent, { type: "research_call" }>): CallsByExecution {
  const call: ResearchCall = { ...event };
  delete (call as Partial<typeof event>).type;
  const list = calls.get(executionId) ?? [];
  const index = list.findIndex(item => item.callId === call.callId);
  let next: ResearchCall[];
  if (index < 0) {
    if (list.length >= MAX_CALLS_PER_EXECUTION) return calls;
    next = [...list, call];
  } else {
    const old = list[index]!;
    if (old.state !== "running" && call.state === "running") return calls;
    if (sameCall(old, call)) return calls;
    next = list.map((item, at) => at === index ? call : item);
  }
  const map = new Map(calls);
  map.set(executionId, next);
  return map;
}

const sameCall = (a: ResearchCall, b: ResearchCall) =>
  a.state === b.state && a.query === b.query && a.platform === b.platform && a.dataKind === b.dataKind
  && a.evidenceId === b.evidenceId && a.credits === b.credits;

/** A `research.cards` row: the host's card plus its stored confirmation, if any. */
export type StoredCard = { cardId: string; minSelect: number; maxSelect: number; confirmationId: string | null } & (
  | { kind: "keywords"; options: { id: string; text: string }[]; items: string[] | null }
  | { kind: "candidates"; items: { id: string; platform: string; account: string; evidenceRef: string }[] | null;
      options: { id: string; platform: string; account: string; evidenceRef: string; label?: string; selectable: boolean }[] }
);

export interface SessionCard { card: SelectionCard; confirmation: CardConfirmation | null }

/**
 * Stored cards → what the card components take. A candidate card is a follow-up when an earlier candidate card
 * of the session exists (the host only creates one after the first card's picks fell short); the stored row has
 * no flag for it. Rows whose platform is not a known one are kept: the component shows the raw value.
 */
export function toSessionCards(rows: readonly StoredCard[]): SessionCard[] {
  let candidatesSeen = 0;
  return rows.map(row => {
    if (row.kind === "keywords") {
      const card: SelectionCard = { cardId: row.cardId, kind: "keywords", minSelect: row.minSelect, maxSelect: row.maxSelect,
        options: row.options };
      const confirmation: CardConfirmation | null = row.confirmationId && row.items
        ? { cardId: row.cardId, confirmationId: row.confirmationId, kind: "keywords", items: row.items } : null;
      return { card, confirmation };
    }
    const followUp = candidatesSeen++ > 0;
    const card = { cardId: row.cardId, kind: "candidates", minSelect: row.minSelect, maxSelect: row.maxSelect,
      options: row.options, ...(followUp ? { followUp } : {}) } as SelectionCard;
    const confirmation = row.confirmationId && row.items
      ? { cardId: row.cardId, confirmationId: row.confirmationId, kind: "candidates", items: row.items } as CardConfirmation
      : null;
    return { card, confirmation };
  });
}

/** Cards the user still has to answer. */
export const openCards = (cards: readonly SessionCard[]) => cards.filter(item => !item.confirmation);

/** A `research.benchmarks` row (0282 `research_user_benchmarks`): host-computed numbers with their evidence refs. */
export interface StoredBenchmark {
  platform: string; account: string; followers: number | null; medianViews: number | null; engagementRate: number | null;
  postsPerWeek: number | null; lastPublishedAt: string | null; category: BenchmarkRow["category"]; qualified: boolean;
  fetchedAt: string;
  /** BENCHMARK-COVERAGE (0351): share of fetched posts on the confirmed niche, 0–1; absent or null when unknown. */
  topicRelevance?: number | null;
  /** Evidence refs (`<research operation id>#<item>`) each displayed number was computed from. */
  refs: Record<"followers" | "medianViews" | "engagementRate" | "postsPerWeek" | "lastPublishedAt", string[]>;
}

/** The report needs this many qualified benchmarks of the session (0268 `research_benchmark_required`, positioning). */
export const REPORT_MIN_QUALIFIED = 3;

/**
 * Stored rows → table rows. Each number keeps the refs the host stored, so the table can cite its source; a null
 * stays missing (the table shows no source for it). The latest fetch time is returned for the table's note.
 */
export function toBenchmarkRows(items: readonly StoredBenchmark[]): { rows: BenchmarkRow[]; fetchedAt: string | null } {
  const rows = items.map(item => {
    const metric = (value: number | null, key: keyof StoredBenchmark["refs"]) => ({ value, refs: item.refs[key] ?? [] });
    return {
    platform: item.platform as BenchmarkRow["platform"], account: item.account, category: item.category, qualified: item.qualified,
    topicRelevance: item.topicRelevance ?? null,
    metrics: { followers: metric(item.followers, "followers"), medianViews: metric(item.medianViews, "medianViews"),
      engagementRate: metric(item.engagementRate, "engagementRate"), postsPerWeek: metric(item.postsPerWeek, "postsPerWeek"),
      lastPublishedAt: { value: item.lastPublishedAt, refs: item.refs.lastPublishedAt ?? [] } },
    };
  });
  const times = items.map(item => Date.parse(item.fetchedAt)).filter(Number.isFinite);
  return { rows, fetchedAt: times.length > 0 ? new Date(Math.max(...times)).toISOString() : null };
}

/**
 * The mentor message the page sends right after a card is confirmed, so the coach goes on with the user's choice.
 * The host binds the confirmation itself (the tools only accept stored confirmation records); this text only says
 * what was chosen, in the user's words.
 */
export function researchConfirmedInput(confirmation: CardConfirmation): string {
  if (confirmation.kind === "keywords") return `我确认了这些关键词：${confirmation.items.join("、")}`;
  return `我选好了对标账号：${confirmation.items.map(item => `${platformLabel(item.platform)} ${item.account}`).join("、")}`;
}

/**
 * The mentor message sent with a refresh grant: it names the account in the user's words. The grant itself travels
 * as `researchRefreshId`; the host checks it and tells the model which account it covers.
 */
export function researchRefreshInput(platform: string, account: string): string {
  return `请重新读取对标账号 ${platformLabel(platform)} ${account} 的最新数据`;
}
