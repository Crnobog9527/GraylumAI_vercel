/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { create } from 'zustand';
import type { ConversationNotice } from '@/lib/conversation-erasure';

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

export const useConversationErasureStore = create<ConversationErasureStore>((set) => ({
  hidden: new Set(),
  notice: null,
  hide: (sessionId) => set((state) => ({ hidden: new Set(state.hidden).add(sessionId) })),
  show: (sessionId) => set((state) => {
    const hidden = new Set(state.hidden);
    hidden.delete(sessionId);
    return { hidden };
  }),
  setNotice: (notice) => set({ notice }),
}));
