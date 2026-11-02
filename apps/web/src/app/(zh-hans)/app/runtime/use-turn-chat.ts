/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToolAvailability } from '@repo/api/src/services/turn/tools/types';
import type { TurnView } from '@repo/api/src/services/turn/view';
import { runTurn } from '@/lib/turn-stream';
import type { ResearchCall } from '@/components/research/research-model';
import { workItemFromResearchCall, type WorkItem } from '@/components/chat-display/agent-work-model';
import { readTurnView } from '@/app/(zh-hans)/app/positioning/[draftId]/mentor-turn-path';
import { turnBusyForCredits } from '@/components/opc/credits-label';
import { announceTurnClosed, onTurnClosed } from './turn-closed-channel';
import { turnCodeNotice, trimmedToolNotices } from './turn-notices';

/*
 * CORE-PATH-V2 V2-10: one conversation on POST /api/turn. The saved messages (GET /api/turn) are what the page shows; streamed text
 * is display only until they arrive. A turn runs to its close whatever the page does, so a dropped stream or a reload reads
 * back, every READ_MS, for as long as the server says a turn is active, and never sends again.
 */
const READ_MS = 3000;
/** Another conversation's turn may still hold its freeze when this one closes: the balance is read once more after this, and on return to the window. */
const REREAD_MS = 8000;
export type LiveTurn = { text: string; trimmed: string[]; rows: WorkItem[] };

/** A research call's row, replacing the row of the same call (running, then its end state). */
export function withResearchRow(rows: readonly WorkItem[], call: ResearchCall): WorkItem[] {
  const row = workItemFromResearchCall(call);
  return rows.some(old => old.id === row.id) ? rows.map(old => old.id === row.id ? row : old) : [...rows, row];
}
/** Whether a view shows a turn closed that the page has not yet acted on (`seen`: the last one it did; undefined before the first read). */
export const closedTurnSeen = (seen: number | null | undefined, view: Pick<TurnView, 'lastTurn'> | null):
  { changed: boolean; id: number | null | undefined } => {
  const id = view ? view.lastTurn?.turnId ?? null : undefined;
  return { changed: id !== undefined && id !== seen, id };
};
export type TurnChoice = { moduleId?: string; references?: ReadonlyArray<{ kind: 'library_document'; documentId: string; version: number }>;
  /** A work item's conversation (V2-10b): the server reads its checks, method and brief. */ workItem?: boolean };
/**
 * A refusal before the stream, or an error event without a turn whose code is a definite refusal: no turn was opened, so nothing was
 * stored or charged. The codes of a failed database call are not: turn_open may have committed and its answer been lost (the turn and its
 * freeze exist, and the error carries no turn), so those stay unknown until the view says otherwise.
 */
const OPEN_UNKNOWN = new Set(['TURN_DATABASE_UNAVAILABLE', 'TURN_OPEN_FAILED', 'TURN_FAILED']);
export function neverOpened(outcome: { state: 'refused' } | { state: 'finished'; last: { type: string; turnId?: number; code?: string } }): boolean {
  if (outcome.state === 'refused') return true;
  const { last } = outcome;
  return last.type === 'error' && last.turnId === undefined && !OPEN_UNKNOWN.has(last.code ?? '');
}
export type SendAnswer = 'done' | 'kept' | 'unknown';

/** One function for the page's life: `read` depends on it, and a new one per render would read without end. */
const browserFetch: typeof fetch = (...args) => globalThis.fetch(...args);

