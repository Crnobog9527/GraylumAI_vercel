'use client';

import { trpc } from '@/trpc/client';
import { MessageSquare, Loader2 } from 'lucide-react';

interface ConversationListProps {
  onSelectConversation: (id: string) => void;
  activeConversationId?: string;
}

export function ConversationList({
  onSelectConversation,
  activeConversationId
}: ConversationListProps) {
  const { data: conversations, isLoading } = trpc.chat.getConversations.useQuery();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'hsl(var(--primary))' }} />
      </div>
    );
  }

  const conversationList = conversations?.data || [];

  if (conversationList.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
        <div
          className="p-4 rounded-full mb-4"
          style={{
            background: 'var(--color-primary-10)',
            border: '1px solid var(--color-primary-20)'
          }}
        >
          <MessageSquare className="h-6 w-6" style={{ color: 'hsl(var(--primary))' }} />
        </div>
        <p style={{ color: 'hsl(var(--muted-foreground))' }} className="text-sm">
          No conversations yet
        </p>
        <p style={{ color: 'hsl(var(--muted-foreground))' }} className="text-xs mt-1 opacity-70">
          Start a new chat to begin
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1 p-2">
      {conversationList.map((conv) => {
        const isActive = activeConversationId === conv.id;

        return (
          <div
            key={conv.id}
            className="group relative flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-all duration-200"
            style={{
              background: isActive ? 'var(--color-primary-10)' : 'transparent',
              border: isActive ? '1px solid var(--color-primary-20)' : '1px solid transparent',
            }}
            onClick={() => onSelectConversation(conv.id)}
            onMouseEnter={(e) => {
              if (!isActive) {
                e.currentTarget.style.background = 'hsl(var(--muted))';
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                e.currentTarget.style.background = 'transparent';
              }
            }}
          >
            <div
              className="p-2 rounded-lg transition-colors"
              style={{
                background: isActive ? 'var(--color-primary-20)' : 'hsl(var(--muted))',
              }}
            >
              <MessageSquare
                className="h-4 w-4"
                style={{ color: isActive ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))' }}
              />
            </div>

            <div className="flex-1 min-w-0">
              <p
                className="font-medium text-sm truncate"
                style={{ color: isActive ? 'hsl(var(--primary))' : 'hsl(var(--foreground))' }}
              >
                {conv.title || 'New Chat'}
              </p>
              <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                {conv.createdAt ? new Date(conv.createdAt).toLocaleDateString() : ''}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
