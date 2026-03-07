'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { Download, FileText, FileJson, File, Loader2, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode?: 'single' | 'selected';
  conversationId?: string;
  conversationIds?: string[];
  conversationTitle?: string;
  conversationCount?: number;
  canBatchExport?: boolean;
}

type ExportFormat = 'markdown' | 'json' | 'txt';

const formatOptions: { value: ExportFormat; label: string; icon: React.ElementType; description: string }[] = [
  { value: 'markdown', label: 'Markdown', icon: FileText, description: '适合阅读和分享' },
  { value: 'json', label: 'JSON', icon: FileJson, description: '适合程序处理' },
  { value: 'txt', label: '纯文本', icon: File, description: '最简洁的格式' },
];

export default function ExportDialog({
  open,
  onOpenChange,
  mode = 'single',
  conversationId,
  conversationIds = [],
  conversationTitle = '对话',
  conversationCount = 0,
  canBatchExport = false,
}: ExportDialogProps) {
  const [selectedFormat, setSelectedFormat] = useState<ExportFormat>('markdown');
  const [isExporting, setIsExporting] = useState(false);
  const [exportSuccess, setExportSuccess] = useState(false);

  const utils = trpc.useUtils();
  const isBatchMode = mode === 'selected';
  const availableFormats = isBatchMode
    ? formatOptions.filter((format) => format.value !== 'txt')
    : formatOptions;

  const closeWithSuccess = () => {
    setExportSuccess(true);
    setTimeout(() => {
      setExportSuccess(false);
      onOpenChange(false);
    }, 1500);
  };

  const handleExport = async () => {
    setIsExporting(true);
    setExportSuccess(false);

    try {
      const result = isBatchMode
        ? await utils.client.chat.exportSelectedConversations.query({
            conversationIds,
            format: selectedFormat === 'txt' ? 'markdown' : selectedFormat,
          })
        : await utils.client.chat.exportConversation.query({
            conversationId: conversationId!,
            format: selectedFormat,
          });

      downloadFile(result.content, result.filename, result.mimeType);
      closeWithSuccess();
    } catch (error) {
      console.error('Export failed:', error);
      alert('导出失败，请稍后重试');
    } finally {
      setIsExporting(false);
    }
  };

  // Export all conversations (batch)
  const handleBatchExport = async () => {
    setIsExporting(true);
    setExportSuccess(false);

    try {
      const result = await utils.client.chat.exportAllConversations.query({
        format: selectedFormat === 'txt' ? 'markdown' : selectedFormat,
      });

      downloadFile(result.content, result.filename, result.mimeType);
      closeWithSuccess();
    } catch (error) {
      console.error('Batch export failed:', error);
      alert('批量导出失败，请稍后重试');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
        }}
      >
        <DialogHeader>
          <DialogTitle style={{ color: 'var(--text-primary)' }}>
            {isBatchMode ? '批量导出对话' : '导出对话'}
          </DialogTitle>
          <DialogDescription style={{ color: 'var(--text-tertiary)' }}>
            {isBatchMode
              ? `将已选中的 ${conversationCount} 条对话导出为文件`
              : `将当前对话 "${conversationTitle}" 导出为文件`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Format selection */}
          <div className="space-y-2">
              <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                选择导出格式
              </label>
              <div className="grid grid-cols-3 gap-2">
              {availableFormats.map((format) => {
                const Icon = format.icon;
                const isSelected = selectedFormat === format.value;
                return (
                  <button
                    key={format.value}
                    onClick={() => setSelectedFormat(format.value)}
                    disabled={isExporting}
                    className={cn(
                      'flex flex-col items-center gap-2 p-3 rounded-xl border transition-all',
                      isSelected
                        ? 'border-[var(--color-primary)]'
                        : 'border-[var(--border-primary)] hover:border-[var(--border-secondary)]'
                    )}
                    style={{
                      background: isSelected ? 'var(--color-primary-10)' : 'var(--bg-primary)',
                    }}
                  >
                    <Icon
                      className="h-5 w-5"
                      style={{ color: isSelected ? 'var(--color-primary)' : 'var(--text-tertiary)' }}
                    />
                    <span
                      className="text-xs font-medium"
                      style={{ color: isSelected ? 'var(--color-primary)' : 'var(--text-secondary)' }}
                    >
                      {format.label}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {availableFormats.find((f) => f.value === selectedFormat)?.description}
            </p>
          </div>

          {/* Export buttons */}
          <div className="flex flex-col gap-2">
            <Button
              onClick={handleExport}
              disabled={isExporting || (isBatchMode && (!canBatchExport || conversationIds.length === 0))}
              data-testid={isBatchMode ? 'export-selected-conversations' : 'export-current-conversation'}
              className="w-full gap-2"
              style={{
                background: exportSuccess
                  ? 'rgba(34, 197, 94, 0.9)'
                  : 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                color: 'var(--bg-primary)',
              }}
            >
              {isExporting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : exportSuccess ? (
                <CheckCircle className="h-4 w-4" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {exportSuccess
                ? '导出成功！'
                : isBatchMode
                  ? `导出已选 ${conversationCount} 条对话`
                  : '导出当前对话'}
            </Button>

            {!isBatchMode && canBatchExport && (
              <Button
                onClick={handleBatchExport}
                disabled={isExporting}
                variant="outline"
                className="w-full gap-2"
                style={{
                  borderColor: 'var(--border-primary)',
                  color: 'var(--text-secondary)',
                }}
              >
                {isExporting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                导出全部对话
              </Button>
            )}
          </div>

          {!canBatchExport && (
            <p className="text-xs text-center" style={{ color: 'var(--text-tertiary)' }}>
              升级会员可解锁批量导出功能
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Helper function to download file
function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
