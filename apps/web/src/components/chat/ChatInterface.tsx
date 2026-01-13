'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface ChatInterfaceProps {
  conversationId: string;
}

export function ChatInterface({ conversationId }: ChatInterfaceProps) {
  const { data: messages, isLoading, refetch } = trpc.chat.getMessages.useQuery({ conversationId });
  const sendMessage = trpc.chat.sendMessage.useMutation({
    onSuccess: () => {
      refetch(); // Refetch messages after sending
      setNewMessage('');
    },
  });
  const [newMessage, setNewMessage] = useState('');

  const handleSend = () => {
    if (newMessage.trim() !== '') {
      sendMessage.mutate({ conversationId, content: newMessage });
    }
  };

  if (isLoading) return <div>Loading messages...</div>;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-grow p-4 space-y-4 overflow-y-auto">
        {messages?.data?.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`px-4 py-2 rounded-lg ${msg.role === 'user' ? 'bg-blue-500 text-white' : 'bg-gray-200'}`}>
              {msg.content}
            </div>
          </div>
        ))}
      </div>
      <div className="p-4 flex gap-2">
        <Input
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="Type your message..."
        />
        <Button onClick={handleSend} disabled={sendMessage.isPending}>
          Send
        </Button>
      </div>
    </div>
  );
}
