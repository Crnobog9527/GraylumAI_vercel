'use client';

import { useState } from 'react';
import { AppHeader } from '@/components/layout/AppHeader';
import { ChatSidebar } from '@/components/chat/ChatSidebar';
import { ChatInterface } from '@/components/chat/ChatInterface';
import { MessageSquare, Sparkles } from 'lucide-react';

export default function HomePage() {
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);

  const handleNewChat = () => {
    // TODO: Create new conversation via tRPC mutation
    setSelectedConversationId(null);
  };

  return (
    <div className="flex flex-col h-screen" style={{ background: 'var(--bg-primary)' }}>
      {/* Top Header */}
      <AppHeader />

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar */}
        <ChatSidebar
          onSelectConversation={setSelectedConversationId}
          onNewChat={handleNewChat}
          activeConversationId={selectedConversationId ?? undefined}
        />

        {/* Main Chat Area */}
        <div className="flex-1 flex flex-col overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
          {selectedConversationId ? (
            <ChatInterface conversationId={selectedConversationId} />
          ) : (
            <div className="flex flex-col items-center justify-center h-full">
              <div
                className="w-24 h-24 rounded-2xl flex items-center justify-center mb-6"
                style={{
                  background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                  boxShadow: '0 0 40px rgba(255, 215, 0, 0.3)'
                }}
              >
                <Sparkles className="h-12 w-12" style={{ color: 'var(--bg-primary)' }} />
              </div>
              <h2 className="text-3xl font-bold mb-3" style={{
                background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent'
              }}>
                欢迎使用 GraylumAI
              </h2>
              <p className="text-lg" style={{ color: 'var(--text-tertiary)' }}>
                选择一个对话或开始新的聊天
              </p>
              <div className="flex items-center gap-2 mt-6 text-sm" style={{ color: 'var(--text-disabled)' }}>
                <MessageSquare className="h-4 w-4" />
                <span>点击左侧「新建对话」按钮开始</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
