/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { ElementType } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { ReportUsdValue } from '@/components/admin/ReportUsdValue';

const toneClasses = {
  up: { bg: 'bg-emerald-500/20', icon: 'text-emerald-400' },
  down: { bg: 'bg-red-500/20', icon: 'text-red-400' },
  neutral: { bg: 'bg-[var(--color-primary-20)]', icon: 'text-[var(--color-primary)]' },
};

export function CostStatCard({
  title,
  value,
  usdAmount,
  subValue,
  icon: Icon,
  trend = 'neutral',
}: {
  title: string;
  value: string;
  /** When set, the card shows this report USD amount (compact headline plus exact amount) instead of `value`. */
  usdAmount?: number;
  subValue?: string;
  icon: ElementType;
  trend?: 'up' | 'down' | 'neutral';
}) {
  const tone = toneClasses[trend];

  return (
    <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
      <CardContent className="p-6">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{title}</p>
            {usdAmount === undefined ? (
              <p className="text-2xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>{value}</p>
            ) : (
              <ReportUsdValue amount={usdAmount} className="mt-1" style={{ color: 'var(--text-primary)' }} />
            )}
            {subValue && (
              <p className="text-xs mt-1 [overflow-wrap:anywhere]" style={{ color: 'var(--text-disabled)' }}>
                {subValue}
              </p>
            )}
          </div>
          <div className={`shrink-0 p-3 rounded-xl ${tone.bg}`}>
            <Icon className={`h-6 w-6 ${tone.icon}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
