/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { Coins, Shield, Crown, Ban, CheckCircle, XCircle, ChevronLeft, ChevronRight, Eye } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { adminUserContact } from '@/lib/adminUserContact';
import { RoleBadge } from '@/components/ui/status-badge';
import { TableEmptyState } from '@/components/ui/empty-state';
import { formatLastLogin } from './lastLogin';
import { User, statusConfig, membershipConfig, PAGE_SIZE_OPTIONS, type UserStatus, type MembershipLevel, type UserRole } from './usersShared';
import type { UsersAdmin } from './useUsersAdmin';

// 用户列表和分页。从 page.tsx 原样搬出。
export function UsersTable({ admin }: { admin: UsersAdmin }) {
  const {
    currentPage, setCurrentPage, pageSize, setPageSize, setCreditDialogOpen, setSelectedUser, users, total,
    totalPages, handleStatusChange, handleMembershipChange, handleRoleChange, openUserDetail, hasActiveFilters,
  } = admin;

  return (
    <Card data-testid="admin-users-table-section" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
        <Table className="min-w-[980px]">
          <TableHeader>
            <TableRow>
              <TableHead>用户</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>会员等级</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>积分</TableHead>
              <TableHead>最后登录</TableHead>
              <TableHead className="w-[150px]">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user: User) => {
              const statusCfg = statusConfig[user.status || 'active'];
              const membershipCfg = membershipConfig[user.membership_level || 'free'];
              const StatusIcon = statusCfg.icon;
              const MemberIcon = membershipCfg.icon;

              return (
                <TableRow key={user.id} data-testid={`admin-user-row-${user.id}`}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Avatar className="h-10 w-10">
                        <AvatarImage src={user.avatar_url || undefined} />
                        <AvatarFallback className="bg-[var(--color-primary-20)] text-[var(--color-primary)]">
                          {user.nickname?.[0] || user.email?.[0]?.toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
                          {user.nickname || '未设置昵称'}
                        </p>
                        <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{adminUserContact(user)}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={user.status || 'active'}
                      onValueChange={(v) => handleStatusChange(user.id, v as UserStatus)}
                    >
                      <SelectTrigger data-testid={`admin-user-status-${user.id}`} className="w-[110px] h-8">
                        <Badge className={`${statusCfg.color} flex items-center gap-1`}>
                          <StatusIcon className="h-3 w-3 flex-shrink-0" />
                          <span>{statusCfg.label}</span>
                        </Badge>
                      </SelectTrigger>
                      <SelectContent style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}>
                        <SelectItem value="active">
                          <div className="flex items-center gap-2">
                            <CheckCircle className="h-3 w-3 text-emerald-400" />
                            正常
                          </div>
                        </SelectItem>
                        <SelectItem value="disabled">
                          <div className="flex items-center gap-2">
                            <XCircle className="h-3 w-3 text-amber-400" />
                            禁用
                          </div>
                        </SelectItem>
                        <SelectItem value="banned">
                          <div className="flex items-center gap-2">
                            <Ban className="h-3 w-3 text-rose-400" />
                            封禁
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={user.membership_level || 'free'}
                      onValueChange={(v) => handleMembershipChange(user.id, v as MembershipLevel)}
                    >
                      <SelectTrigger data-testid={`admin-user-membership-${user.id}`} className="w-[140px] h-8">
                        <Badge className={`${membershipCfg.color} flex items-center gap-1`}>
                          <MemberIcon className="h-3 w-3 flex-shrink-0" />
                          <span>{membershipCfg.label}</span>
                        </Badge>
                      </SelectTrigger>
                      <SelectContent style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}>
                        <SelectItem value="free">
                          <div className="flex items-center gap-2">
                            <User className="h-3 w-3" />
                            免费版
                          </div>
                        </SelectItem>
                        <SelectItem value="pro">
                          <div className="flex items-center gap-2">
                            <Shield className="h-3 w-3 text-blue-400" />
                            Pro 专业版
                          </div>
                        </SelectItem>
                        <SelectItem value="gold">
                          <div className="flex items-center gap-2">
                            <Crown className="h-3 w-3 text-amber-400" />
                            Gold 黄金版
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={user.role}
                      onValueChange={(v) => handleRoleChange(user.id, v as UserRole)}
                    >
                      <SelectTrigger data-testid={`admin-user-role-${user.id}`} className="w-[100px] h-8">
                        <RoleBadge role={user.role} />
                      </SelectTrigger>
                      <SelectContent style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}>
                        <SelectItem value="user">普通用户</SelectItem>
                        <SelectItem value="admin">管理员</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Coins className="h-4 w-4 text-amber-400" />
                      <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                        {(user.credits || 0).toLocaleString()}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div style={{ color: 'var(--text-tertiary)' }}>
                      {formatLastLogin(user)}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Button
                        data-testid={`admin-user-detail-${user.id}`}
                        variant="outline"
                        size="sm"
                        onClick={() => openUserDetail(user.id)}
                        className="h-8 border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                      >
                        <Eye className="h-3 w-3 mr-1" />
                        详情
                      </Button>
                      <Button
                        data-testid={`admin-user-credit-${user.id}`}
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSelectedUser(user);
                          setCreditDialogOpen(true);
                        }}
                        className="h-8 border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                      >
                        <Coins className="h-3 w-3 mr-1" />
                        积分
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {users.length === 0 && (
              <TableEmptyState colSpan={7} message={hasActiveFilters ? '没有符合条件的用户' : '暂无用户'} />
            )}
          </TableBody>
        </Table>
        </div>

        {/* Pagination */}
        {total > 0 && (
          <div
            className="flex flex-col gap-4 border-t px-4 py-4 md:flex-row md:items-center md:justify-between md:px-6"
            style={{ borderColor: 'var(--border-primary)' }}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
              <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                共 {total.toLocaleString()} 位用户
              </span>
              <div className="flex items-center gap-2">
                <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>每页</span>
                <Select
                  value={pageSize.toString()}
                  onValueChange={(v) => {
                    setPageSize(parseInt(v));
                    setCurrentPage(1);
                  }}
                >
                  <SelectTrigger className="w-[70px] h-8" style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-primary)' }}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}>
                    {PAGE_SIZE_OPTIONS.map((size) => (
                      <SelectItem key={size} value={size.toString()}>
                        {size}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>人</span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                第 {currentPage} / {totalPages || 1} 页
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="h-8 w-8 p-0 border-[var(--border-primary)] disabled:opacity-50"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage >= totalPages}
                  className="h-8 w-8 p-0 border-[var(--border-primary)] disabled:opacity-50"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
