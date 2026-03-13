'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
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
} from 'lucide-react';

interface Module {
  id: string;
  title: string;
  description: string;
  icon?: string;
  color?: string;
  credits_multiplier?: number;
}

interface PromptModuleCardProps {
  module: Module;
  onClick: () => void;
  isSelected?: boolean;
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
};

const colorClasses: Record<string, { card: string; icon: string }> = {
  violet: {
    card: 'bg-violet-500/10 border-violet-500/30 hover:border-violet-500/50 hover:bg-violet-500/15',
    icon: 'text-violet-500 bg-violet-500/20',
  },
  blue: {
    card: 'bg-blue-500/10 border-blue-500/30 hover:border-blue-500/50 hover:bg-blue-500/15',
    icon: 'text-blue-500 bg-blue-500/20',
  },
  emerald: {
    card: 'bg-emerald-500/10 border-emerald-500/30 hover:border-emerald-500/50 hover:bg-emerald-500/15',
    icon: 'text-emerald-500 bg-emerald-500/20',
  },
  orange: {
    card: 'bg-orange-500/10 border-orange-500/30 hover:border-orange-500/50 hover:bg-orange-500/15',
    icon: 'text-orange-500 bg-orange-500/20',
  },
  pink: {
    card: 'bg-pink-500/10 border-pink-500/30 hover:border-pink-500/50 hover:bg-pink-500/15',
    icon: 'text-pink-500 bg-pink-500/20',
  },
  amber: {
    card: 'bg-amber-500/10 border-amber-500/30 hover:border-amber-500/50 hover:bg-amber-500/15',
    icon: 'text-amber-500 bg-amber-500/20',
  },
  cyan: {
    card: 'bg-cyan-500/10 border-cyan-500/30 hover:border-cyan-500/50 hover:bg-cyan-500/15',
    icon: 'text-cyan-500 bg-cyan-500/20',
  },
  rose: {
    card: 'bg-rose-500/10 border-rose-500/30 hover:border-rose-500/50 hover:bg-rose-500/15',
    icon: 'text-rose-500 bg-rose-500/20',
  },
};

export default function PromptModuleCard({
  module,
  onClick,
  isSelected,
}: PromptModuleCardProps) {
  const IconComponent = iconMap[module.icon || ''] || Sparkles;
  const color = module.color || 'violet';
  const classes = colorClasses[color] || colorClasses.violet;

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full p-4 rounded-xl border-2 text-left transition-[background-color,border-color,box-shadow,transform] duration-200 motion-reduce:transition-none',
        classes.card,
        isSelected && 'ring-2 ring-offset-2 ring-[var(--color-primary)] ring-offset-[var(--bg-primary)]'
      )}
    >
      <div className="flex items-start gap-3">
        <div className={cn('p-2.5 rounded-lg shrink-0', classes.icon)}>
          <IconComponent className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3
              className="font-semibold truncate"
              style={{ color: 'var(--text-primary)' }}
            >
              {module.title}
            </h3>
            {module.credits_multiplier && module.credits_multiplier > 1 && (
              <Badge
                variant="secondary"
                className="text-xs shrink-0"
                style={{
                  background: 'var(--color-primary-10)',
                  color: 'var(--color-primary)',
                }}
              >
                {module.credits_multiplier}x
              </Badge>
            )}
          </div>
          <p
            className="text-sm mt-1 line-clamp-2"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {module.description}
          </p>
        </div>
      </div>
    </button>
  );
}
