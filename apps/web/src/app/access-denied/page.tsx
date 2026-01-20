'use client';

import { useRouter } from 'next/navigation';
import { ShieldX, Home, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export default function AccessDeniedPage() {
  const router = useRouter();

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{ background: 'var(--bg-primary)' }}
    >
      {/* Background glow effects */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse at 30% 20%, rgba(255, 0, 0, 0.08) 0%, transparent 50%)',
        }}
      />
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse at 70% 80%, rgba(255, 100, 0, 0.05) 0%, transparent 50%)',
        }}
      />

      <Card
        className="w-full max-w-lg relative z-10"
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
        }}
      >
        <CardContent className="pt-12 pb-10 px-8 text-center">
          {/* Icon */}
          <div
            className="w-20 h-20 mx-auto mb-6 rounded-2xl flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.2) 0%, rgba(220, 38, 38, 0.1) 100%)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
            }}
          >
            <ShieldX
              className="w-10 h-10"
              style={{ color: 'var(--error)' }}
            />
          </div>

          {/* Title */}
          <h1
            className="text-2xl font-bold mb-3"
            style={{ color: 'var(--text-primary)' }}
          >
            访问被拒绝
          </h1>

          {/* Description */}
          <p
            className="text-base mb-2"
            style={{ color: 'var(--text-secondary)' }}
          >
            您没有权限访问此页面
          </p>
          <p
            className="text-sm mb-8"
            style={{ color: 'var(--text-tertiary)' }}
          >
            此功能仅限管理员使用。如果您认为这是一个错误，请联系系统管理员。
          </p>

          {/* Error Code Badge */}
          <div
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full mb-8"
            style={{
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.2)',
            }}
          >
            <span
              className="text-xs font-mono"
              style={{ color: 'var(--error)' }}
            >
              ERROR 403 - FORBIDDEN
            </span>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button
              variant="outline"
              onClick={() => router.back()}
              className="gap-2"
              style={{
                background: 'transparent',
                border: '1px solid var(--border-primary)',
                color: 'var(--text-secondary)',
              }}
            >
              <ArrowLeft className="w-4 h-4" />
              返回上一页
            </Button>
            <Button
              onClick={() => router.push('/')}
              className="gap-2"
              style={{
                background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                color: 'var(--bg-primary)',
                border: 'none',
              }}
            >
              <Home className="w-4 h-4" />
              返回首页
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
