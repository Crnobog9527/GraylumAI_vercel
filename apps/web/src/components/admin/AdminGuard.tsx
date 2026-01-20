'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { trpc } from '@/trpc/client';
import { ShieldCheck } from 'lucide-react';
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
 * 3. Shows NEUTRAL loading state while checking (no admin UI exposed)
 * 4. Renders children with AdminSidebar ONLY if authorized
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

  // Loading state - IMPORTANT: Do NOT show any admin interface elements here
  // This prevents unauthorized users from seeing the admin layout structure
  if (isLoading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: 'var(--bg-primary)' }}
      >
        <div className="flex flex-col items-center gap-6">
          {/* Neutral shield icon - not revealing admin interface */}
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg, var(--color-primary-20) 0%, var(--color-primary-10) 100%)',
              border: '1px solid var(--color-primary-30)',
            }}
          >
            <ShieldCheck
              className="w-8 h-8 animate-pulse"
              style={{ color: 'var(--color-primary)' }}
            />
          </div>
          {/* Loading spinner */}
          <div className="flex flex-col items-center gap-3">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--color-primary)]"></div>
            <p style={{ color: 'var(--text-tertiary)' }}>验证访问权限...</p>
          </div>
        </div>
      </div>
    );
  }

  // Error state - for permission errors, useEffect will redirect
  // For other errors, show error message without admin interface
  if (error) {
    // Permission errors are handled by useEffect redirect
    if (error.message?.includes('Admin role required') || error.message?.includes('permission')) {
      // Show minimal loading while redirecting
      return (
        <div
          className="min-h-screen flex items-center justify-center"
          style={{ background: 'var(--bg-primary)' }}
        >
          <div className="flex flex-col items-center gap-4">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--color-primary)]"></div>
            <p style={{ color: 'var(--text-tertiary)' }}>正在跳转...</p>
          </div>
        </div>
      );
    }

    // Other errors - show error without admin UI
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: 'var(--bg-primary)' }}
      >
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
    );
  }

  // ONLY show admin interface after successful verification
  return (
    <div className="flex min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <AdminSidebar />
      <div className="flex-1 overflow-auto">
        {children}
      </div>
    </div>
  );
}
