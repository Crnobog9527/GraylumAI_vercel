'use client';

import { RefreshCw } from 'lucide-react';
import { Button } from "@/components/ui/button";
import AdminLoadingState from '@/components/admin/AdminLoadingState';
import AdminErrorState from '@/components/admin/AdminErrorState';
import { useUsersAdmin } from './useUsersAdmin';
import { UsersFilters } from './UsersFilters';
import { UsersTable } from './UsersTable';
import { UserCreditDialog } from './UserCreditDialog';
import { UserDetailSheet } from './UserDetailSheet';

export default function AdminUsersPage() {
  const admin = useUsersAdmin();
  const { isLoading, error, refetch, total, hasActiveFilters, clearAllFilters } = admin;

  // Loading state
  if (isLoading) {
    return <AdminLoadingState />;
  }

  // Error state
  if (error) {
    return <AdminErrorState error={error} onRetry={() => refetch()} />;
  }

  return (
    <div className="space-y-6 p-4 md:p-8">
      {/* Page Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold md:text-3xl" style={{ color: 'var(--text-primary)' }}>
            用户管理
          </h1>
          <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
            管理平台用户、权限和积分 · 共 {total.toLocaleString()} 位用户
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          {hasActiveFilters && (
            <Button
              variant="outline"
              onClick={clearAllFilters}
              className="w-full border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] sm:w-auto"
            >
              清除筛选
            </Button>
          )}
          <Button
            data-testid="admin-users-refresh"
            variant="outline"
            onClick={() => refetch()}
            className="w-full border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] sm:w-auto"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            刷新
          </Button>
        </div>
      </div>

      <UsersFilters admin={admin} />

      <UsersTable admin={admin} />

      <UserCreditDialog admin={admin} />

      <UserDetailSheet admin={admin} />
    </div>
  );
}
