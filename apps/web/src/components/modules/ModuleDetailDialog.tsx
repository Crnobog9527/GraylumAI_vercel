'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { iconMap, getIconColor } from './iconConfig';
import {
  Bot,
  Sparkles,
  Users,
  Clock,
  Tag,
  ExternalLink,
  MessageSquare,
  Zap,
} from 'lucide-react';
import { trpc } from '@/trpc/client';

interface Module {
  id: string;
  title: string;
  description: string;
  icon?: string;
  category?: string;
  platform?: string;
  usage_count?: number;
  credits_multiplier?: number;
  full_description?: string;
  features?: string[];
  examples?: string[];
}

interface ModuleDetailDialogProps {
  module: Module | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUse?: (module: Module) => void;
}

const categoryLabels: Record<string, string> = {
  writing: '内容创作',
  marketing: '营销文案',
  video: '视频制作',
  business: '商务办公',
  education: '教育学习',
  coding: '编程开发',
  analysis: '数据分析',
  creative: '创意设计',
  other: '其他',
};

export default function ModuleDetailDialog({
  module,
  open,
  onOpenChange,
  onUse,
}: ModuleDetailDialogProps) {
  const router = useRouter();
  const incrementUsage = trpc.modules.incrementUsage.useMutation();

  if (!module) return null;

  const Icon = module.icon ? iconMap[module.icon] || Bot : Bot;
  const iconColor = module.icon ? getIconColor(module.icon) : '#FFD700';

  const handleUse = () => {
    // Increment usage count
    incrementUsage.mutate({ moduleId: module.id });

    // Call custom onUse handler if provided
    if (onUse) {
      onUse(module);
    }

    // Navigate to chat with module context
    router.push(`/chat?module=${module.id}`);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl max-h-[85vh] overflow-y-auto"
        style={{
          background: 'linear-gradient(135deg, rgba(30,30,35,0.98) 0%, rgba(20,20,25,0.99) 100%)',
          border: '1px solid rgba(255,215,0,0.15)',
          boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5), 0 0 100px rgba(255,215,0,0.1)',
        }}
      >
        <DialogHeader>
          <div className="flex items-start gap-4">
            {/* Icon */}
            <div
              className="p-4 rounded-2xl shrink-0"
              style={{
                background: `linear-gradient(135deg, ${iconColor}20 0%, ${iconColor}10 100%)`,
                border: `1px solid ${iconColor}40`,
                boxShadow: `0 8px 24px ${iconColor}20`,
              }}
            >
              <Icon className="h-8 w-8" style={{ color: iconColor }} />
            </div>

            {/* Title & Meta */}
            <div className="flex-1 min-w-0">
              <DialogTitle
                className="text-xl font-bold mb-2"
                style={{ color: 'var(--text-primary)' }}
              >
                {module.title}
              </DialogTitle>
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  className="text-xs"
                  style={{
                    background: 'rgba(255,215,0,0.1)',
                    color: 'var(--color-primary)',
                    border: '1px solid rgba(255,215,0,0.2)',
                  }}
                >
                  <Tag className="h-3 w-3 mr-1" />
                  {categoryLabels[module.category || ''] || module.category || '其他'}
                </Badge>
                {module.platform && (
                  <Badge
                    variant="outline"
                    className="text-xs"
                    style={{
                      borderColor: 'var(--border-secondary)',
                      color: 'var(--text-tertiary)',
                    }}
                  >
                    {module.platform}
                  </Badge>
                )}
                {module.credits_multiplier && module.credits_multiplier > 1 && (
                  <Badge
                    className="text-xs"
                    style={{
                      background: 'rgba(139,92,246,0.15)',
                      color: '#a78bfa',
                      border: '1px solid rgba(139,92,246,0.3)',
                    }}
                  >
                    <Zap className="h-3 w-3 mr-1" />
                    {module.credits_multiplier}x 积分
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </DialogHeader>

        {/* Content */}
        <div className="mt-6 space-y-6">
          {/* Stats Row */}
          <div
            className="flex items-center gap-6 p-4 rounded-xl"
            style={{
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid rgba(255,255,255,0.05)',
            }}
          >
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4" style={{ color: 'var(--text-tertiary)' }} />
              <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                <span className="font-semibold" style={{ color: 'var(--color-primary)' }}>
                  {(module.usage_count || 0).toLocaleString()}
                </span>{' '}
                次使用
              </span>
            </div>
            <div className="h-4 w-px" style={{ background: 'var(--border-primary)' }} />
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4" style={{ color: 'var(--text-tertiary)' }} />
              <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                平均响应时间 <span className="font-semibold">~3s</span>
              </span>
            </div>
            <div className="h-4 w-px" style={{ background: 'var(--border-primary)' }} />
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" style={{ color: 'var(--text-tertiary)' }} />
              <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                AI 驱动
              </span>
            </div>
          </div>

          {/* Description */}
          <div>
            <h4
              className="text-sm font-semibold mb-3 flex items-center gap-2"
              style={{ color: 'var(--text-primary)' }}
            >
              <MessageSquare className="h-4 w-4" style={{ color: 'var(--color-primary)' }} />
              功能介绍
            </h4>
            <p
              className="text-sm leading-relaxed"
              style={{ color: 'var(--text-secondary)' }}
            >
              {module.full_description || module.description}
            </p>
          </div>

          {/* Features */}
          {module.features && module.features.length > 0 && (
            <div>
              <h4
                className="text-sm font-semibold mb-3 flex items-center gap-2"
                style={{ color: 'var(--text-primary)' }}
              >
                <Sparkles className="h-4 w-4" style={{ color: 'var(--color-primary)' }} />
                功能特点
              </h4>
              <ul className="space-y-2">
                {module.features.map((feature, index) => (
                  <li
                    key={index}
                    className="flex items-start gap-3 text-sm"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    <span
                      className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ background: 'var(--color-primary)' }}
                    />
                    {feature}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Examples */}
          {module.examples && module.examples.length > 0 && (
            <div>
              <h4
                className="text-sm font-semibold mb-3 flex items-center gap-2"
                style={{ color: 'var(--text-primary)' }}
              >
                <ExternalLink className="h-4 w-4" style={{ color: 'var(--color-primary)' }} />
                使用示例
              </h4>
              <div className="space-y-2">
                {module.examples.map((example, index) => (
                  <div
                    key={index}
                    className="p-3 rounded-lg text-sm"
                    style={{
                      background: 'rgba(255,255,255,0.02)',
                      border: '1px solid rgba(255,255,255,0.05)',
                      color: 'var(--text-tertiary)',
                    }}
                  >
                    &ldquo;{example}&rdquo;
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Default features if none provided */}
          {(!module.features || module.features.length === 0) && (
            <div>
              <h4
                className="text-sm font-semibold mb-3 flex items-center gap-2"
                style={{ color: 'var(--text-primary)' }}
              >
                <Sparkles className="h-4 w-4" style={{ color: 'var(--color-primary)' }} />
                功能特点
              </h4>
              <ul className="space-y-2">
                <li
                  className="flex items-start gap-3 text-sm"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <span
                    className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: 'var(--color-primary)' }}
                  />
                  专业的 AI 模型支持，快速响应
                </li>
                <li
                  className="flex items-start gap-3 text-sm"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <span
                    className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: 'var(--color-primary)' }}
                  />
                  支持多种输出格式，满足不同需求
                </li>
                <li
                  className="flex items-start gap-3 text-sm"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <span
                    className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: 'var(--color-primary)' }}
                  />
                  持续优化的提示词模板，效果更佳
                </li>
              </ul>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-3 mt-8 pt-6" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="flex-1 h-11 rounded-xl font-medium"
            style={{
              background: 'rgba(255,255,255,0.03)',
              borderColor: 'rgba(255,255,255,0.1)',
              color: 'var(--text-secondary)',
            }}
          >
            关闭
          </Button>
          <Button
            onClick={handleUse}
            className="flex-1 h-11 rounded-xl font-semibold transition-all duration-300 hover:scale-[1.02]"
            style={{
              background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
              color: 'var(--bg-primary)',
              boxShadow: '0 4px 20px rgba(255, 215, 0, 0.3), inset 0 1px 0 rgba(255,255,255,0.2)',
            }}
          >
            <Sparkles className="h-4 w-4 mr-2" />
            立即使用
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
