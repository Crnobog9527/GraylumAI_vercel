'use client';

import React from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Pen,
  Video,
  Copy,
  Code,
  BarChart3,
  Lightbulb,
  Briefcase,
  Sparkles,
  ArrowRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface Template {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  color?: string;
  category?: string;
}

interface TemplateCardProps {
  template: Template;
  onClick: () => void;
  compact?: boolean;
}

const iconMap: Record<string, React.ElementType> = {
  Pen,
  Video,
  Copy,
  Code,
  BarChart3,
  Lightbulb,
  Briefcase,
  Sparkles,
};

const colorMap: Record<string, string> = {
  indigo: 'from-indigo-500 to-indigo-600',
  purple: 'from-purple-500 to-purple-600',
  pink: 'from-pink-500 to-pink-600',
  blue: 'from-blue-500 to-blue-600',
  green: 'from-emerald-500 to-emerald-600',
  orange: 'from-orange-500 to-orange-600',
  red: 'from-rose-500 to-rose-600',
  cyan: 'from-cyan-500 to-cyan-600',
};

export default function TemplateCard({
  template,
  onClick,
  compact,
}: TemplateCardProps) {
  const Icon = iconMap[template.icon || ''] || Sparkles;
  const gradient = colorMap[template.color || 'indigo'] || colorMap.indigo;

  if (compact) {
    return (
      <button
        onClick={onClick}
        className={cn(
          'flex items-center gap-3 p-3 rounded-xl border',
          'transition-colors duration-300 hover:shadow-md',
          'text-left w-full group'
        )}
        style={{
          background: 'var(--bg-secondary)',
          borderColor: 'var(--border-primary)',
        }}
      >
        <div
          className={cn(
            'p-2 rounded-lg bg-gradient-to-br text-white shadow-sm',
            gradient
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <p
            className="font-medium text-sm truncate"
            style={{ color: 'var(--text-primary)' }}
          >
            {template.title}
          </p>
        </div>
        <ArrowRight
          className="h-4 w-4 transition-transform group-hover:translate-x-1"
          style={{ color: 'var(--text-tertiary)' }}
        />
      </button>
    );
  }

  return (
    <Card
      onClick={onClick}
      className={cn(
        'relative overflow-hidden cursor-pointer group',
        'transition-[transform,box-shadow] duration-500 hover:-translate-y-1 hover:shadow-xl'
      )}
      style={{
        background: 'var(--bg-secondary)',
        borderColor: 'var(--border-primary)',
      }}
    >
      <div className="p-6">
        <div className="flex items-start justify-between mb-4">
          <div
            className={cn(
              'p-3 rounded-xl bg-gradient-to-br text-white shadow-lg',
              gradient
            )}
          >
            <Icon className="h-5 w-5" />
          </div>
        </div>

        <h3
          className="font-semibold text-lg mb-2 group-hover:text-[var(--color-primary)] transition-colors"
          style={{ color: 'var(--text-primary)' }}
        >
          {template.title}
        </h3>

        <p
          className="text-sm line-clamp-2 mb-4"
          style={{ color: 'var(--text-tertiary)' }}
        >
          {template.description}
        </p>

        <div className="flex items-center justify-between">
          <Badge
            variant="outline"
            className="text-xs capitalize"
            style={{
              borderColor: 'var(--border-secondary)',
              color: 'var(--text-tertiary)',
            }}
          >
            {template.category?.replace('_', ' ')}
          </Badge>
          <div
            className="flex items-center gap-1 text-sm font-medium opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ color: 'var(--color-primary)' }}
          >
            开始 <ArrowRight className="h-4 w-4" />
          </div>
        </div>
      </div>

      <div
        className={cn(
          'absolute inset-0 opacity-0 group-hover:opacity-5 transition-opacity bg-gradient-to-br pointer-events-none',
          gradient
        )}
      />
    </Card>
  );
}
