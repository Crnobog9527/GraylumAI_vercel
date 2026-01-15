'use client';

import { memo } from 'react';
import { Pencil, Download, Settings2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ChatHeaderProps {
  currentConversation?: {
    id: string;
    title: string | null;
  } | null;
  isEditingTitle: boolean;
  setIsEditingTitle: (value: boolean) => void;
  editingTitleValue: string;
  setEditingTitleValue: (value: string) => void;
  onSaveTitle: () => void;
  canExport?: boolean;
  isExporting?: boolean;
  onExport?: () => void;
  showDebugPanel?: boolean;
  setShowDebugPanel?: (value: boolean) => void;
  isAdmin?: boolean;
}

const ChatHeader = memo(function ChatHeader({
  currentConversation,
  isEditingTitle,
  setIsEditingTitle,
  editingTitleValue,
  setEditingTitleValue,
  onSaveTitle,
  canExport = false,
  isExporting = false,
  onExport,
  showDebugPanel = false,
  setShowDebugPanel,
  isAdmin = false
}: ChatHeaderProps) {
  return (
    <div
      className="h-14 flex items-center justify-between px-6 relative"
      style={{ borderBottom: '1px solid var(--border-primary)', zIndex: 1 }}
    >
      <div className="flex items-center gap-3">
        {isEditingTitle && currentConversation ? (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={editingTitleValue}
              onChange={(e) => setEditingTitleValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onSaveTitle();
                } else if (e.key === 'Escape') {
                  setIsEditingTitle(false);
                }
              }}
              autoFocus
              className="text-lg font-medium rounded px-2 py-1 focus:outline-none focus:ring-2"
              style={{
                background: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--color-primary)',
                boxShadow: '0 0 0 2px rgba(255, 215, 0, 0.2)'
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={onSaveTitle}
              style={{ color: 'var(--color-primary)' }}
            >
              保存
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsEditingTitle(false)}
              style={{ color: 'var(--text-tertiary)' }}
            >
              取消
            </Button>
          </div>
        ) : (
          <>
            <h1 className="text-lg font-medium" style={{ color: 'var(--text-primary)' }}>
              {currentConversation?.title || '新对话'}
            </h1>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 hover:opacity-80"
              style={{ color: 'var(--text-tertiary)' }}
              onClick={() => {
                if (currentConversation) {
                  setEditingTitleValue(currentConversation.title || '');
                  setIsEditingTitle(true);
                }
              }}
              disabled={!currentConversation}
            >
              <Pencil className="h-4 w-4" />
            </Button>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        {/* 导出按钮 */}
        {canExport && currentConversation && onExport && (
          <Button
            variant="outline"
            size="sm"
            onClick={onExport}
            disabled={isExporting}
            className="h-9 px-3 gap-2"
            style={{
              background: 'transparent',
              borderColor: 'var(--border-primary)',
              color: 'var(--text-secondary)'
            }}
          >
            {isExporting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            导出
          </Button>
        )}

        {/* 调试面板切换 (仅管理员) */}
        {isAdmin && setShowDebugPanel && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowDebugPanel(!showDebugPanel)}
            className={cn("h-9 px-3 gap-2")}
            style={{
              background: showDebugPanel ? 'rgba(139, 92, 246, 0.1)' : 'transparent',
              borderColor: showDebugPanel ? '#A78BFA' : 'var(--border-primary)',
              color: showDebugPanel ? '#A78BFA' : 'var(--text-secondary)'
            }}
          >
            <Settings2 className="h-4 w-4" />
            调试
          </Button>
        )}
      </div>
    </div>
  );
});

export default ChatHeader;
