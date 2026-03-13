'use client';

import { useMemo, useState } from 'react';
import { trpc } from '@/trpc/client';
import { useChatStore } from '@/stores';
import {
  Plus,
  MessageSquare,
  MoreHorizontal,
  Trash2,
  Pencil,
  Loader2,
  Settings2,
  Download,
  CheckSquare,
  X
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import ExportDialog from '@/components/chat/ExportDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

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
  isManaging,
  isSelected,
  onSelect,
  onToggleSelection,
  onDelete,
  onRename
}: {
  conversation: { id: string; title: string | null };
  isActive: boolean;
  isManaging: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onToggleSelection: () => void;
  onDelete: () => void;
  onRename: () => void;
}) {
  return (
    <div
      data-testid="conversation-item"
      className="group relative flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-[background-color,border-color,transform,opacity] duration-200 motion-reduce:transition-none hover:bg-[var(--bg-tertiary)] hover:border-[var(--border-secondary)]"
      style={{
        background: isSelected || isActive ? 'var(--color-primary-10)' : 'transparent',
        border: isSelected || isActive ? '1px solid var(--color-primary-20)' : '1px solid transparent',
      }}
      onClick={isManaging ? onToggleSelection : onSelect}
    >
      {isManaging && (
        <Checkbox
          data-testid="conversation-select-checkbox"
          checked={isSelected}
          onCheckedChange={() => onToggleSelection()}
          onClick={(event) => event.stopPropagation()}
          aria-label={`选择对话 ${conversation.title || '新对话'}`}
        />
      )}

      <div
        className="p-1.5 rounded-lg transition-colors"
        style={{
          background: isSelected || isActive ? 'var(--color-primary-20)' : 'var(--bg-tertiary)',
        }}
      >
        <MessageSquare
          className="h-4 w-4"
          style={{ color: isSelected || isActive ? 'var(--color-primary)' : 'var(--text-tertiary)' }}
        />
      </div>

      <div className="flex-1 min-w-0">
        <p
          className="text-sm truncate font-medium"
          style={{ color: isSelected || isActive ? 'var(--color-primary)' : 'var(--text-primary)' }}
        >
          {conversation.title || '新对话'}
        </p>
      </div>

      {!isManaging && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              data-testid="conversation-actions-trigger"
              variant="ghost"
              size="icon"
              aria-label="打开对话操作菜单"
              className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity duration-200 motion-reduce:transition-none"
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
      )}
    </div>
  );
}

