/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { BadgeCheck } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { showsBadge, type FounderState } from './founderMemberView';

/** The badge is rendered from the server's state only; nothing is stored on the client. */
export function FounderBadgeView({ state }: { state: FounderState | undefined }) {
  if (!showsBadge(state)) return null;
  return <span
    className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold"
    style={{ background: 'rgba(255, 215, 0, 0.12)', color: 'var(--color-primary)', border: '1px solid rgba(255, 215, 0, 0.3)' }}
    data-testid="founder-badge"
  ><BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" />创始会员</span>;
}

/** Quiet on failure: a badge that cannot be read is simply not shown. */
export function FounderBadge() {
  const query = trpc.founder.me.useQuery(undefined, { retry: false, staleTime: 60_000, refetchOnWindowFocus: false });
  return <FounderBadgeView state={query.data?.founder.state} />;
}
