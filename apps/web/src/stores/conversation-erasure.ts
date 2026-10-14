/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { create } from 'zustand';
import type { ConversationNotice } from '@/lib/conversation-erasure';
import { readPending } from '@/lib/pending-conversation-erasure';

/**
 * Conversations being deleted, kept outside any page: deleting the open conversation navigates to a
 * new page (and a new sidebar), which must keep hiding the row and still show a late failure.
 */
type ConversationErasureStore = {
  hidden: ReadonlySet<string>;
  notice: ConversationNotice | null;
  hide: (sessionId: string) => void;
  show: (sessionId: string) => void;
  setNotice: (notice: ConversationNotice | null) => void;
};

/**
 * Deletions still in flight when this tab (re)loaded, read once with the module: they are hidden from
 * the very first render, and only these are re-sent after a reload.
 */
export const PENDING_AT_LOAD: readonly string[] = (() => {
  try { return typeof window === 'undefined' ? [] : readPending(window.sessionStorage); } catch { return []; }
})();

export const useConversationErasureStore = create<ConversationErasureStore>((set) => ({
  hidden: new Set(PENDING_AT_LOAD),
  notice: null,
  hide: (sessionId) => set((state) => ({ hidden: new Set(state.hidden).add(sessionId) })),
  show: (sessionId) => set((state) => {
    const hidden = new Set(state.hidden);
    hidden.delete(sessionId);
    return { hidden };
  }),
  setNotice: (notice) => set({ notice }),
}));
