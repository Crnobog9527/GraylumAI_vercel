/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { Loader2, RefreshCw } from 'lucide-react';
import { summaryStat } from './summaryStat';

export { CREDITS_SUMMARY_QUERY_OPTIONS } from './creditsSummaryQuery';

interface RetryableQuery<T> {
  data?: T | null;
  isError?: boolean;
  isFetching?: boolean;
  refetch: () => unknown;
}

/** Shown after automatic retries have given up; reading again is the user's choice. */
export function SummaryRetryButton({ query }: { query: RetryableQuery<unknown> }) {
  if (!query.isError) return null;
  return (
    <button
      type="button"
      onClick={() => void query.refetch()}
      disabled={query.isFetching}
      className="mt-1 inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline disabled:opacity-60"
      style={{ color: 'var(--color-primary)' }}
    >
      {query.isFetching ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
      {query.isFetching ? '正在重试' : '重试'}
    </button>
  );
}

/** A summary number: "…" while reading, "读取失败" plus a retry button when it failed. */
export function SummaryStatValue<T>({ query, pick }: { query: RetryableQuery<T>; pick: (data: T) => number | null | undefined }) {
  return (
    <>
      <div className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{summaryStat(query, pick)}</div>
      <SummaryRetryButton query={query} />
    </>
  );
}
