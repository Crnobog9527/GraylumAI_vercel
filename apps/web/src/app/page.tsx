'use client';

import { useState, useRef } from 'react';
import { AppHeader } from '@/components/layout/AppHeader';
import { ChatSidebar } from '@/components/chat/ChatSidebar';
import { ChatInterface } from '@/components/chat/ChatInterface';
import { MessageSquare, Sparkles, Paperclip, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export default function HomePage() {
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [inputMessage, setInputMessage] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleNewChat = () => {
    // TODO: Create new conversation via tRPC mutation
    setSelectedConversationId(null);
  };

  const handleSend = () => {
    if (!inputMessage.trim()) return;
    // TODO: Create conversation and send message
    console.log('Send:', inputMessage);
    setInputMessage('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-screen relative" style={{ background: 'var(--bg-primary)' }}>
      {/* 背景光晕效果 - 左下角 */}
      <div
        className="fixed pointer-events-none"
        style={{
          left: '-10%',
          bottom: '-20%',
          width: '50%',
          height: '60%',
          background: 'radial-gradient(ellipse at center, rgba(255, 215, 0, 0.08) 0%, rgba(255, 165, 0, 0.04) 40%, transparent 70%)',
          filter: 'blur(60px)',
          zIndex: 0,
        }}
      />
      {/* 背景光晕效果 - 右上角 */}
      <div
        className="fixed pointer-events-none"
        style={{
          right: '-10%',
          top: '-10%',
          width: '45%',
          height: '50%',
          background: 'radial-gradient(ellipse at center, rgba(255, 215, 0, 0.06) 0%, rgba(255, 165, 0, 0.03) 40%, transparent 70%)',
          filter: 'blur(60px)',
          zIndex: 0,
        }}
      />

      {/* Top Header */}
      <AppHeader />

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden relative z-10">
        {/* Left Sidebar */}
        <ChatSidebar
          onSelectConversation={setSelectedConversationId}
          onNewChat={handleNewChat}
          activeConversationId={selectedConversationId ?? undefined}
        />

        {/* Main Chat Area */}
        <div className="flex-1 flex flex-col overflow-hidden relative">
          {selectedConversationId ? (
            <ChatInterface conversationId={selectedConversationId} />
          ) : (
            <div className="flex-1 flex flex-col">
              {/* 欢迎区域 - 居中 */}
              <div className="flex-1 flex flex-col items-center justify-center">
                <div
                  className="w-20 h-20 rounded-2xl flex items-center justify-center mb-5"
                  style={{
                    background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                    boxShadow: '0 0 40px rgba(255, 215, 0, 0.3)'
                  }}
                >
                  <Sparkles className="h-10 w-10" style={{ color: 'var(--bg-primary)' }} />
                </div>
                <h2 className="text-2xl font-bold mb-2" style={{
                  background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent'
                }}>
                  开始新对话
                </h2>
                <p className="text-base" style={{ color: 'var(--text-tertiary)' }}>
                  选择一个对话或开始新的聊天
                </p>
              </div>

              {/* 底部输入框 - 悬浮样式 */}
              <div className="p-4 pb-6">
                <div className="max-w-3xl mx-auto">
                  {/* 输入框容器 */}
                  <div
                    className="relative rounded-2xl backdrop-blur-xl"
                    style={{
                      background: 'rgba(26, 26, 26, 0.8)',
                      border: '1px solid rgba(255, 215, 0, 0.15)',
                      boxShadow: '0 4px 24px rgba(0, 0, 0, 0.3)'
                    }}
                  >
                    <div className="flex items-end p-3">
                      {/* 左侧附件按钮 */}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 shrink-0 hover:opacity-80"
                        style={{ color: 'var(--text-tertiary)' }}
                      >
                        <Paperclip className="h-5 w-5" />
                      </Button>

                      {/* 中间输入框 */}
                      <Textarea
                        ref={textareaRef}
                        value={inputMessage}
                        onChange={(e) => setInputMessage(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="请输入您的问题..."
                        className="flex-1 min-h-[44px] max-h-[120px] resize-none border-0 focus-visible:ring-0 py-2 px-2 text-base bg-transparent"
                        style={{ color: 'var(--text-primary)' }}
                        rows={1}
                      />

                      {/* 右侧字数统计和发送按钮 */}
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-xs" style={{ color: 'var(--text-disabled)' }}>
                          {inputMessage.length}/2500
                        </span>
                        <Button
                          onClick={handleSend}
                          disabled={!inputMessage.trim()}
                          className="h-9 px-5 gap-2 rounded-xl font-medium"
                          style={{
                            background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                            color: 'var(--bg-primary)',
                          }}
                        >
                          发送
                          <Send className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>

                  {/* 温馨提示 */}
                  <div
                    className="mt-3 text-sm text-center"
                    style={{ color: 'var(--color-primary)' }}
                  >
                    🔔 温馨提示：为了保证回复质量，请尽量详细描述您的问题
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
