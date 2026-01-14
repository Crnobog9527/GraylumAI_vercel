'use client';

import { useState } from 'react';
import { ConversationList } from '@/components/chat/ConversationList';
import { ChatInterface } from '@/components/chat/ChatInterface';

export default function HomePage() {
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);

  return (
    <div className="grid grid-cols-[300px_1fr] h-screen">
      <div className="p-4 border-r">
        <h2 className="text-lg font-semibold mb-4">Conversations</h2>
        <ConversationList onSelectConversation={setSelectedConversationId} />
      </div>
      <div className="flex flex-col">
        {selectedConversationId ? (
          <ChatInterface conversationId={selectedConversationId} />
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-gray-500">Select a conversation to start chatting</p>
          </div>
        )}
      </div>
    </div>
  );
}
