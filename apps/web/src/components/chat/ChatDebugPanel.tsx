'use client';

import React, { memo } from 'react';
import { Settings2, Trash2 } from 'lucide-react';
import { Button } from "@/components/ui/button";

interface CompressionInfo {
  before_tokens: number;
  after_tokens: number;
  saved_tokens: number;
  compression_ratio: number;
}

interface DebugInfo {
  timestamp: string | Date;
  message: string;
  model?: string;
  model_tier?: 'haiku' | 'sonnet' | 'opus';
  task_type?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_messages?: number;
  context_type?: string;
  compression_used?: boolean;
  compression_info?: CompressionInfo;
}

interface ChatDebugPanelProps {
  debugInfo: DebugInfo[];
  onClear: () => void;
}

function formatTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

const ChatDebugPanel = memo(function ChatDebugPanel({
  debugInfo,
  onClear
}: ChatDebugPanelProps) {
  return (
    <div
      className="w-80 fixed right-0 top-16 bottom-0 overflow-y-auto"
      style={{ background: 'var(--bg-secondary)', borderLeft: '1px solid var(--border-primary)' }}
    >
      <div className="p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <Settings2 className="h-4 w-4" />
            开发者调试面板
          </h3>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClear}
            className="h-7 w-7"
            style={{ color: 'var(--text-tertiary)' }}
            title="清空日志"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>

        {debugInfo.length === 0 ? (
          <p className="text-sm text-center py-8" style={{ color: 'var(--text-disabled)' }}>暂无调试信息</p>
        ) : (
          <div className="space-y-3">
            {debugInfo.slice().reverse().map((info, idx) => (
              <div
                key={idx}
                className="rounded-lg p-3 text-xs space-y-2"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}
              >
                <div className="flex items-center justify-between">
                  <span style={{ color: 'var(--text-disabled)' }}>
                    {formatTime(info.timestamp)}
                  </span>
                  <div className="flex items-center gap-1">
                    {info.compression_used && (
                      <span
                        className="text-xs px-1.5 py-0.5 rounded"
                        style={{ background: 'var(--success-bg)', color: 'var(--success)' }}
                      >
                        压缩
                      </span>
                    )}
                    <span
                      className="text-xs px-1.5 py-0.5 rounded"
                      style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}
                    >
                      {info.total_messages}条
                    </span>
                  </div>
                </div>

                <div className="font-medium truncate" style={{ color: 'var(--text-secondary)' }}>
                  {info.message}
                </div>

                <div
                  className="grid grid-cols-2 gap-2 pt-2"
                  style={{ borderTop: '1px solid var(--border-primary)' }}
                >
                  <div>
                    <span style={{ color: 'var(--text-disabled)' }}>模型:</span>
                    <div className="font-medium mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                      {info.model_tier === 'haiku' && '⚡ Haiku'}
                      {info.model_tier === 'sonnet' && '🎯 Sonnet'}
                      {info.model_tier === 'opus' && '💎 Opus'}
                      {!info.model_tier && info.model}
                    </div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-disabled)' }}>任务类型:</span>
                    <div
                      className="font-medium mt-0.5 truncate"
                      style={{ color: 'var(--text-secondary)' }}
                      title={info.task_type}
                    >
                      {info.task_type || 'N/A'}
                    </div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-disabled)' }}>输入Tokens:</span>
                    <div className="font-medium mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                      {info.input_tokens?.toLocaleString() || 'N/A'}
                    </div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-disabled)' }}>输出Tokens:</span>
                    <div className="font-medium mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                      {info.output_tokens?.toLocaleString() || 'N/A'}
                    </div>
                  </div>
                  <div className="col-span-2">
                    <span style={{ color: 'var(--text-disabled)' }}>上下文模式:</span>
                    <div className="font-medium mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                      {info.context_type || '完整历史'}
                    </div>
                  </div>

                  {info.compression_info && (
                    <div
                      className="col-span-2 pt-2"
                      style={{ borderTop: '1px solid var(--border-primary)' }}
                    >
                      <span style={{ color: 'var(--text-disabled)' }}>压缩详情:</span>
                      <div className="mt-1 space-y-0.5" style={{ color: 'var(--success)' }}>
                        <div>压缩前: {info.compression_info.before_tokens.toLocaleString()} tokens</div>
                        <div>压缩后: {info.compression_info.after_tokens.toLocaleString()} tokens</div>
                        <div className="font-semibold">
                          节省: {info.compression_info.saved_tokens.toLocaleString()} tokens
                          ({info.compression_info.compression_ratio}%)
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

export default ChatDebugPanel;
