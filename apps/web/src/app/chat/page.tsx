'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { AppHeader } from '@/components/layout/AppHeader';
import GlobalBanner from '@/components/layout/GlobalBanner';
import { ChatSidebar } from '@/components/chat/ChatSidebar';
import ChatHeader from '@/components/chat/ChatHeader';
import ModelSelector from '@/components/chat/ModelSelector';
import ExportDialog from '@/components/chat/ExportDialog';
import { MessageSquare, Paperclip, Send, Loader2, User, Bot, AlertCircle, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { trpc } from '@/trpc/client';
import { useChatStore } from '@/stores';
import { useBanner } from '@/hooks/use-banner';
import { useStreamingChat, type StreamMessage } from '@/hooks/useStreamingChat';
import { useCreditsBalance, CREDIT_THRESHOLDS, getWarningLevel } from '@/hooks/use-credits';
import { LowBalanceDialog } from '@/components/credits/LowBalanceDialog';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  isStreaming?: boolean;
}

export default function ChatPage() {
  const { activeConversationId, setActiveConversation, refreshConversationList } = useChatStore();
  const [inputMessage, setInputMessage] = useState('');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editingTitleValue, setEditingTitleValue] = useState('');
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [lowBalanceDialogOpen, setLowBalanceDialogOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { banners } = useBanner();

  const utils = trpc.useUtils();

  // Credits balance for pre-send check
  const {
    credits,
    warningLevel,
    refetch: refetchCreditsBalance,
  } = useCreditsBalance();

  // Fetch system settings for chat page configuration
  const { data: systemSettings } = trpc.settings.getSystemSettings.useQuery();
  const showModelSelector = systemSettings?.chat_show_model_selector === true || systemSettings?.chat_show_model_selector === 'true';
  const maxInputCharacters = Number(systemSettings?.max_input_characters ?? 2500) || 2500;
  const chatBillingHint = typeof systemSettings?.chat_billing_hint === 'string' && systemSettings.chat_billing_hint
    ? systemSettings.chat_billing_hint
      .replace('{input}', String(systemSettings?.input_credits_per_1k ?? 1))
      .replace('{output}', String(systemSettings?.output_credits_per_1k ?? 5))
    : '🔔 温馨提示：为了保证回复质量，建议不要在一个聊天窗口里聊太久。\n单次对话过长会导致 AI "失忆"，忘记咱们开始聊了什么。';

  // Fetch export permissions (based on membership level)
  const { data: exportPermissions } = trpc.chat.getExportPermissions.useQuery();
  const canExport = exportPermissions?.allowExport ?? false;
  const canBatchExport = exportPermissions?.allowBatchExport ?? false;

  // Fetch active AI models for model selector
  const { data: modelsData } = trpc.model.getActiveModels.useQuery();
  const activeModels = (modelsData ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    description: m.description ?? undefined,
    credits_per_message: 0, // 按实际 token 计费，不显示固定积分
    is_active: true,
  }));

  // Set default model when models are loaded
  useEffect(() => {
    if (activeModels.length > 0 && !selectedModelId) {
      setSelectedModelId(activeModels[0].id);
    }
  }, [activeModels, selectedModelId]);

  // Fetch conversations
  const { data: conversationsData, isLoading: conversationsLoading } = trpc.chat.getConversations.useQuery();
  const conversations = conversationsData?.data || [];

  // Get current conversation
  const currentConversation = activeConversationId
    ? conversations.find((c) => c.id === activeConversationId)
    : null;

  // Streaming chat hook - 使用流式 AI 对话
  const {
    messages: streamingMessages,
    isLoading: streamingLoading,
    isStreaming,
    error: streamingError,
    sendMessage: sendStreamingMessage,
    abort: abortStreaming,
    loadHistory,
    clearChat,
  } = useStreamingChat({
    conversationId: activeConversationId ?? undefined,
    onMessageComplete: () => {
      // 消息完成后刷新对话列表（可能创建了新对话）
      utils.chat.getConversations.invalidate();
      refreshConversationList();
    },
    onConversationCreated: (newConversationId) => {
      // 新对话创建后同步到 store，使侧边栏正确高亮
      setActiveConversation(newConversationId);
    },
    onError: (error) => {
      console.error('Streaming error:', error);
    },
    onBalanceChange: () => {
      // 积分变化时刷新积分显示
      utils.credits.getBalance.invalidate();
    },
  });

  useEffect(() => {
    if (
      !activeConversationId ||
      !conversationsData ||
      conversationsLoading ||
      isStreaming ||
      streamingLoading ||
      streamingMessages.length > 0
    ) {
      return;
    }

    const activeConversationExists = conversations.some((conversation) => conversation.id === activeConversationId);
    if (!activeConversationExists) {
      setActiveConversation(null);
      clearChat();
    }
  }, [
    activeConversationId,
    clearChat,
    conversations,
    conversationsData,
    conversationsLoading,
    isStreaming,
    setActiveConversation,
    streamingLoading,
    streamingMessages.length,
  ]);

  // Fetch messages for active conversation (用于切换对话时加载历史)
  const { data: messagesData, isLoading: messagesLoading } = trpc.chat.getMessages.useQuery(
    { conversationId: activeConversationId! },
    { enabled: !!activeConversationId && streamingMessages.length === 0 }
  );

  // 合并历史消息和流式消息
  const historyMessages: Message[] = messagesData?.data || [];
  const messages: Message[] = streamingMessages.length > 0
    ? streamingMessages.map((m: StreamMessage) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        created_at: m.createdAt,
        isStreaming: m.isStreaming,
      }))
    : historyMessages;

  // 当切换对话时，加载历史记录
  useEffect(() => {
    if (activeConversationId && streamingMessages.length === 0) {
      loadHistory(activeConversationId);
    }
  }, [activeConversationId, loadHistory, streamingMessages.length]);

  // Auto-scroll to bottom when messages change
  const messagesEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Mutations for conversation management
  const updateTitle = trpc.chat.updateConversationTitle.useMutation({
    onSuccess: () => {
      utils.chat.getConversations.invalidate();
      setIsEditingTitle(false);
    },
  });

  const isProcessing = streamingLoading || isStreaming;

  const handleNewChat = useCallback(() => {
    setActiveConversation(null);
    setInputMessage('');
    clearChat();
  }, [setActiveConversation, clearChat]);

  const handleSend = useCallback(async () => {
    if (!inputMessage.trim() || isProcessing) return;

    // 发送前主动刷新一次余额，避免使用过期缓存继续向后端发起流式请求。
    const latestBalance = await refetchCreditsBalance();
    const latestCredits = latestBalance.data?.credits ?? credits;
    const latestWarningLevel = getWarningLevel(latestCredits);
    const latestCanSendMessage = latestCredits > CREDIT_THRESHOLDS.EMPTY;

    // 发送前检查积分余额
    if (!latestCanSendMessage) {
      // 积分为 0，阻止发送并显示充值弹窗
      setLowBalanceDialogOpen(true);
      return;
    }

    // 积分不足但仍可发送，显示警告（critical 级别）
    if (latestWarningLevel === 'critical') {
      setLowBalanceDialogOpen(true);
      // 继续发送，用户可以在弹窗中选择"稍后再说"
    }

    const messageToSend = inputMessage;
    setInputMessage(''); // 立即清空输入框

    // 使用流式 API 发送消息
    // conversationId 为 null 时会自动创建新对话
    // 传递选中的模型 ID（如果启用了模型选择器）
    await sendStreamingMessage(messageToSend, {
      modelId: showModelSelector && selectedModelId ? selectedModelId : undefined,
    });
  }, [inputMessage, isProcessing, refetchCreditsBalance, credits, sendStreamingMessage, showModelSelector, selectedModelId]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleAbort = useCallback(() => {
    abortStreaming();
  }, [abortStreaming]);

  const handleSaveTitle = () => {
    if (!activeConversationId || !editingTitleValue.trim()) {
      setIsEditingTitle(false);
      return;
    }
    updateTitle.mutate({ conversationId: activeConversationId, title: editingTitleValue.trim() });
  };

  // Export handler - opens export dialog
  const handleExport = useCallback(() => {
    if (canExport && activeConversationId) {
      setExportDialogOpen(true);
    }
  }, [canExport, activeConversationId]);

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
            canExport={canExport}
            onExport={handleExport}
          />

          {/* 错误提示 */}
          {streamingError && (
            <div
              className="mx-4 mt-2 px-4 py-3 rounded-lg flex items-center gap-2"
              style={{
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                color: '#ef4444',
              }}
            >
              <AlertCircle className="h-5 w-5 shrink-0" />
              <span className="text-sm">{streamingError}</span>
            </div>
          )}

          {/* 消息区域 - 空状态或消息列表 */}
          <div className="flex-1 flex flex-col overflow-y-auto relative z-10">
            {!activeConversationId && messages.length === 0 ? (
              /* 空状态 - 开始新对话 */
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
            ) : (
              /* 消息列表 */
              <div className="flex-1 p-4 space-y-4 max-w-4xl mx-auto w-full">
                {messagesLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--color-primary)' }} />
                  </div>
                ) : (
                  messages.map((message) => (
                    <div
                      key={message.id}
                      data-testid="chat-message"
                      data-message-role={message.role}
                      className={`flex gap-3 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                      {message.role === 'assistant' && (
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                          style={{
                            background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                          }}
                        >
                          <Bot className="h-4 w-4" style={{ color: 'var(--bg-primary)' }} />
                        </div>
                      )}
                      <div
                        className={`max-w-[70%] rounded-2xl px-4 py-3 ${
                          message.role === 'user' ? 'rounded-br-sm' : 'rounded-bl-sm'
                        }`}
                        style={{
                          background: message.role === 'user'
                            ? 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)'
                            : 'var(--bg-secondary)',
                          color: message.role === 'user' ? 'var(--bg-primary)' : 'var(--text-primary)',
                          border: message.role === 'assistant' ? '1px solid var(--border-primary)' : 'none',
                        }}
                      >
                        <p data-testid="chat-message-content" className="whitespace-pre-wrap break-words">
                          {message.content}
                          {message.isStreaming && (
                            <span className="inline-block w-2 h-4 ml-1 animate-pulse" style={{ background: 'var(--color-primary)' }} />
                          )}
                        </p>
                      </div>
                      {message.role === 'user' && (
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                          style={{ background: 'var(--bg-tertiary)' }}
                        >
                          <User className="h-4 w-4" style={{ color: 'var(--text-secondary)' }} />
                        </div>
                      )}
                    </div>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* 输入区域 */}
          <div
            className="p-4 relative"
            style={{ borderTop: '1px solid var(--border-primary)', background: 'var(--bg-secondary)', zIndex: 1 }}
          >
            <div className="max-w-3xl mx-auto">
              {/* 模型选择器 */}
              {showModelSelector && activeModels.length > 0 && (
                <div className="mb-3">
                  <ModelSelector
                    models={activeModels}
                    selectedModel={selectedModelId}
                    onSelect={setSelectedModelId}
                    disabled={isProcessing}
                  />
                </div>
              )}

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
                    disabled={isProcessing}
                    className="flex-1 min-h-[44px] max-h-[120px] resize-none border-0 focus-visible:ring-0 py-2 px-2 text-base bg-transparent"
                    style={{ color: 'var(--text-primary)' }}
                    rows={1}
                  />
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs" style={{ color: 'var(--text-disabled)' }}>
                      {inputMessage.length}/{maxInputCharacters}
                    </span>
                    {isStreaming ? (
                      <Button
                        onClick={handleAbort}
                        className="h-9 px-5 gap-2 rounded-xl font-medium"
                        style={{
                          background: 'rgba(239, 68, 68, 0.8)',
                          color: '#ffffff',
                        }}
                      >
                        <Square className="h-4 w-4" />
                        停止
                      </Button>
                    ) : (
                      <Button
                        onClick={handleSend}
                        disabled={!inputMessage.trim() || isProcessing}
                        className="h-9 px-5 gap-2 rounded-xl font-medium"
                        style={{
                          background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                          color: 'var(--bg-primary)',
                        }}
                      >
                        {streamingLoading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <>
                            发送
                            <Send className="h-4 w-4" />
                          </>
                        )}
                      </Button>
                    )}
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

      {/* 导出对话对话框 */}
      {activeConversationId && (
        <ExportDialog
          open={exportDialogOpen}
          onOpenChange={setExportDialogOpen}
          conversationId={activeConversationId}
          conversationTitle={currentConversation?.title || '对话'}
          canBatchExport={canBatchExport}
        />
      )}

      {/* Low balance warning dialog */}
      <LowBalanceDialog
        open={lowBalanceDialogOpen}
        onOpenChange={setLowBalanceDialogOpen}
        credits={credits}
        warningLevel={warningLevel}
      />
    </div>
  );
}
