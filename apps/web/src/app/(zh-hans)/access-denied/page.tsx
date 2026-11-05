'use client';

import { useRouter } from 'next/navigation';
import { ShieldX, Home, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AUTH_PRIMARY_BUTTON_CLASS, AUTH_SECONDARY_BUTTON_CLASS, AuthCard, AuthHead, AuthShell } from '@/components/auth/AuthShell';

export default function AccessDeniedPage() {
  const router = useRouter();

  return (
    <AuthShell>
      <AuthCard>
        <AuthHead
          icon={<ShieldX className="h-7 w-7" aria-hidden="true" />}
          title="访问被拒绝"
          lead={<>
            <span className="block text-[var(--pub-ink)]">您没有权限访问此页面</span>
            此功能仅限管理员使用。如果您认为这是一个错误，请联系系统管理员。
          </>}
        />
        <p className="text-center">
          <span
            className="inline-flex rounded-full border border-[var(--gl-error)] bg-[var(--gl-error-bg)] px-4 py-1.5 font-mono text-xs text-[var(--gl-error)]"
          >
            ERROR 403 - FORBIDDEN
          </span>
        </p>
        <div className="flex flex-col justify-center gap-3 sm:flex-row">
          <Button variant="outline" onClick={() => router.back()} className={AUTH_SECONDARY_BUTTON_CLASS}>
            <ArrowLeft className="h-4 w-4" />
            返回上一页
          </Button>
          <Button onClick={() => router.push('/app')} className={`${AUTH_PRIMARY_BUTTON_CLASS} sm:w-auto`}>
            <Home className="h-4 w-4" />
            返回首页
          </Button>
        </div>
      </AuthCard>
    </AuthShell>
  );
}
