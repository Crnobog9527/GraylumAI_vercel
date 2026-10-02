/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Badge } from '@/components/ui/badge';
import { activeLabel, activeState, type ActiveFlag } from './financeStatus';

const TONE = {
  on: 'bg-emerald-500/20 text-emerald-400',
  off: 'bg-rose-500/20 text-rose-400',
  unknown: 'bg-amber-500/20 text-amber-400',
} as const;

/** Status badge that shows an unrecognized value as-is instead of folding it into "off". */
export function FinanceStatusBadge({ value, on, off }: { value: ActiveFlag; on: string; off: string }) {
  return <Badge className={TONE[activeState(value)]}>{activeLabel(value, { on, off })}</Badge>;
}
