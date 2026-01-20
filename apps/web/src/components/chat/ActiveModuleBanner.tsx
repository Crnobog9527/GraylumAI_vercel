'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { X, Lock, Sparkles } from 'lucide-react';

interface Module {
  id: string;
  title: string;
}

interface ActiveModuleBannerProps {
  module: Module | null;
  onClear: () => void;
}

export default function ActiveModuleBanner({
  module,
  onClear,
}: ActiveModuleBannerProps) {
  if (!module) return null;

  return (
    <div
      className={cn(
        'mx-4 lg:mx-6 mb-4 p-4 rounded-xl border-2',
        'bg-gradient-to-r from-[var(--color-primary)]/10 to-purple-500/10',
        'border-[var(--color-primary)]/30',
        'animate-in slide-in-from-top-2 duration-300'
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className="p-2 rounded-lg"
            style={{ background: 'var(--color-primary-20)' }}
          >
            <Lock className="h-4 w-4" style={{ color: 'var(--color-primary)' }} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span
                className="font-semibold"
                style={{ color: 'var(--text-primary)' }}
              >
                {module.title}
              </span>
              <Badge
                className="text-xs border-0"
                style={{
                  background: 'var(--color-primary-20)',
                  color: 'var(--color-primary)',
                }}
              >
                <Sparkles className="h-3 w-3 mr-1" />
                专用模式
              </Badge>
            </div>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
              对话将严格遵循此模块的提示词约束，确保专业输出
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          className="hover:bg-[var(--color-primary-10)]"
          style={{ color: 'var(--color-primary)' }}
        >
          <X className="h-4 w-4 mr-1" />
          退出模式
        </Button>
      </div>
    </div>
  );
}
