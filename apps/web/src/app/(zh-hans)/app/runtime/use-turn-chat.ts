/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToolAvailability } from '@repo/api/src/services/turn/tools/types';
import type { TurnView } from '@repo/api/src/services/turn/view';
import { runTurn } from '@/lib/turn-stream';
import { readTurnView } from '@/app/(zh-hans)/app/positioning/[draftId]/mentor-turn-path';
import { turnCodeNotice, trimmedToolNotices } from './turn-notices';

/*
 * CORE-PATH-V2 V2-10: one conversation on POST /api/turn. The saved messages (GET /api/turn) are what the page shows; streamed text
 * is display only until they arrive. A turn runs to its close whatever the page does, so a dropped stream or a reload reads
 * back, every READ_MS, for as long as the server says a turn is active, and never sends again.
 */
const READ_MS = 3000;
export type LiveTurn = { text: string; trimmed: string[] };
export type SendAnswer = 'done' | 'kept' | 'unknown';

export function useTurnChat(sessionId: string, onSettled: () => void, fetcher: typeof fetch = (...args) => globalThis.fetch(...args)) {
  const [view, setView] = useState<TurnView | null>(null), [viewFailed, setViewFailed] = useState(false);
  const [live, setLive] = useState<LiveTurn | null>(null), [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ code: string; text: string } | null>(null);
  const alive = useRef(true), settled = useRef(onSettled);
  useEffect(() => { settled.current = onSettled; }, [onSettled]);
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
  const active = Boolean(view?.activeTurn) && !sending;
  useEffect(() => {
    if (!active) return;
    let wasActive = true;
    const timer = setInterval(() => { void read().then(next => {
      if (next && !next.activeTurn && wasActive) { wasActive = false; settled.current(); }
    }); }, READ_MS);
    return () => clearInterval(timer);
  }, [active, read]);

  const send = useCallback(async (text: string, requestId: string): Promise<SendAnswer> => {
    setSending(true); setNotice(null); setLive({ text: '', trimmed: [] });
    let tools: ToolAvailability | undefined;
    const outcome = await runTurn({ kind: 'chat', sessionId, requestId, text }, event => {
      if (!alive.current) return;
      if (event.type === 'opened') { tools = event.tools; setLive(old => ({ text: old?.text ?? '', trimmed: trimmedToolNotices(tools) })); }
      if (event.type === 'text') setLive(old => ({ text: (old?.text ?? '') + event.delta, trimmed: old?.trimmed ?? [] }));
    }, { fetch: fetcher });
    await read();
    if (!alive.current) return 'unknown';
    setSending(false); setLive(null); settled.current();
    if (outcome.state === 'lost') return 'unknown';
    const code = outcome.state === 'refused' ? outcome.code : outcome.last.type === 'error' ? outcome.last.code : null;
    if (!code || code === 'TURN_REQUEST_REPLAYED') return 'done';
    const { text: said, kept } = turnCodeNotice(code);
    setNotice({ code, text: said });
    return kept ? 'kept' : 'unknown';
  }, [sessionId, fetcher, read]);

  return { view, viewFailed, live, sending, notice, send, reload: read,
    busy: sending || Boolean(view?.activeTurn), clearNotice: () => setNotice(null) };
}