export function useTurnChat(sessionId: string, onSettled: () => void, fetcher: typeof fetch = browserFetch) {
  const [view, setView] = useState<TurnView | null>(null), [viewFailed, setViewFailed] = useState(false);
  const [live, setLive] = useState<LiveTurn | null>(null), [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ code: string; text: string } | null>(null);
  const alive = useRef(true), settled = useRef(onSettled);
  useEffect(() => { settled.current = onSettled; }, [onSettled]);
  // Not a poll: one more read a while after a close, one when another tab says its turn closed, and one whenever the user comes back to the window.
  const reread = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settle = useCallback(() => {
    settled.current();
    announceTurnClosed();
    if (reread.current) clearTimeout(reread.current);
    reread.current = setTimeout(() => settled.current(), REREAD_MS);
  }, []);
  useEffect(() => {
    const back = () => { if (document.visibilityState !== 'hidden') settled.current(); };
    const stop = onTurnClosed(() => settled.current());
    window.addEventListener('focus', back); document.addEventListener('visibilitychange', back);
    return () => { stop(); window.removeEventListener('focus', back); document.removeEventListener('visibilitychange', back);
      if (reread.current) clearTimeout(reread.current); };
  }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const read = useCallback(async () => {
    const next = await readTurnView(sessionId, fetcher);
    if (!alive.current) return null;
    setViewFailed(!next);
    if (next) setView(next);
    return next;
  }, [sessionId, fetcher]);
  useEffect(() => { void read(); }, [read]);

  // Until the active turn closes, on this page or another: a reload, a dropped stream, a second tab.
  // A read that failed (the first one, or the one after a send) is read again until it answers: the turn goes on without this page.
  const unread = viewFailed || !view;
  useEffect(() => {
    if (!unread) return;
    const timer = setInterval(() => void read(), READ_MS);
    return () => clearInterval(timer);
  }, [unread, read]);
  // However a turn's close is learned (the stream, a poll, the first read after a reload), the balance is read again: a page opened
  // while the turn ran asked for it while the turn's freeze was held, and nothing else would ask again.
  const lastClosed = useRef<number | null | undefined>(undefined);
  const closedNow = closedTurnSeen(lastClosed.current, view);
  useEffect(() => {
    const now = closedTurnSeen(lastClosed.current, view);
    if (!now.changed) return;
    lastClosed.current = now.id;
    settle();
  }, [view, closedNow.id, settle]);
  // A pause waits for the user; nothing moves it, so it is not read again.
  const active = Boolean(view?.activeTurn) && view?.activeTurn?.pauseReason !== 'waiting_credits' && !sending;
  useEffect(() => {
    if (!active) return;
    let wasActive = true;
    const timer = setInterval(() => { void read().then(next => {
      if (next && !next.activeTurn && wasActive) { wasActive = false; settle(); }
    }); }, READ_MS);
    return () => clearInterval(timer);
  }, [active, read, settle]);

  const run = useCallback(async (body: Record<string, unknown>): Promise<SendAnswer> => {
    setSending(true); setNotice(null); setLive({ text: '', trimmed: [], rows: [] });
    let tools: ToolAvailability | undefined, made: WorkItem[] = [];
    const outcome = await runTurn({ sessionId, ...body }, event => {
      if (!alive.current) return;
      if (event.type === 'opened') { tools = event.tools;
        setLive(old => ({ text: old?.text ?? '', trimmed: trimmedToolNotices(tools), rows: old?.rows ?? [] })); }
      if (event.type === 'research_call') {
        made = withResearchRow(made, event);
        setLive(old => ({ text: old?.text ?? '', trimmed: old?.trimmed ?? [], rows: made }));
      }
      if (event.type === 'text') setLive(old => ({ text: (old?.text ?? '') + event.delta, trimmed: old?.trimmed ?? [], rows: old?.rows ?? [] }));
    }, { fetch: fetcher });
    await read();
    if (!alive.current) return 'unknown';
    setSending(false); setLive(null); settle();
    if (outcome.state === 'lost') return 'unknown';
    const code = outcome.state === 'refused' ? outcome.code : outcome.last.type === 'error' ? outcome.last.code : null;
    if (!code || code === 'TURN_REQUEST_REPLAYED') return 'done';
    const { text: said, kept } = turnCodeNotice(code);
    setNotice({ code, text: said });
    // An error event carries its turn only once one is open: without it (or refused before the stream) nothing was stored or charged,
    // whatever the code says, so the words and any claim made for them are given back instead of waiting to be verified.
    return kept || neverOpened(outcome) ? 'kept' : 'unknown';
  }, [sessionId, fetcher, read, settle]);
  const send = useCallback((text: string, requestId: string, chosen: TurnChoice = {}) =>
    run({ kind: 'chat', requestId, text, ...chosen }), [run]);
  /** 继续 after a pause for credits: the server has what was asked, so any device can press it. */
  const resume = useCallback(() => view?.activeTurn ? run({ kind: 'resume', requestId: crypto.randomUUID(), resumeOf: view.activeTurn.turnId })
    : Promise.resolve<SendAnswer>('done'), [run, view?.activeTurn]);

  const busy = sending || Boolean(view?.activeTurn), paused = view?.activeTurn?.pauseReason === 'waiting_credits';
  // What the sidebar balance is told: the conversation's own state, so every page on this hook keeps the turn's freeze out of the balance.
  const creditsBusy = turnBusyForCredits({ viewRead: view !== null, viewFailed, busy, paused });
  return { view, viewFailed, live, sending, notice, send, resume, paused, reload: read,
    busy, creditsBusy, clearNotice: () => setNotice(null) };
}
