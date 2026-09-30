/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { CSSProperties } from 'react';
import { formatReportUsd, formatReportUsdShort } from '@/lib/currency';
import { cn } from '@/lib/utils';

/** Approximate bold glyph width in em, used to fit the headline to its column. */
const HEADLINE_GLYPH_EM = 0.62;

/**
 * Stat card amount: a compact headline value, with the exact report amount below it
 * whenever the headline had to be shortened. The headline never wraps; it only shrinks
 * below 1.5rem when its column is too narrow. Place it in a column that fills the card.
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
  const headline = shortened ? `≈ ${short}` : exact;
  const fitWidth = (100 / (headline.length * HEADLINE_GLYPH_EM)).toFixed(2);

  return (
    <>
      <div className="@container">
        <p
          className={cn('font-bold leading-8 whitespace-nowrap', className)}
          style={{ ...style, fontSize: `min(1.5rem, ${fitWidth}cqi)` }}
          title={shortened ? exact : undefined}
          data-testid={testId}
        >
          {headline}
        </p>
      </div>
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
