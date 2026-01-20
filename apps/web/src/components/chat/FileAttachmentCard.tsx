'use client';

import React, { useState } from 'react';
import {
  FileText,
  Image as ImageIcon,
  FileSpreadsheet,
  File,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface Attachment {
  fileName: string;
  fileSize?: number;
  fileType?: string;
  contentType?: string;
  mediaType?: string;
  content?: string;
  preview?: string;
  truncated?: boolean;
}

interface FileAttachmentCardProps {
  attachment: Attachment;
  className?: string;
}

const getFileIcon = (fileType?: string) => {
  if (fileType?.startsWith('image/')) return ImageIcon;
  if (fileType?.includes('word') || fileType?.includes('docx')) return FileText;
  if (fileType?.includes('sheet') || fileType?.includes('csv'))
    return FileSpreadsheet;
  if (fileType === 'application/pdf') return FileText;
  return File;
};

const formatFileSize = (bytes?: number) => {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
};

export default function FileAttachmentCard({
  attachment,
  className,
}: FileAttachmentCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const Icon = getFileIcon(attachment.fileType);
  const isImage = attachment.contentType === 'image';

  return (
    <div
      className={cn('rounded-lg overflow-hidden', className)}
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
      }}
    >
      {/* 文件卡片头部 */}
      <button
        onClick={() => !isImage && setIsExpanded(!isExpanded)}
        className={cn(
          'w-full p-3 flex items-center gap-3 text-left transition-colors',
          !isImage && 'hover:bg-[var(--bg-tertiary)]'
        )}
      >
        <div
          className="p-2 rounded-lg"
          style={{
            background: 'var(--bg-primary)',
            border: '1px solid var(--border-primary)',
          }}
        >
          <Icon className="h-5 w-5" style={{ color: 'var(--text-secondary)' }} />
        </div>
        <div className="flex-1 min-w-0">
          <p
            className="font-medium truncate"
            style={{ color: 'var(--text-primary)' }}
          >
            {attachment.fileName}
          </p>
          <div
            className="flex items-center gap-2 text-xs"
            style={{ color: 'var(--text-tertiary)' }}
          >
            <span>{formatFileSize(attachment.fileSize)}</span>
            {attachment.truncated && (
              <span style={{ color: 'var(--warning)' }}>• 已截取</span>
            )}
          </div>
        </div>
        {!isImage && (
          <div style={{ color: 'var(--text-disabled)' }}>
            {isExpanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </div>
        )}
      </button>

      {/* 展开的内容 */}
      {isExpanded && !isImage && (
        <div
          className="p-3 max-h-[300px] overflow-y-auto"
          style={{
            borderTop: '1px solid var(--border-primary)',
            background: 'var(--bg-primary)',
          }}
        >
          <pre
            className="text-xs whitespace-pre-wrap font-mono"
            style={{ color: 'var(--text-secondary)' }}
          >
            {attachment.preview || attachment.content?.slice(0, 1000)}
          </pre>
        </div>
      )}

      {/* 图片预览 */}
      {isImage && attachment.content && (
        <div
          className="p-3"
          style={{
            borderTop: '1px solid var(--border-primary)',
            background: 'var(--bg-primary)',
          }}
        >
          <img
            src={`data:${attachment.mediaType};base64,${attachment.content}`}
            alt={attachment.fileName}
            loading="lazy"
            className="max-w-full h-auto rounded"
          />
        </div>
      )}
    </div>
  );
}
