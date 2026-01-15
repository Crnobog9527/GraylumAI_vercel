'use client';

import { useState } from 'react';
import { ConversationList } from '@/components/chat/ConversationList';
import { ChatInterface } from '@/components/chat/ChatInterface';

export default function HomePage() {
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);

  return (
    <div className="grid grid-cols-[320px_1fr] h-screen bg-background">
      {/* Left Sidebar - Conversation List */}
      <div className="flex flex-col p-4 border-r border-border bg-card overflow-hidden">
        <h2 className="text-lg font-semibold mb-4 text-foreground">Conversations</h2>
        <div className="flex-1 overflow-y-auto">
          <ConversationList onSelectConversation={setSelectedConversationId} />
        </div>
      </div>
      {/* Main Chat Area */}
      <div className="flex flex-col bg-background overflow-hidden">
        {selectedConversationId ? (
          <ChatInterface conversationId={selectedConversationId} />
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-muted-foreground">Select a conversation to start chatting</p>
          </div>
        )}
      </div>
    </div>
  );
}
