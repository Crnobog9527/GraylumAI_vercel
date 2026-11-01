/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useEffect, useState } from 'react';
import type { TurnView } from '@repo/api/src/services/turn/view';
import { readTurnView } from '@/app/(zh-hans)/app/positioning/[draftId]/mentor-turn-path';

const RETRY_MS = 3000;

/**
 * Whether the conversation holds replies of the turn path. A read that failed says nothing: it is read again until one answers, and
 * only an answer with no messages is "none" (a rollback must not hide replies the user paid for).
 */
export async function probeTurnMessages(read: () => Promise<TurnView | null>, wait: (ms: number) => Promise<void>,
  live: () => boolean): Promise<boolean | null> {
  while (live()) {
    const view = await read();
    if (view) return view.messages.length > 0;
    await wait(RETRY_MS);
  }
  return null;
}

export function useHasTurnMessages(sessionId: string): { loaded: boolean; has: boolean } {
  const [state, setState] = useState({ loaded: !sessionId, has: false });
  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    void probeTurnMessages(() => readTurnView(sessionId, (...args) => globalThis.fetch(...args)),
      ms => new Promise(resolve => setTimeout(resolve, ms)), () => live)
      .then(has => { if (live && has !== null) setState({ loaded: true, has }); });
    return () => { live = false; };
  }, [sessionId]);
  return state;
}
