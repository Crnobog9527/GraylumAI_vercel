'use client';

import React, { useState } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sparkles,
  PenTool,
  Video,
  Megaphone,
  Code,
  BarChart3,
  Lightbulb,
  Briefcase,
  FileText,
  Palette,
  Rocket,
  Target,
  ChevronRight,
  Wand2,
  Zap,
} from 'lucide-react';

interface Module {
  id: string;
  title: string;
  description: string;
  icon?: string;
  color?: string;
  category?: string;
  credits_multiplier?: number;
}

interface PromptModuleGridProps {
  modules: Module[];
  onSelect: (module: Module) => void;
  selectedModule?: Module | null;
}

const iconMap: Record<string, React.ElementType> = {
  Sparkles,
  PenTool,
  Video,
  Megaphone,
  Code,
  BarChart3,
  Lightbulb,
  Briefcase,
  FileText,
  Palette,
  Rocket,
  Target,
  Wand2,
  Zap,
};

const colorConfig: Record<string, { bg: string; border: string; hover: string; icon: string; badge: string }> = {
  violet: { bg: 'bg-violet-500/10', border: 'border-violet-500/30', hover: 'hover:border-violet-500/50 hover:shadow-violet-500/10', icon: 'bg-violet-500/20 text-violet-500', badge: 'bg-violet-500/20 text-violet-400' },
  blue: { bg: 'bg-blue-500/10', border: 'border-blue-500/30', hover: 'hover:border-blue-500/50 hover:shadow-blue-500/10', icon: 'bg-blue-500/20 text-blue-500', badge: 'bg-blue-500/20 text-blue-400' },
  emerald: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', hover: 'hover:border-emerald-500/50 hover:shadow-emerald-500/10', icon: 'bg-emerald-500/20 text-emerald-500', badge: 'bg-emerald-500/20 text-emerald-400' },
  orange: { bg: 'bg-orange-500/10', border: 'border-orange-500/30', hover: 'hover:border-orange-500/50 hover:shadow-orange-500/10', icon: 'bg-orange-500/20 text-orange-500', badge: 'bg-orange-500/20 text-orange-400' },
  pink: { bg: 'bg-pink-500/10', border: 'border-pink-500/30', hover: 'hover:border-pink-500/50 hover:shadow-pink-500/10', icon: 'bg-pink-500/20 text-pink-500', badge: 'bg-pink-500/20 text-pink-400' },
  amber: { bg: 'bg-amber-500/10', border: 'border-amber-500/30', hover: 'hover:border-amber-500/50 hover:shadow-amber-500/10', icon: 'bg-amber-500/20 text-amber-500', badge: 'bg-amber-500/20 text-amber-400' },
  cyan: { bg: 'bg-cyan-500/10', border: 'border-cyan-500/30', hover: 'hover:border-cyan-500/50 hover:shadow-cyan-500/10', icon: 'bg-cyan-500/20 text-cyan-500', badge: 'bg-cyan-500/20 text-cyan-400' },
  rose: { bg: 'bg-rose-500/10', border: 'border-rose-500/30', hover: 'hover:border-rose-500/50 hover:shadow-rose-500/10', icon: 'bg-rose-500/20 text-rose-500', badge: 'bg-rose-500/20 text-rose-400' },
};

const categoryLabels: Record<string, string> = {
  writing: '写作',
  marketing: '营销',
  coding: '编程',
  analysis: '分析',
  creative: '创意',
  business: '商务',
  other: '其他',
  all: '全部',
};

export default function PromptModuleGrid({
  modules,
  onSelect,
  selectedModule,
}: PromptModuleGridProps) {
  const [activeCategory, setActiveCategory] = useState('all');

  const categories = [
    'all',
    ...Array.from(new Set(modules.map((m) => m.category).filter(Boolean))),
  ] as string[];

  const filteredModules =
    activeCategory === 'all'
      ? modules
      : modules.filter((m) => m.category === activeCategory);

  return (
    <div className="space-y-6">
      {/* Category Filter */}
      <div className="flex flex-wrap gap-2 justify-center">
        {categories.map((cat) => (
          <Button
            key={cat}
            variant={activeCategory === cat ? 'default' : 'outline'}
            size="sm"
            onClick={() => setActiveCategory(cat)}
            className={cn(
              'rounded-full transition-colors duration-200',
              activeCategory === cat
                ? 'bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-black'
                : 'border-[var(--border-primary)] hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-10)]'
            )}
          >
            {categoryLabels[cat] || cat}
          </Button>
        ))}
      </div>

      {/* Module Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredModules.map((module) => {
          const IconComponent = iconMap[module.icon || ''] || Sparkles;
          const color = colorConfig[module.color || 'violet'] || colorConfig.violet;
          const isSelected = selectedModule?.id === module.id;

          return (
            <button
              key={module.id}
              onClick={() => onSelect(module)}
              className={cn(
                'group relative rounded-2xl border-2 p-5 text-left transition-[transform,box-shadow,border-color] duration-300',
                'hover:shadow-lg hover:-translate-y-1',
                color.bg,
                color.border,
                color.hover,
                isSelected &&
                  'ring-2 ring-[var(--color-primary)] ring-offset-2 ring-offset-[var(--bg-primary)]'
              )}
            >
              {/* Header */}
              <div className="flex items-start justify-between mb-3">
                <div className={cn('p-3 rounded-xl', color.icon)}>
                  <IconComponent className="h-6 w-6" />
                </div>
                <div className="flex items-center gap-2">
                  {module.credits_multiplier && module.credits_multiplier > 1 && (
                    <Badge className={cn('text-xs', color.badge)}>
                      {module.credits_multiplier}x积分
                    </Badge>
                  )}
                  <ChevronRight
                    className="h-4 w-4 transition-transform group-hover:translate-x-1"
                    style={{ color: 'var(--text-tertiary)' }}
                  />
                </div>
              </div>

              {/* Content */}
              <h3
                className="font-bold text-lg mb-2 group-hover:text-[var(--color-primary)] transition-colors"
                style={{ color: 'var(--text-primary)' }}
              >
                {module.title}
              </h3>
              <p
                className="text-sm line-clamp-2 mb-3"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {module.description}
              </p>

              {/* Footer */}
              <div className="flex items-center justify-between">
                <Badge
                  variant="outline"
                  className="text-xs capitalize"
                  style={{
                    borderColor: 'var(--border-secondary)',
                    color: 'var(--text-tertiary)',
                  }}
                >
                  {categoryLabels[module.category || ''] || module.category}
                </Badge>
                <span
                  className="text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ color: 'var(--color-primary)' }}
                >
                  点击使用 →
                </span>
              </div>

              {/* Glow effect on hover */}
              <div
                className={cn(
                  'absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none',
                  'bg-gradient-to-br from-[var(--color-primary)]/5 to-purple-500/5'
                )}
              />
            </button>
          );
        })}
      </div>

      {filteredModules.length === 0 && (
        <div className="text-center py-12">
          <Wand2
            className="h-12 w-12 mx-auto mb-4"
            style={{ color: 'var(--text-disabled)' }}
          />
          <p style={{ color: 'var(--text-tertiary)' }}>该分类下暂无模块</p>
        </div>
      )}
    </div>
  );
}
