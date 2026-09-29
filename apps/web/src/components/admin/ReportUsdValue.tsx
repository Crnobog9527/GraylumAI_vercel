/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { CSSProperties } from 'react';
import { formatReportUsd, formatReportUsdShort } from '@/lib/currency';
import { cn } from '@/lib/utils';

/**
 * Stat card amount: a compact headline value, with the exact report amount below it
 * whenever the headline had to be shortened.
 */
export function ReportUsdValue({
  amount,
  className,
  style,
  testId,
}: {
  amount: number;
  className?: string;
  style?: CSSProperties;
  testId?: string;
}) {
  const exact = formatReportUsd(amount);
  const short = formatReportUsdShort(amount);
  const shortened = short !== exact;

  return (
    <>
      <p
        className={cn('text-2xl font-bold [overflow-wrap:anywhere]', className)}
        style={style}
        title={shortened ? exact : undefined}
        data-testid={testId}
      >
        {shortened ? `≈ ${short}` : exact}
      </p>
      {shortened && (
        <p
          className="text-xs tabular-nums [overflow-wrap:anywhere]"
          style={{ color: 'var(--text-tertiary)' }}
          data-testid={testId ? `${testId}-exact` : undefined}
        >
          {exact}
        </p>
      )}
    </>
  );
}
