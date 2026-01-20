'use client';

import { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface AdminPageHeaderProps {
  title: string;
  subtitle?: string;
  children?: ReactNode;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

export default function AdminPageHeader({
  title,
  subtitle,
  children,
  onRefresh,
  isRefreshing,
}: AdminPageHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-8">
      <div>
        <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
            {subtitle}
          </p>
        )}
      </div>
      <div className="flex items-center gap-3">
        {onRefresh && (
          <Button
            variant="outline"
            onClick={onRefresh}
            disabled={isRefreshing}
            style={{
              background: 'var(--bg-tertiary)',
              borderColor: 'var(--border-primary)',
              color: 'var(--text-secondary)',
            }}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
            刷新
          </Button>
        )}
        {children}
      </div>
    </div>
  );
}
