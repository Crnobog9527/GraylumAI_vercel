'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useCallback, useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { useAfterContentErasure } from '@/hooks/use-content-erasure';
import { runConversationErasure, type ConversationNotice } from '@/lib/conversation-erasure';

type Row = { sessionId: string; title: string; lastActivityAt: string };

/**
 * Instant whole-conversation deletion (Owner 2026-10-13). Rows being deleted stay hidden even if a
 * list refetch that started earlier comes back with them; a failure shows them again.
 */
export function useConversationErasure(leave: (sessionId: string) => void) {
  const utils = trpc.useUtils();
  const afterErasure = useAfterContentErasure();
  const mutation = trpc.account.conversationErasure.useMutation();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<ConversationNotice | null>(null);
  const removed = useRef(new Map<string, { row: Row; index: number }>());

  const erase = useCallback((sessionId: string) => {
    void utils.opc.conversations.cancel();
    return runConversationErasure({
      hide: (id) => {
        setHidden((current) => new Set(current).add(id));
        const rows = utils.opc.conversations.getData();
        const index = rows?.findIndex((row) => row.sessionId === id) ?? -1;
        if (rows && index >= 0) removed.current.set(id, { row: rows[index], index });
        utils.opc.conversations.setData(undefined, (current) => current?.filter((row) => row.sessionId !== id));
      },
      restore: (id) => {
        const saved = removed.current.get(id);
        removed.current.delete(id);
        if (saved) {
          utils.opc.conversations.setData(undefined, (current) => !current || current.some((row) => row.sessionId === id)
            ? current : [...current.slice(0, saved.index), saved.row, ...current.slice(saved.index)]);
        }
        setHidden((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      },
      leave,
      erase: (id) => mutation.mutateAsync({ sessionId: id }),
      afterErased: (id) => {
        removed.current.delete(id);
        void afterErasure({ kind: 'session', id });
      },
      resync: () => { void utils.opc.conversations.invalidate(); },
      notify: setNotice,
    }, sessionId);
  }, [utils, afterErasure, mutation, leave]);

  return { hidden, notice, erase, dismissNotice: () => setNotice(null) };
}
