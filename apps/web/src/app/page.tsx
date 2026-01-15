'use client';

import { useState } from 'react';
import { ConversationList } from '@/components/chat/ConversationList';
import { ChatInterface } from '@/components/chat/ChatInterface';
import { MessageSquare, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function HomePage() {
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);

  return (
    <div className="grid grid-cols-[320px_1fr] h-screen" style={{ background: 'hsl(var(--background))' }}>
      {/* Left Sidebar - Conversation List */}
      <div
        className="flex flex-col overflow-hidden"
        style={{
          background: 'hsl(var(--card))',
          borderRight: '1px solid hsl(var(--border))'
        }}
      >
        {/* Sidebar Header */}
        <div className="p-4" style={{ borderBottom: '1px solid hsl(var(--border))' }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
              Conversations
            </h2>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg"
              style={{
                background: 'var(--color-primary-10)',
                color: 'hsl(var(--primary))'
              }}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Conversation List */}
        <div className="flex-1 overflow-y-auto">
          <ConversationList
            onSelectConversation={setSelectedConversationId}
            activeConversationId={selectedConversationId ?? undefined}
          />
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex flex-col overflow-hidden" style={{ background: 'hsl(var(--background))' }}>
        {selectedConversationId ? (
          <ChatInterface conversationId={selectedConversationId} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full">
            <div
              className="w-20 h-20 rounded-2xl flex items-center justify-center mb-6"
              style={{
                background: 'var(--color-primary-10)',
                border: '1px solid var(--color-primary-20)'
              }}
            >
              <MessageSquare className="h-10 w-10" style={{ color: 'hsl(var(--primary))' }} />
            </div>
            <h2 className="text-2xl font-semibold mb-2" style={{ color: 'hsl(var(--foreground))' }}>
              Welcome to GraylumAI
            </h2>
            <p style={{ color: 'hsl(var(--muted-foreground))' }}>
              Select a conversation or start a new chat
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
