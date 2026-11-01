/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useEffect, useRef } from 'react';
import type { TurnView } from '@repo/api/src/services/turn/view';
import { forgetPending, pendingSeen, readPending, withoutSentText, type PendingSend } from './send-input';

/*
 * CORE-PATH-V2: after a reload the server says what it holds. A send whose request id is in the saved conversation is stored, so the text the
 * page put back in the box (in case the send was lost) goes out again and the user is not tempted to send it twice. Shared by every
 * conversation page on the turn path, so none can leave it behind. `apply` gets the box text without it and the pending record.
 */
export function useStoredSendCleanup(sessionId: string, chat: { view: TurnView | null; sending: boolean }, input: string,
  apply: (next: string, pending: PendingSend) => void) {
  const inputRef = useRef(input), applyRef = useRef(apply);
  inputRef.current = input;
  applyRef.current = apply;
  useEffect(() => {
    if (!chat.view || chat.sending) return;
    const pending = readPending(localStorage, sessionId);
    if (!pending?.restored || pendingSeen(pending, chat.view) !== 'stored') return;
    applyRef.current(pending.text ? withoutSentText(inputRef.current, pending.text) : inputRef.current, pending);
    forgetPending(localStorage, sessionId);
    // The request id left in the address belongs to this send: a later send must not reuse it (the server would replay, not send).
    const done = new URL(location.href);
    done.searchParams.delete('request');
    history.replaceState(null, '', done);
  }, [chat.view, chat.sending, sessionId]);
}
