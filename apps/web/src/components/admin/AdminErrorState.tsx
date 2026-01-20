'use client';

import { AlertCircle, ShieldX } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import AdminSidebar from './AdminSidebar';

interface AdminErrorStateProps {
  error: Error | { message: string };
  onRetry?: () => void;
}

export default function AdminErrorState({ error, onRetry }: AdminErrorStateProps) {
  const isPermissionError = error.message.includes('Admin role required');

  return (
    <div className="flex min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <AdminSidebar />
      <div className="flex-1 p-8">
        <Card
          className="max-w-md mx-auto mt-20"
          style={{
            background: isPermissionError ? 'var(--warning-bg)' : 'var(--error-bg)',
            border: `1px solid ${isPermissionError ? 'var(--warning)' : 'var(--error)'}`,
          }}
        >
          <CardContent className="pt-6">
            <div className="flex items-start gap-4">
              {isPermissionError ? (
                <ShieldX className="h-6 w-6 flex-shrink-0" style={{ color: 'var(--warning)' }} />
              ) : (
                <AlertCircle className="h-6 w-6 flex-shrink-0" style={{ color: 'var(--error)' }} />
              )}
              <div className="flex-1">
                <h3
                  className="font-semibold mb-2"
                  style={{ color: isPermissionError ? 'var(--warning)' : 'var(--error)' }}
                >
                  {isPermissionError ? '访问被拒绝' : '加载错误'}
                </h3>
                <p
                  className="text-sm"
                  style={{ color: isPermissionError ? 'var(--warning)' : 'var(--error)' }}
                >
                  {isPermissionError
                    ? '您需要管理员权限才能查看此页面。'
                    : error.message}
                </p>
                {onRetry && !isPermissionError && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-4"
                    onClick={onRetry}
                  >
                    重试
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
