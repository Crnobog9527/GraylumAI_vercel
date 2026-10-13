'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useCallback } from 'react';
import { trpc } from '@/trpc/client';
import { useAfterContentErasure } from '@/hooks/use-content-erasure';
import { REVIEW_NOTICE, laterNotice, runConversationErasure } from '@/lib/conversation-erasure';
import { useConversationErasureStore } from '@/stores/conversation-erasure';

type Row = { sessionId: string; title: string; lastActivityAt: string };
/** Rows taken out of the cached list, so a failure can put them back where they were. */
const removed = new Map<string, { row: Row; index: number }>();

/**
 * Instant whole-conversation deletion (Owner 2026-10-13). The pending rows and the result notice
 * live in a page-independent store, and the call uses the plain client, so leaving the deleted
 * conversation's page neither brings the row back nor loses a late failure.
 */
export function useConversationErasure(leave: (sessionId: string) => void) {
  const utils = trpc.useUtils();
  const afterErasure = useAfterContentErasure();
  const hidden = useConversationErasureStore((state) => state.hidden);
  const notice = useConversationErasureStore((state) => state.notice);

  const erase = useCallback((sessionId: string) => {
    const store = useConversationErasureStore.getState();
    void utils.opc.conversations.cancel();
    return runConversationErasure({
      hide: (id) => {
        store.hide(id);
        const rows = utils.opc.conversations.getData();
        const index = rows?.findIndex((row) => row.sessionId === id) ?? -1;
        if (rows && index >= 0) removed.set(id, { row: rows[index], index });
        utils.opc.conversations.setData(undefined, (current) => current?.filter((row) => row.sessionId !== id));
      },
      restore: (id) => {
        const saved = removed.get(id);
        removed.delete(id);
        if (saved) {
          utils.opc.conversations.setData(undefined, (current) => !current || current.some((row) => row.sessionId === id)
            ? current : [...current.slice(0, saved.index), saved.row, ...current.slice(saved.index)]);
        }
        store.show(id);
      },
      leave,
      erase: (id) => utils.client.account.conversationErasure.mutate({ sessionId: id }),
      afterErased: (id) => {
        removed.delete(id);
        void afterErasure({ kind: 'session', id });
        // Physical cleanup in the background; the account-erasure cron sweeps anything left. It also
        // reports money still being checked on the deleted conversation.
        void utils.client.account.conversationErasureCleanup.mutate({ sessionId: id }).then((result) => {
          // Another deletion may have failed meanwhile; its error stays on screen.
          if (result.reviewRequired) store.setNotice(laterNotice(useConversationErasureStore.getState().notice, REVIEW_NOTICE));
        }, () => undefined);
      },
      resync: () => { void utils.opc.conversations.invalidate(); },
      notify: store.setNotice,
    }, sessionId);
  }, [utils, afterErasure, leave]);

  return { hidden, notice, erase };
}