export function ChatSidebar({
  onSelectConversation,
  onNewChat,
  activeConversationId
}: ChatSidebarProps) {
  const { setActiveConversation } = useChatStore();
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [batchDeleteDialogOpen, setBatchDeleteDialogOpen] = useState(false);
  const [batchExportDialogOpen, setBatchExportDialogOpen] = useState(false);
  const [managementMode, setManagementMode] = useState(false);
  const [selectedConvIds, setSelectedConvIds] = useState<string[]>([]);
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const utils = trpc.useUtils();
  const { data: conversations, isLoading } = trpc.chat.getConversations.useQuery();
  const { data: exportPermissions } = trpc.chat.getExportPermissions.useQuery();

  const deleteConversation = trpc.chat.deleteConversation.useMutation({
    onMutate: async ({ conversationId }) => {
      await utils.chat.getConversations.cancel();
      const previousConversations = utils.chat.getConversations.getData();

      if (previousConversations?.error === null) {
        utils.chat.getConversations.setData(undefined, {
          ...previousConversations,
          data: previousConversations.data.filter((conversation) => conversation.id !== conversationId),
        });
      }

      if (activeConversationId === selectedConvId) {
        setActiveConversation(null);
        onNewChat();
      }
      setDeleteDialogOpen(false);
      setSelectedConvId(null);
      return { previousConversations };
    },
    onError: (_error, _variables, context) => {
      if (context?.previousConversations) {
        utils.chat.getConversations.setData(undefined, context.previousConversations);
      }
    },
    onSettled: () => {
      utils.chat.getConversations.invalidate();
    },
  });

  const renameConversation = trpc.chat.updateConversationTitle.useMutation({
    onSuccess: () => {
      utils.chat.getConversations.invalidate();
      setRenameDialogOpen(false);
      setSelectedConvId(null);
      setRenameValue('');
    },
  });

  const deleteConversations = trpc.chat.deleteConversations.useMutation({
    onMutate: async ({ conversationIds }) => {
      await utils.chat.getConversations.cancel();
      const previousConversations = utils.chat.getConversations.getData();
      const deletedConversationIds = new Set(conversationIds);

      if (previousConversations?.error === null) {
        utils.chat.getConversations.setData(undefined, {
          ...previousConversations,
          data: previousConversations.data.filter((conversation) => !deletedConversationIds.has(conversation.id)),
        });
      }

      if (activeConversationId && selectedConvIds.includes(activeConversationId)) {
        setActiveConversation(null);
        onNewChat();
      }
      setBatchDeleteDialogOpen(false);
      setSelectedConvIds([]);
      setManagementMode(false);
      return { previousConversations };
    },
    onError: (_error, _variables, context) => {
      if (context?.previousConversations) {
        utils.chat.getConversations.setData(undefined, context.previousConversations);
      }
    },
    onSettled: () => {
      utils.chat.getConversations.invalidate();
    },
  });

  const conversationList = conversations?.data || [];
  const canBatchExport = exportPermissions?.allowBatchExport ?? false;
  const allConversationIds = useMemo(
    () => conversationList.map((conversation) => conversation.id),
    [conversationList]
  );
  const groupedConversations = useMemo(
    () => groupConversationsByTime(conversationList),
    [conversationList]
  );

  const handleDelete = (id: string) => {
    setSelectedConvId(id);
    setDeleteDialogOpen(true);
  };

  const handleRename = (id: string) => {
    const conv = conversationList.find(c => c.id === id);
    setSelectedConvId(id);
    setRenameValue(conv?.title || '');
    setRenameDialogOpen(true);
  };

  const confirmDelete = () => {
    if (selectedConvId) {
      deleteConversation.mutate({ conversationId: selectedConvId });
    }
  };

  const confirmBatchDelete = () => {
    if (selectedConvIds.length > 0) {
      deleteConversations.mutate({ conversationIds: selectedConvIds });
    }
  };

  const confirmRename = () => {
    if (selectedConvId && renameValue.trim()) {
      renameConversation.mutate({ conversationId: selectedConvId, title: renameValue.trim() });
    }
  };

  const toggleManagementMode = () => {
    setManagementMode((current) => {
      if (current) {
        setSelectedConvIds([]);
      }
      return !current;
    });
  };

  const toggleConversationSelection = (conversationId: string) => {
    setSelectedConvIds((current) =>
      current.includes(conversationId)
        ? current.filter((id) => id !== conversationId)
        : [...current, conversationId]
    );
  };

  const toggleSelectAll = () => {
    setSelectedConvIds((current) =>
      current.length === allConversationIds.length ? [] : allConversationIds
    );
  };

  const handleSelectConversation = (id: string) => {
    setActiveConversation(id);
    onSelectConversation(id);
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
          data-testid="conversation-new-chat"
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
        <span className="text-sm font-medium flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
          全部对话
        </span>
        <Button
          variant="ghost"
          size="sm"
          data-testid="conversation-manage-toggle"
          className="h-7 px-2 text-xs rounded-lg flex items-center gap-1"
          style={{ color: 'var(--text-tertiary)' }}
          onClick={toggleManagementMode}
        >
          {managementMode ? <X className="h-3.5 w-3.5" /> : <Settings2 className="h-3.5 w-3.5" />}
          {managementMode ? '完成' : '管理'}
        </Button>
      </div>

      {managementMode && conversationList.length > 0 && (
        <div
          className="px-3 py-3 space-y-2"
          style={{ borderBottom: '1px solid var(--border-primary)', background: 'var(--bg-primary)' }}
        >
          <div className="flex items-center justify-between text-xs" style={{ color: 'var(--text-tertiary)' }}>
            <span data-testid="conversation-selected-count">已选择 {selectedConvIds.length} 条</span>
            <Button
              data-testid="conversation-select-all"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              style={{ color: 'var(--color-primary)' }}
              onClick={toggleSelectAll}
            >
              <CheckSquare className="h-3.5 w-3.5" />
              {selectedConvIds.length === allConversationIds.length ? '取消全选' : '全选'}
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button
              data-testid="conversation-batch-export"
              variant="outline"
              className="h-9 gap-2"
              disabled={selectedConvIds.length === 0}
              style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}
              onClick={() => setBatchExportDialogOpen(true)}
            >
              <Download className="h-4 w-4" />
              批量导出
            </Button>
            <Button
              data-testid="conversation-batch-delete"
              variant="outline"
              className="h-9 gap-2"
              disabled={selectedConvIds.length === 0}
              style={{ borderColor: 'rgba(239, 68, 68, 0.35)', color: 'var(--error)' }}
              onClick={() => setBatchDeleteDialogOpen(true)}
            >
              <Trash2 className="h-4 w-4" />
              批量删除
            </Button>
          </div>

          {!canBatchExport && (
            <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              当前会员不支持批量导出，但仍可批量删除对话。
            </p>
          )}
        </div>
      )}

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
                    isActive={!managementMode && activeConversationId === conv.id}
                    isManaging={managementMode}
                    isSelected={selectedConvIds.includes(conv.id)}
                    onSelect={() => handleSelectConversation(conv.id)}
                    onToggleSelection={() => toggleConversationSelection(conv.id)}
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
                    isActive={!managementMode && activeConversationId === conv.id}
                    isManaging={managementMode}
                    isSelected={selectedConvIds.includes(conv.id)}
                    onSelect={() => handleSelectConversation(conv.id)}
                    onToggleSelection={() => toggleConversationSelection(conv.id)}
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
                    isActive={!managementMode && activeConversationId === conv.id}
                    isManaging={managementMode}
                    isSelected={selectedConvIds.includes(conv.id)}
                    onSelect={() => handleSelectConversation(conv.id)}
                    onToggleSelection={() => toggleConversationSelection(conv.id)}
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
                    isActive={!managementMode && activeConversationId === conv.id}
                    isManaging={managementMode}
                    isSelected={selectedConvIds.includes(conv.id)}
                    onSelect={() => handleSelectConversation(conv.id)}
                    onToggleSelection={() => toggleConversationSelection(conv.id)}
                    onDelete={() => handleDelete(conv.id)}
                    onRename={() => handleRename(conv.id)}
                  />
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {/* Rename Dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <DialogHeader>
            <DialogTitle style={{ color: 'var(--text-primary)' }}>重命名对话</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder="输入新标题"
            className="bg-[var(--bg-primary)] border-[var(--border-primary)] text-[var(--text-primary)]"
            onKeyDown={(e) => e.key === 'Enter' && confirmRename()}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenameDialogOpen(false)}
              className="border-[var(--border-primary)] text-[var(--text-secondary)]"
            >
              取消
            </Button>
            <Button
              onClick={confirmRename}
              disabled={!renameValue.trim() || renameConversation.isPending}
              style={{
                background: 'var(--color-primary)',
                color: 'var(--bg-primary)',
              }}
            >
              {renameConversation.isPending ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ExportDialog
        open={batchExportDialogOpen}
        onOpenChange={setBatchExportDialogOpen}
        mode="selected"
        conversationIds={selectedConvIds}
        conversationCount={selectedConvIds.length}
        canBatchExport={canBatchExport}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <AlertDialogHeader>
            <AlertDialogTitle style={{ color: 'var(--text-primary)' }}>确认删除</AlertDialogTitle>
            <AlertDialogDescription style={{ color: 'var(--text-tertiary)' }}>
              此操作将永久删除该对话及所有消息记录，且无法恢复。确定要继续吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-[var(--border-primary)] text-[var(--text-secondary)]">
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={deleteConversation.isPending}
              style={{ background: 'var(--error)', color: 'white' }}
            >
              {deleteConversation.isPending ? '删除中...' : '删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={batchDeleteDialogOpen} onOpenChange={setBatchDeleteDialogOpen}>
        <AlertDialogContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <AlertDialogHeader>
            <AlertDialogTitle style={{ color: 'var(--text-primary)' }}>确认批量删除</AlertDialogTitle>
            <AlertDialogDescription style={{ color: 'var(--text-tertiary)' }}>
              将永久删除已选中的 {selectedConvIds.length} 条对话及其消息记录，且无法恢复。确定要继续吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-[var(--border-primary)] text-[var(--text-secondary)]">
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmBatchDelete}
              disabled={deleteConversations.isPending}
              style={{ background: 'var(--error)', color: 'white' }}
            >
              {deleteConversations.isPending ? '删除中...' : `删除 ${selectedConvIds.length} 条`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
