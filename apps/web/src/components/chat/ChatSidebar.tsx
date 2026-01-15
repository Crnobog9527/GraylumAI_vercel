'use client';

import { useMemo } from 'react';
import { trpc } from '@/trpc/client';
import {
  Plus,
  MessageSquare,
  MoreHorizontal,
  Trash2,
  Pencil,
  Loader2
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface ChatSidebarProps {
  onSelectConversation: (id: string) => void;
  onNewChat: () => void;
  activeConversationId?: string;
}

// Helper function to group conversations by time
function groupConversationsByTime(conversations: Array<{ id: string; title: string | null; createdAt: Date | null }>) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

  const groups: {
    today: typeof conversations;
    yesterday: typeof conversations;
    thisWeek: typeof conversations;
    earlier: typeof conversations;
  } = {
    today: [],
    yesterday: [],
    thisWeek: [],
    earlier: []
  };

  conversations.forEach(conv => {
    if (!conv.createdAt) {
      groups.earlier.push(conv);
      return;
    }

    const convDate = new Date(conv.createdAt);
    if (convDate >= today) {
      groups.today.push(conv);
    } else if (convDate >= yesterday) {
      groups.yesterday.push(conv);
    } else if (convDate >= weekAgo) {
      groups.thisWeek.push(conv);
    } else {
      groups.earlier.push(conv);
    }
  });

  return groups;
}

// Time group header component
function TimeGroupHeader({ label }: { label: string }) {
  return (
    <div
      className="px-3 py-2 text-xs font-medium uppercase tracking-wider"
      style={{ color: 'var(--text-tertiary)' }}
    >
      {label}
    </div>
  );
}

