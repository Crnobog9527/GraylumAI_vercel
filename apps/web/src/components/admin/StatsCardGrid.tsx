'use client';

import { ReactNode } from 'react';
import { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

interface StatItem {
  label: string;
  value: string | number;
  icon: LucideIcon;
  color: string; // Tailwind color class like 'amber' or 'emerald'
  change?: {
    value: string;
    positive: boolean;
  };
}

interface StatsCardGridProps {
  stats: StatItem[];
  columns?: 2 | 3 | 4;
}

const colorMap: Record<string, string> = {
  amber: 'bg-amber-500/20',
  emerald: 'bg-emerald-500/20',
  blue: 'bg-blue-500/20',
  purple: 'bg-purple-500/20',
  rose: 'bg-rose-500/20',
  cyan: 'bg-cyan-500/20',
  orange: 'bg-orange-500/20',
  indigo: 'bg-indigo-500/20',
};

const iconColorMap: Record<string, string> = {
  amber: 'text-amber-400',
  emerald: 'text-emerald-400',
  blue: 'text-blue-400',
  purple: 'text-purple-400',
  rose: 'text-rose-400',
  cyan: 'text-cyan-400',
  orange: 'text-orange-400',
  indigo: 'text-indigo-400',
};

export default function StatsCardGrid({ stats, columns = 4 }: StatsCardGridProps) {
  const gridCols = {
    2: 'md:grid-cols-2',
    3: 'md:grid-cols-3',
    4: 'md:grid-cols-4',
  };

  return (
    <div className={`grid grid-cols-1 ${gridCols[columns]} gap-4 mb-8`}>
      {stats.map((stat, index) => {
        const Icon = stat.icon;
        const bgColor = colorMap[stat.color] ?? 'bg-slate-500/20';
        const iconColor = iconColorMap[stat.color] ?? 'text-slate-400';

        return (
          <Card
            key={index}
            style={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-primary)',
            }}
          >
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className={`p-3 rounded-xl ${bgColor}`}>
                  <Icon className={`h-6 w-6 ${iconColor}`} />
                </div>
                <div className="flex-1">
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                    {stat.label}
                  </p>
                  <div className="flex items-baseline gap-2">
                    <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                      {stat.value}
                    </p>
                    {stat.change && (
                      <span
                        className={`text-xs ${
                          stat.change.positive ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {stat.change.positive ? '↑' : '↓'} {stat.change.value}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// 简化版：单个统计卡片
interface SingleStatCardProps {
  label: string;
  value: string | number;
  icon: LucideIcon;
  color: string;
  subtitle?: string;
}

export function StatCard({ label, value, icon: Icon, color, subtitle }: SingleStatCardProps) {
  const bgColor = colorMap[color] ?? 'bg-slate-500/20';
  const iconColor = iconColorMap[color] ?? 'text-slate-400';

  return (
    <Card
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
      }}
    >
      <CardContent className="p-6">
        <div className="flex items-center gap-4">
          <div className={`p-3 rounded-xl ${bgColor}`}>
            <Icon className={`h-6 w-6 ${iconColor}`} />
          </div>
          <div>
            <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
              {label}
            </p>
            <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
              {value}
            </p>
            {subtitle && (
              <p className="text-xs" style={{ color: 'var(--text-disabled)' }}>
                {subtitle}
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
