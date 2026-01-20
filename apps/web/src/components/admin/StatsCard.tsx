'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import { TrendingUp, TrendingDown } from 'lucide-react';

type ColorVariant = 'primary' | 'blue' | 'emerald' | 'amber' | 'rose' | 'violet';

interface StatsCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ElementType;
  trend?: 'up' | 'down';
  trendValue?: string;
  color?: ColorVariant;
}

const colorClasses: Record<ColorVariant, { bg: string; text: string }> = {
  primary: { bg: 'bg-[var(--color-primary-20)]', text: 'text-[var(--color-primary)]' },
  violet: { bg: 'bg-violet-500/20', text: 'text-violet-400' },
  blue: { bg: 'bg-blue-500/20', text: 'text-blue-400' },
  emerald: { bg: 'bg-emerald-500/20', text: 'text-emerald-400' },
  amber: { bg: 'bg-amber-500/20', text: 'text-amber-400' },
  rose: { bg: 'bg-rose-500/20', text: 'text-rose-400' },
};

export default function StatsCard({
  title,
  value,
  subtitle,
  icon: Icon,
  trend,
  trendValue,
  color = 'primary'
}: StatsCardProps) {
  const colors = colorClasses[color];

  return (
    <div
      className="rounded-2xl p-6 transition-all duration-300 hover:shadow-lg hover:shadow-black/20"
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)'
      }}
    >
      <div className="flex items-start justify-between mb-4">
        <div className={cn("p-3 rounded-xl", colors.bg)}>
          <Icon className={cn("h-6 w-6", colors.text)} />
        </div>
        {trend && (
          <div className={cn(
            "flex items-center gap-1 text-sm font-medium px-2 py-1 rounded-full",
            trend === 'up'
              ? "bg-emerald-500/20 text-emerald-400"
              : "bg-rose-500/20 text-rose-400"
          )}>
            {trend === 'up' ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
            {trendValue}
          </div>
        )}
      </div>
      <div>
        <p className="text-sm mb-1" style={{ color: 'var(--text-tertiary)' }}>{title}</p>
        <p className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>{value}</p>
        {subtitle && (
          <p className="text-sm mt-1" style={{ color: 'var(--text-disabled)' }}>{subtitle}</p>
        )}
      </div>
    </div>
  );
}
