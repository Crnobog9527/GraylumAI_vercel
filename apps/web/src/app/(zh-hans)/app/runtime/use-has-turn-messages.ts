/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useEffect, useState } from 'react';
import { readTurnView } from '@/app/(zh-hans)/app/positioning/[draftId]/mentor-turn-path';

/** Whether this conversation already holds replies of the turn path, whatever the switch says now (a rollback keeps them readable). */
export function useHasTurnMessages(sessionId: string): { loaded: boolean; has: boolean } {
  const [state, setState] = useState({ loaded: !sessionId, has: false });
  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    void readTurnView(sessionId, (...args) => globalThis.fetch(...args)).then(view => {
      if (live) setState({ loaded: true, has: Boolean(view?.messages.length) });
    });
    return () => { live = false; };
  }, [sessionId]);
  return state;
}