// Single conversation item
function ConversationItem({
  conversation,
  isActive,
  onSelect,
  onDelete,
  onRename
}: {
  conversation: { id: string; title: string | null };
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: () => void;
}) {
  return (
    <div
      className="group relative flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-all duration-200"
      style={{
        background: isActive ? 'var(--color-primary-10)' : 'transparent',
        border: isActive ? '1px solid var(--color-primary-20)' : '1px solid transparent',
      }}
      onClick={onSelect}
      onMouseEnter={(e) => {
        if (!isActive) {
          e.currentTarget.style.background = 'var(--bg-tertiary)';
        }
      }}
      onMouseLeave={(e) => {
        if (!isActive) {
          e.currentTarget.style.background = 'transparent';
        }
      }}
    >
      <div
        className="p-1.5 rounded-lg transition-colors"
        style={{
          background: isActive ? 'var(--color-primary-20)' : 'var(--bg-tertiary)',
        }}
      >
        <MessageSquare
          className="h-4 w-4"
          style={{ color: isActive ? 'var(--color-primary)' : 'var(--text-tertiary)' }}
        />
      </div>

      <div className="flex-1 min-w-0">
        <p
          className="text-sm truncate font-medium"
          style={{ color: isActive ? 'var(--color-primary)' : 'var(--text-primary)' }}
        >
          {conversation.title || '新对话'}
        </p>
      </div>

      {/* Action menu - visible on hover */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ color: 'var(--text-tertiary)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-36 rounded-xl"
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-primary)'
          }}
        >
          <DropdownMenuItem
            className="gap-2 rounded-lg cursor-pointer"
            style={{ color: 'var(--text-secondary)' }}
            onClick={(e) => {
              e.stopPropagation();
              onRename();
            }}
          >
            <Pencil className="h-4 w-4" />
            <span>重命名</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2 rounded-lg cursor-pointer"
            style={{ color: 'var(--error)' }}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 className="h-4 w-4" />
            <span>删除</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function ChatSidebar({
  onSelectConversation,
  onNewChat,
  activeConversationId
}: ChatSidebarProps) {
  const { data: conversations, isLoading } = trpc.chat.getConversations.useQuery();

  const conversationList = conversations?.data || [];
  const groupedConversations = useMemo(
    () => groupConversationsByTime(conversationList),
    [conversationList]
  );

  const handleDelete = (id: string) => {
    // TODO: Implement delete mutation
    console.log('Delete conversation:', id);
  };

  const handleRename = (id: string) => {
    // TODO: Implement rename modal
    console.log('Rename conversation:', id);
  };

  return (
    <div
      className="w-64 flex flex-col h-full overflow-hidden"
      style={{
        background: 'var(--bg-secondary)',
        borderRight: '1px solid var(--border-primary)'
      }}
    >
      {/* New chat button */}
      <div className="p-4">
        <Button
          onClick={onNewChat}
          className="w-full gap-2 h-11 rounded-xl font-medium transition-all duration-200 hover:opacity-90"
          style={{
            background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
            color: 'var(--bg-primary)',
            boxShadow: '0 4px 15px rgba(255, 215, 0, 0.25)'
          }}
        >
          <Plus className="h-5 w-5" />
          新建对话
        </Button>
      </div>

      {/* Header bar */}
      <div
        className="flex items-center justify-between px-4 py-2"
        style={{ borderBottom: '1px solid var(--border-primary)' }}
      >
        <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
          全部对话
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs rounded-lg"
          style={{ color: 'var(--text-tertiary)' }}
        >
          管理
        </Button>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto p-2">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--color-primary)' }} />
          </div>
        ) : conversationList.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <div
              className="p-4 rounded-full mb-4"
              style={{
                background: 'var(--color-primary-10)',
                border: '1px solid var(--color-primary-20)'
              }}
            >
              <MessageSquare className="h-6 w-6" style={{ color: 'var(--color-primary)' }} />
            </div>
            <p style={{ color: 'var(--text-tertiary)' }} className="text-sm">
              暂无对话记录
            </p>
            <p style={{ color: 'var(--text-tertiary)' }} className="text-xs mt-1 opacity-70">
              点击上方按钮开始新对话
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {/* Today */}
            {groupedConversations.today.length > 0 && (
              <>
                <TimeGroupHeader label="今天" />
                {groupedConversations.today.map(conv => (
                  <ConversationItem
                    key={conv.id}
                    conversation={conv}
                    isActive={activeConversationId === conv.id}
                    onSelect={() => onSelectConversation(conv.id)}
                    onDelete={() => handleDelete(conv.id)}
                    onRename={() => handleRename(conv.id)}
                  />
                ))}
              </>
            )}

            {/* Yesterday */}
            {groupedConversations.yesterday.length > 0 && (
              <>
                <TimeGroupHeader label="昨天" />
                {groupedConversations.yesterday.map(conv => (
                  <ConversationItem
                    key={conv.id}
                    conversation={conv}
                    isActive={activeConversationId === conv.id}
                    onSelect={() => onSelectConversation(conv.id)}
                    onDelete={() => handleDelete(conv.id)}
                    onRename={() => handleRename(conv.id)}
                  />
                ))}
              </>
            )}

            {/* This week */}
            {groupedConversations.thisWeek.length > 0 && (
              <>
                <TimeGroupHeader label="本周" />
                {groupedConversations.thisWeek.map(conv => (
                  <ConversationItem
                    key={conv.id}
                    conversation={conv}
                    isActive={activeConversationId === conv.id}
                    onSelect={() => onSelectConversation(conv.id)}
                    onDelete={() => handleDelete(conv.id)}
                    onRename={() => handleRename(conv.id)}
                  />
                ))}
              </>
            )}

            {/* Earlier */}
            {groupedConversations.earlier.length > 0 && (
              <>
                <TimeGroupHeader label="更早" />
                {groupedConversations.earlier.map(conv => (
                  <ConversationItem
                    key={conv.id}
                    conversation={conv}
                    isActive={activeConversationId === conv.id}
                    onSelect={() => onSelectConversation(conv.id)}
                    onDelete={() => handleDelete(conv.id)}
                    onRename={() => handleRename(conv.id)}
                  />
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
