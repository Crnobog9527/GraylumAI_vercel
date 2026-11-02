/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TurnView } from '@repo/api/src/services/turn/view';
import { runTurn } from '@/lib/turn-stream';
import { trpc } from '@/trpc/client';
import { turnCodeNotice } from '@/app/(zh-hans)/app/runtime/turn-notices';
import type { ChatNotice } from '@/components/chat/ChatInlineNotice';
import { readTurnView } from '../mentor-turn-path';
import { topicFailureMessage } from './topic-notices';

/*
 * CORE-PATH-V2 V2-10b: the topic workspace on POST /api/turn/topic (kind=chat in the workspace's conversation). The page works on
 * executions, so each saved exchange is one finished execution here. Its id is the turn's request id, the handle the topic draft and the
 * adoption name on the server; the running turn has no reply yet, so `turn:<id>` is enough. Only a report can be stopped: a running
 * topic turn offers no stop.
 */
const READ_MS = 3000;
/** A turn from another tab starts without this page: an idle workspace still looks now and then. */
const IDLE_READ_MS = 30000;
const fetcher: typeof fetch = (...args) => globalThis.fetch(...args);
export const TOPIC_TURN_URL = '/api/turn/topic';
const FIELDS = { contentAvailable: true, unavailableReason: null };

export function topicExecutions(view: TurnView) {
  const executions: Array<{ executionId: string; state: string; input: string | null; body: string | null; primaryBody: string | null;
    contentAvailable: boolean; unavailableReason: null }> = [];
  for (const reply of view.messages) {
    if (reply.role !== 'assistant' || !reply.requestId) continue;
    const input = view.messages.find(m => m.role === 'user' && m.turnId === reply.turnId)?.content ?? null;
    executions.push({ executionId: reply.requestId, state: 'completed', input, body: reply.content, primaryBody: reply.content, ...FIELDS });
  }
  const running = view.activeTurn ? `turn:${view.activeTurn.turnId}` : null;
  if (running) executions.push({ executionId: running, state: 'running', input: null, body: null, primaryBody: null, ...FIELDS });
  return { executions, activeExecution: running };
}

/** What a finished send leaves the page: a notice, and whether the words go back in the box (nothing was charged). */
export function topicSendOutcome(outcome: Awaited<ReturnType<typeof runTurn>>): { notice: string | null; keepInput: boolean } {
  if (outcome.state === 'lost') return { notice: null, keepInput: false };
  if (outcome.state === 'refused') return { notice: turnCodeNotice(outcome.code).text, keepInput: true };
  if (outcome.last.type === 'result' || outcome.last.code === 'TURN_REQUEST_REPLAYED') return { notice: null, keepInput: false };
  const { code, turnId } = outcome.last, told = turnCodeNotice(code);
  // Refused before a turn opened: nothing was stored or charged, whatever the code.
  return { notice: code.startsWith('OPC_') ? topicFailureMessage(new Error(code)) : told.text, keepInput: told.kept || turnId === undefined };
}

/** Refused, no turn opened: the record stops an opening sending itself again on a later visit. */
export function refuseTopic(storage: Pick<Storage, 'setItem' | 'removeItem'>, key: string, op: { request: { requestId: string } }) {
  storage.setItem(key + ':rejected:' + op.request.requestId, JSON.stringify(op));
  storage.removeItem(key);
}

/** A dropped stream proves nothing: the request counts as sent only if the read back shows it. */
export const topicRequestSeen = (view: TurnView | null, requestId: string) =>
  Boolean(view?.activeTurn || view?.messages.some(m => m.requestId === requestId));

/** A topic turn cannot be stopped: while it runs the page only says so. */
export function turnRunningNotice(e: { executionId: string; state: string }): ChatNotice | null {
  return e.state === 'running' ? { id: e.executionId, tone: 'status', busy: true, text: '正在回复…' } : null;
}

export function useTopicTurnPath(sessionId: string) {
  const [view, setView] = useState<TurnView | null>(null), [failed, setFailed] = useState(false);
  const utils = trpc.useUtils();
  const refetch = useCallback(async () => {
    if (!sessionId) return null;
    const next = await readTurnView(sessionId, fetcher);
    setFailed(!next);
    if (next) setView(next);
    return next;
  }, [sessionId]);
  useEffect(() => { void refetch(); }, [refetch]);
  // A failed read is read again: the reply is saved whatever this page saw. Focus covers the idle gap.
  const quick = Boolean(view?.activeTurn) || failed;
  useEffect(() => {
    if (!sessionId) return;
    const timer = setInterval(() => void refetch(), quick ? READ_MS : IDLE_READ_MS);
    return () => clearInterval(timer);
  }, [sessionId, quick, refetch]);
  useEffect(() => {
    const onFocus = () => void refetch();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refetch]);
  const data = useMemo(() => view ? topicExecutions(view) : { executions: [], activeExecution: null }, [view]);
  const send = async (request: { draftId: string; requestId: string; input: string }, candidate?: unknown) => {
    if (candidate) localStorage.setItem(`opc-topic-adoption-context:${sessionId}:${request.requestId}`, JSON.stringify(candidate));
    const outcome = await runTurn(request, () => undefined, { fetch: fetcher, url: TOPIC_TURN_URL });
    const next = await refetch();
    void utils.credits.getBalance.invalidate(); // the turn is settled: the sidebar balance moved (opening, chat, adoption turns alike)
    const told = topicSendOutcome(outcome), seen = topicRequestSeen(next, request.requestId);
    // A turn that failed saved nothing: its words go back in the box, or they would be nowhere.
    const failed = outcome.state === 'finished' && outcome.last.type === 'error' && outcome.last.code !== 'TURN_REQUEST_REPLAYED' && !seen;
    return { ...told, keepInput: told.keepInput || failed, unknown: outcome.state === 'lost' && !seen };
  };
  // Nothing is sent before the first read: it shows whether a turn is already running.
  return { decided: Boolean(view), data, refetch, send };
}
