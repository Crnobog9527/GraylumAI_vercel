/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { toast } from '@/components/ui/sonner';
import { getSafeErrorMessage } from '@/lib/safe-error-message';
import { User, type UserStatus, type MembershipLevel, type UserRole } from './usersShared';

// 用户管理后台页的全部状态、查询、请求和操作。从 page.tsx 原样搬出：页面只负责加载/出错状态和摆放各块界面。
export function useUsersAdmin() {
  // Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<UserStatus | 'all'>('all');
  const [membershipFilter, setMembershipFilter] = useState<MembershipLevel | 'all'>('all');
  const [roleFilter, setRoleFilter] = useState<UserRole | 'all'>('all');

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // Dialog state
  const [creditDialogOpen, setCreditDialogOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [creditAdjustment, setCreditAdjustment] = useState({ amount: 0, reason: '' });

  // Detail sheet state
  const [detailSheetOpen, setDetailSheetOpen] = useState(false);
  const [detailUserId, setDetailUserId] = useState<string | null>(null);

  // Queries
  const { data, isLoading, error, refetch } = trpc.admin.getAllUsers.useQuery({
    limit: pageSize,
    offset: (currentPage - 1) * pageSize,
    search: searchQuery || undefined,
    status: statusFilter === 'all' ? undefined : statusFilter,
    membershipLevel: membershipFilter === 'all' ? undefined : membershipFilter,
    role: roleFilter === 'all' ? undefined : roleFilter,
  });

  const { data: userDetails, isLoading: isLoadingDetails } = trpc.admin.getUserDetails.useQuery(
    { userId: detailUserId! },
    { enabled: !!detailUserId && detailSheetOpen }
  );

  const users = data?.users ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / pageSize);

  // Mutations
  const utils = trpc.useUtils();

  // 主操作成功后刷新；操作日志没写上时单独提示，不重做主操作。
  const onUserChanged = (result: { auditRecorded?: boolean }) => {
    if (result.auditRecorded === false) toast.warning('操作已生效，但操作日志未记录');
    // 返回 Promise，等列表和详情真正刷新完再结束
    return Promise.all([utils.admin.getAllUsers.invalidate(), utils.admin.getUserDetails.invalidate()]);
  };

  const updateCredits = trpc.admin.adjustUserCredits.useMutation({
    onSuccess: async (result) => {
      await onUserChanged(result);
      setCreditDialogOpen(false);
      setCreditAdjustment({ amount: 0, reason: '' });
      setSelectedUser(null);
    }
  });

  const updateStatus = trpc.admin.updateUserStatus.useMutation({ onSuccess: onUserChanged });

  const updateMembership = trpc.admin.updateUserMembership.useMutation({
    onSuccess: onUserChanged,
    onError: (error) => {
      toast.error(getSafeErrorMessage(error, '会员等级更新失败，请稍后重试'));
    },
  });

  const updateRole = trpc.admin.updateUserRole.useMutation({ onSuccess: onUserChanged });

  // Handlers
  const handleAdjustCredits = async () => {
    if (!selectedUser || creditAdjustment.amount === 0) return;
    updateCredits.mutate({
      userId: selectedUser.id,
      amount: creditAdjustment.amount,
      reason: creditAdjustment.reason || '管理员调整',
    });
  };

  const handleStatusChange = (userId: string, newStatus: UserStatus) => {
    updateStatus.mutate({ userId, status: newStatus });
  };

  const handleMembershipChange = (userId: string, newLevel: MembershipLevel) => {
    updateMembership.mutate({ userId, membershipLevel: newLevel });
  };

  const handleRoleChange = (userId: string, newRole: UserRole) => {
    updateRole.mutate({ userId, role: newRole });
  };

  const openUserDetail = (userId: string) => {
    setDetailUserId(userId);
    setDetailSheetOpen(true);
  };

  const hasActiveFilters = statusFilter !== 'all' || membershipFilter !== 'all' || roleFilter !== 'all' || searchQuery;

  const clearAllFilters = () => {
    setSearchQuery('');
    setStatusFilter('all');
    setMembershipFilter('all');
    setRoleFilter('all');
    setCurrentPage(1);
  };

  return {
    searchQuery, setSearchQuery, statusFilter, setStatusFilter, membershipFilter, setMembershipFilter, roleFilter, setRoleFilter,
    currentPage, setCurrentPage, pageSize, setPageSize,
    creditDialogOpen, setCreditDialogOpen, selectedUser, setSelectedUser, creditAdjustment, setCreditAdjustment,
    detailSheetOpen, setDetailSheetOpen,
    isLoading, error, refetch, userDetails, isLoadingDetails, users, total, totalPages,
    // the dialog only reads whether the adjustment is in flight (the full tRPC mutation type cannot be exported by name)
    updateCredits: { isPending: updateCredits.isPending },
    handleAdjustCredits, handleStatusChange, handleMembershipChange, handleRoleChange, openUserDetail,
    hasActiveFilters, clearAllFilters,
  };
}

export type UsersAdmin = ReturnType<typeof useUsersAdmin>;
