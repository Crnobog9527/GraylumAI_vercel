/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { Button } from '@/components/ui/button';

export const emptyStateCardStyle = {
  borderColor: 'rgba(255,255,255,0.08)',
  background: 'var(--bg-primary)',
} as const;

export function ProfileCatalogState({
  status,
  onRetry,
  retrying = false,
}: {
  status: 'empty' | 'unavailable';
  onRetry?: () => void;
  retrying?: boolean;
}) {
  if (status === 'empty') {
    return (
      <div
        data-testid="profile-catalog-empty"
        className="col-span-4 rounded-xl border px-4 py-6 text-center text-sm"
        style={emptyStateCardStyle}
      >
        <div className="font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
          当前暂无可用套餐
        </div>
        <div style={{ color: 'var(--text-tertiary)' }}>
          新套餐开放后，这里会自动显示最新价格与权益。
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="profile-catalog-unavailable"
      className="col-span-4 rounded-xl border px-4 py-6 text-center text-sm"
      style={emptyStateCardStyle}
    >
      <div className="font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
        套餐服务暂不可用
      </div>
      <div style={{ color: 'var(--text-tertiary)' }}>
        当前无法安全读取最新套餐与价格，请稍后重试。
      </div>
      {onRetry && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-4"
          disabled={retrying}
          onClick={onRetry}
        >
          {retrying ? '重试中...' : '重试'}
        </Button>
      )}
    </div>
  );
}
