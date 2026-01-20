'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { trpc } from '@/trpc/client';
import AdminSidebar from './AdminSidebar';

interface AdminGuardProps {
  children: React.ReactNode;
}

/**
 * AdminGuard - Protects admin pages with role verification
 *
 * This component:
 * 1. Checks if the user has admin role via tRPC
 * 2. Redirects to /access-denied if not an admin
 * 3. Shows loading state while checking
 * 4. Renders children with AdminSidebar if authorized
 */
export default function AdminGuard({ children }: AdminGuardProps) {
  const router = useRouter();

  // Use a simple admin check query
  const { data: stats, isLoading, error } = trpc.admin.getStatistics.useQuery(undefined, {
    retry: false, // Don't retry on FORBIDDEN errors
  });

  useEffect(() => {
    // Redirect to access-denied page on FORBIDDEN error
    if (error?.data?.code === 'FORBIDDEN' ||
        error?.message?.includes('Admin role required') ||
        error?.message?.includes('permission')) {
      router.replace('/access-denied');
    }
  }, [error, router]);

  // Loading state
  if (isLoading) {
    return (
      <div className="flex min-h-screen" style={{ background: 'var(--bg-primary)' }}>
        <AdminSidebar />
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-[var(--color-primary)]"></div>
            <p style={{ color: 'var(--text-tertiary)' }}>验证管理员权限...</p>
          </div>
        </div>
      </div>
    );
  }

  // Error state (non-permission errors)
  if (error && !error.message?.includes('Admin role required') && !error.message?.includes('permission')) {
    return (
      <div className="flex min-h-screen" style={{ background: 'var(--bg-primary)' }}>
        <AdminSidebar />
        <div className="flex-1 flex items-center justify-center">
          <div
            className="max-w-md p-6 rounded-xl text-center"
            style={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-primary)',
            }}
          >
            <p style={{ color: 'var(--error)' }}>
              加载失败: {error.message}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Authorized - render children
  return (
    <div className="flex min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <AdminSidebar />
      <div className="flex-1 overflow-auto">
        {children}
      </div>
    </div>
  );
}
