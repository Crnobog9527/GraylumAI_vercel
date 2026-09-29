'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import { AlertTriangle } from 'lucide-react';
import { StatusScreen } from '@/components/layout/StatusScreen';
import './globals.css';

// 根布局本身出错时替换整个文档，所以要自带 <html>、<body> 和全局样式。
export default function GlobalError({
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
    <html lang="zh-CN">
      <body className="antialiased" style={{ background: 'var(--bg-primary)' }}>
        <title>页面出错</title>
        <StatusScreen
          code="页面出错"
          title="网站暂时无法显示"
          description="可能是网络波动或服务暂时不可用。请稍后重试，或先返回首页。"
          icon={<AlertTriangle className="w-8 h-8" style={{ color: 'var(--color-primary)' }} />}
          onRetry={retry}
          reference={error.digest}
        />
      </body>
    </html>
  );
}
