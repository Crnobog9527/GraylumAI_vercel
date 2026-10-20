'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import { AlertTriangle } from 'lucide-react';
import { StatusScreen, TAIWAN_LABELS } from '@/components/layout/StatusScreen';

// /zh-tw has its own root layout, so the Simplified group's error boundary does not cover it; an error here keeps
// this section's document (lang="zh-Hant-TW") and Traditional wording instead of reaching global-error.
export default function TaiwanRouteError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <StatusScreen
      code="頁面出錯"
      title="這個頁面暫時無法顯示"
      description="可能是網路不穩或服務暫時無法使用。請稍後重試，或先返回首頁。"
      icon={<AlertTriangle className="w-8 h-8" style={{ color: 'var(--color-primary)' }} />}
      onRetry={retry}
      reference={error.digest}
      labels={TAIWAN_LABELS}
    />
  );
}
