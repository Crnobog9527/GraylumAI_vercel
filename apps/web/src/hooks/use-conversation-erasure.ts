'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useCallback, useLayoutEffect, useMemo } from 'react';
import { trpc } from '@/trpc/client';
import { REVIEW_NOTICE, laterNotice, runConversationErasure } from '@/lib/conversation-erasure';
import {
  forgetPending, pendingRelated, rememberPending, resumeConversationErasure,
} from '@/lib/pending-conversation-erasure';
import { announceErasure, forgetLocalCopies, forgetWorkReturn, refreshAfterErasure } from '@/lib/content-erasure';
import { PENDING_AT_LOAD, useConversationErasureStore } from '@/stores/conversation-erasure';

type Row = { sessionId: string; title: string; lastActivityAt: string };
/** Rows taken out of the cached list, so a failure can put them back where they were. */
const removed = new Map<string, { row: Row; index: number }>();
/** Other IDs whose local copies go with a conversation being deleted (e.g. a positioning draft). */
const relatedBySession = new Map<string, string[]>();
/** Deletions from before this page load that have been re-sent (each once per load). */
const resumed = new Set<string>();

function tabStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
}
function localStore(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

/**
 * Instant whole-conversation deletion (Owner 2026-10-13). The pending rows and the result notice
 * live in a page-independent store, and the call uses the plain client, so leaving the deleted
 * conversation's page neither brings the row back nor loses a late failure. A deletion still in
 * flight is also remembered in this tab, so a reload keeps the row hidden and sends it again.
 */
export function useConversationErasure(leave: (sessionId: string) => void) {
  const utils = trpc.useUtils();
  const hidden = useConversationErasureStore((state) => state.hidden);
  const notice = useConversationErasureStore((state) => state.notice);

  const steps = useMemo(() => {
    const store = useConversationErasureStore.getState();
    return {
      hide: (id: string) => {
        store.hide(id);
        rememberPending(tabStorage(), id, Date.now(), relatedBySession.get(id) ?? []);
        // Before the page leaves: the page it lands on must not link back to the deleted conversation.
        forgetWorkReturn([id, ...(relatedBySession.get(id) ?? [])], tabStorage());
        const rows = utils.opc.conversations.getData();
        const index = rows?.findIndex((row) => row.sessionId === id) ?? -1;
        if (rows && index >= 0) removed.set(id, { row: rows[index], index });
        utils.opc.conversations.setData(undefined, (current) => current?.filter((row) => row.sessionId !== id));
      },
      restore: (id: string) => {
        relatedBySession.delete(id);
        forgetPending(tabStorage(), id);
        const saved = removed.get(id);
        removed.delete(id);
        if (saved) {
          utils.opc.conversations.setData(undefined, (current) => !current || current.some((row) => row.sessionId === id)
            ? current : [...current.slice(0, saved.index), saved.row, ...current.slice(saved.index)]);
        }
        store.show(id);
      },
      erase: (id: string) => utils.client.account.conversationErasure.mutate({ sessionId: id }),
      afterErased: (id: string) => {
        // Unsaved edits kept under a related ID (opc-edit:<draftId>) go with the deleted conversation.
        const related = relatedBySession.get(id) ?? pendingRelated(tabStorage(), id);
        relatedBySession.delete(id);
        forgetPending(tabStorage(), id);
        removed.delete(id);
        // This tab's local copies, then every other open tab (with the related IDs, so a tab showing
        // the same positioning draft drops its unsaved edits too), then a background refresh.
        forgetLocalCopies([id, ...related], [tabStorage(), localStore()]);
        announceErasure({ kind: 'session', id }, related);
        void refreshAfterErasure(utils);
        // Physical cleanup in the background; the account-erasure cron sweeps anything left. It also
        // reports money still being checked on the deleted conversation.
        void utils.client.account.conversationErasureCleanup.mutate({ sessionId: id }).then((result) => {
          // Another deletion may have failed meanwhile; its error stays on screen.
          if (result.reviewRequired) store.setNotice(laterNotice(useConversationErasureStore.getState().notice, REVIEW_NOTICE));
        }, () => undefined);
      },
      resync: () => { void utils.opc.conversations.invalidate(); },
      notify: store.setNotice,
    };
  }, [utils]);

  // A reload while a deletion was in flight: keep those rows hidden and send the deletion again.
  // Layout phase, so the hidden IDs are in place before the first paint of a list that is already
  // in the cache: the deleted row never flashes.
  useLayoutEffect(() => {
    const store = useConversationErasureStore.getState();
    for (const id of PENDING_AT_LOAD) {
      // Already hidden since the store was created; re-send once per page load.
      if (resumed.has(id)) continue;
      resumed.add(id);
      store.hide(id);
      void resumeConversationErasure({
        ...steps, leave, wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        // Several deletions may resume together: a status notice never hides another one's error.
        notify: (next) => store.setNotice(next?.tone === 'notice'
          ? laterNotice(useConversationErasureStore.getState().notice, next) : next),
      }, id);
    }
  }, [steps, leave]);

  const erase = useCallback((sessionId: string, related: string[] = []) => {
    if (related.length) relatedBySession.set(sessionId, related);
    void utils.opc.conversations.cancel();
    const store = useConversationErasureStore.getState();
    return runConversationErasure({
      ...steps, leave,
      // Unknown outcome: keep trying from this page; if the page is going away, the next load resumes.
      resume: (id) => {
        if (resumed.has(id)) return;
        resumed.add(id);
        void resumeConversationErasure({
          ...steps, leave: () => undefined, wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          notify: (next) => store.setNotice(next?.tone === 'notice'
            ? laterNotice(useConversationErasureStore.getState().notice, next) : next),
        }, id).finally(() => resumed.delete(id));
      },
    }, sessionId);
  }, [utils, steps, leave]);

  return { hidden, notice, erase };
}
