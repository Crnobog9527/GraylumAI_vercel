'use client';

import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';

interface ConversationListProps {
  onSelectConversation: (id: string) => void;
}

export function ConversationList({ onSelectConversation }: ConversationListProps) {
  const { data: conversations, isLoading } = trpc.chat.getConversations.useQuery();

  if (isLoading) return <div>Loading conversations...</div>;

  return (
    <div className="flex flex-col gap-2">
      {conversations?.data?.map((convo) => (
        <Button
          key={convo.id}
          variant="outline"
          onClick={() => onSelectConversation(convo.id)}
          className="justify-start"
        >
          {convo.title}
        </Button>
      ))}
    </div>
  );
}
