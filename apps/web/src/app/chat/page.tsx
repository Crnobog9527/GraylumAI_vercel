'use client';

import { useState, useRef, useEffect } from 'react';
import { AppHeader } from '@/components/layout/AppHeader';
import GlobalBanner from '@/components/layout/GlobalBanner';
import { ChatSidebar } from '@/components/chat/ChatSidebar';
import ChatHeader from '@/components/chat/ChatHeader';
import { MessageSquare, Paperclip, Send, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { trpc } from '@/trpc/client';
import { useChatStore } from '@/stores';
import { useBanner } from '@/hooks/use-banner';

export default function ChatPage() {
  const { activeConversationId, setActiveConversation, refreshConversationList } = useChatStore();
  const [inputMessage, setInputMessage] = useState('');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editingTitleValue, setEditingTitleValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { banners } = useBanner();

  const utils = trpc.useUtils();

  // Fetch conversations
  const { data: conversationsData } = trpc.chat.getConversations.useQuery();
  const conversations = conversationsData?.data || [];

  // Get current conversation
  const currentConversation = activeConversationId
    ? conversations.find((c) => c.id === activeConversationId)
    : null;

  // Mutations
  const createConversation = trpc.chat.createConversation.useMutation({
    onSuccess: (data) => {
      utils.chat.getConversations.invalidate();
      setActiveConversation(data.id);
      refreshConversationList();
    },
  });

  const sendMessage = trpc.chat.sendMessage.useMutation({
    onSuccess: () => {
      utils.chat.getMessages.invalidate({ conversationId: activeConversationId! });
      setInputMessage('');
    },
  });

  const updateTitle = trpc.chat.updateConversationTitle.useMutation({
    onSuccess: () => {
      utils.chat.getConversations.invalidate();
      setIsEditingTitle(false);
    },
  });

  const isStreaming = createConversation.isPending || sendMessage.isPending;

  const maxInputCharacters = 2500;
  const chatBillingHint = '🔔 温馨提示：为了保证回复质量，建议不要在一个聊天窗口里聊太久。\n单次对话过长会导致 AI "失忆"，忘记咱们开始聊了什么。';

  const handleNewChat = () => {
    setActiveConversation(null);
    setInputMessage('');
  };

  const handleSend = async () => {
    if (!inputMessage.trim() || isStreaming) return;

    if (!activeConversationId) {
      // Create new conversation first
      const newConv = await createConversation.mutateAsync({ title: inputMessage.slice(0, 50) });
      // Then send message
      sendMessage.mutate({ conversationId: newConv.id, content: inputMessage });
    } else {
      // Send to existing conversation
      sendMessage.mutate({ conversationId: activeConversationId, content: inputMessage });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSaveTitle = () => {
    if (!activeConversationId || !editingTitleValue.trim()) {
      setIsEditingTitle(false);
      return;
    }
    updateTitle.mutate({ conversationId: activeConversationId, title: editingTitleValue.trim() });
  };

  // Set editing title value when editing starts
  useEffect(() => {
    if (isEditingTitle && currentConversation) {
      setEditingTitleValue(currentConversation.title || '');
    }
  }, [isEditingTitle, currentConversation]);

  return (
    <div className="flex flex-col h-screen" style={{ background: 'var(--bg-primary)' }}>
      {/* 顶部导航 */}
      <AppHeader />

      {/* 全站横幅公告 */}
      <GlobalBanner banners={banners} />

      {/* 主体区域 */}
      <div className="flex flex-1 overflow-hidden">
        {/* 精简动画样式 */}
        <style>{`
          .chat-input-box:focus-within {
            border-color: rgba(255, 215, 0, 0.5) !important;
          }
          .conversation-item:hover {
            background: rgba(255, 215, 0, 0.05) !important;
          }
        `}</style>

        {/* 左侧边栏 - 对话列表 */}
        <ChatSidebar
          onSelectConversation={setActiveConversation}
          onNewChat={handleNewChat}
          activeConversationId={activeConversationId ?? undefined}
        />

        {/* 主聊天区域 */}
        <div
          className="flex-1 flex flex-col relative overflow-hidden"
          style={{ background: 'var(--bg-primary)' }}
        >
          {/* 静态背景光晕 */}
          <div className="absolute inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 0, contain: 'layout paint' }}>
            <div
              className="absolute -top-1/4 -right-1/4 w-1/2 h-1/2 rounded-full opacity-[0.08] blur-[100px]"
              style={{ background: 'var(--color-primary)' }}
            />
            <div
              className="absolute -bottom-1/4 -left-1/4 w-1/2 h-1/2 rounded-full opacity-[0.15] blur-[120px]"
              style={{ background: 'var(--color-secondary)' }}
            />
          </div>

          {/* 顶部标题栏 */}
          <ChatHeader
            currentConversation={currentConversation}
            isEditingTitle={isEditingTitle}
            setIsEditingTitle={setIsEditingTitle}
            editingTitleValue={editingTitleValue}
            setEditingTitleValue={setEditingTitleValue}
            onSaveTitle={handleSaveTitle}
          />

          {/* 消息区域 - 空状态或消息列表 */}
          <div className="flex-1 flex flex-col overflow-y-auto relative z-10">
            {/* 空状态 - 开始新对话 */}
            <div className="flex-1 flex flex-col items-center justify-center">
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
                style={{
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-primary)',
                }}
              >
                <MessageSquare className="h-8 w-8" style={{ color: 'var(--color-primary)' }} />
              </div>
              <h2 className="text-xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
                开始新对话
              </h2>
              <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                请输入您的问题，AI将为您解答
              </p>
            </div>
          </div>

          {/* 输入区域 */}
          <div
            className="p-4 relative"
            style={{ borderTop: '1px solid var(--border-primary)', background: 'var(--bg-secondary)', zIndex: 1 }}
          >
            <div className="max-w-3xl mx-auto">
              {/* 输入框 */}
              <div
                className="relative rounded-2xl chat-input-box"
                style={{
                  background: 'var(--bg-primary)',
                  border: '1px solid rgba(255, 215, 0, 0.15)',
                }}
              >
                <div className="flex items-end p-3">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/*,.pdf,.doc,.docx,.txt,.csv"
                    className="hidden"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 shrink-0 hover:opacity-80"
                    style={{ color: 'var(--text-tertiary)' }}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Paperclip className="h-5 w-5" />
                  </Button>
                  <Textarea
                    ref={textareaRef}
                    value={inputMessage}
                    onChange={(e) => setInputMessage(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="请输入您的问题..."
                    disabled={isStreaming}
                    className="flex-1 min-h-[44px] max-h-[120px] resize-none border-0 focus-visible:ring-0 py-2 px-2 text-base bg-transparent"
                    style={{ color: 'var(--text-primary)' }}
                    rows={1}
                  />
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs" style={{ color: 'var(--text-disabled)' }}>
                      {inputMessage.length}/{maxInputCharacters}
                    </span>
                    <Button
                      onClick={handleSend}
                      disabled={!inputMessage.trim() || isStreaming}
                      className="h-9 px-5 gap-2 rounded-xl font-medium"
                      style={{
                        background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                        color: 'var(--bg-primary)',
                      }}
                    >
                      {isStreaming ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <>
                          发送
                          <Send className="h-4 w-4" />
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </div>

              {/* 聊天提示文案 */}
              <div
                className="mt-3 px-4 py-3 text-sm leading-relaxed text-center whitespace-pre-line"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {chatBillingHint}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
