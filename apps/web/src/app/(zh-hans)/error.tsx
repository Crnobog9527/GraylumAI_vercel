'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import { AlertTriangle } from 'lucide-react';
import { StatusScreen } from '@/components/layout/StatusScreen';

export default function RouteError({
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
      code="页面出错"
      title="这个页面暂时无法显示"
      description="可能是网络波动或服务暂时不可用。请稍后重试，或先返回首页。"
      icon={<AlertTriangle className="w-8 h-8" style={{ color: 'var(--color-primary)' }} />}
      onRetry={retry}
      reference={error.digest}
    />
  );
}
