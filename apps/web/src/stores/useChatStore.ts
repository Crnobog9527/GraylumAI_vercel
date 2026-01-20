import { create } from 'zustand';

interface ChatState {
  // Current active conversation ID
  activeConversationId: string | null;
  // Trigger to refresh conversation list
  conversationListVersion: number;
  // Sidebar collapsed state
  isSidebarCollapsed: boolean;

  // Actions
  setActiveConversation: (id: string | null) => void;
  refreshConversationList: () => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  // Initial state
  activeConversationId: null,
  conversationListVersion: 0,
  isSidebarCollapsed: false,

  // Actions
  setActiveConversation: (id) => set({ activeConversationId: id }),

  refreshConversationList: () =>
    set((state) => ({ conversationListVersion: state.conversationListVersion + 1 })),

  toggleSidebar: () =>
    set((state) => ({ isSidebarCollapsed: !state.isSidebarCollapsed })),

  setSidebarCollapsed: (collapsed) => set({ isSidebarCollapsed: collapsed }),
}));
