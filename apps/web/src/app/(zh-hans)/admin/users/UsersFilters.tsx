/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { Search, Filter } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { UsersAdmin } from './useUsersAdmin';

// 筛选条件：搜索、账号状态、会员等级、用户角色。从 page.tsx 原样搬出。
export function UsersFilters({ admin }: { admin: UsersAdmin }) {
  const {
    searchQuery, setSearchQuery, statusFilter, setStatusFilter, membershipFilter, setMembershipFilter, roleFilter,
    setRoleFilter, setCurrentPage,
  } = admin;

  return (
    <Card data-testid="admin-users-filters" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
      <CardHeader className="pb-4">
        <CardTitle className="text-base flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          <Filter className="h-4 w-4" />
          筛选条件
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* Search */}
          <div className="space-y-2">
            <Label style={{ color: 'var(--text-secondary)' }}>搜索</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4" style={{ color: 'var(--text-tertiary)' }} />
              <Input
                data-testid="admin-users-search"
                placeholder="邮箱、昵称或手机号..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setCurrentPage(1);
                }}
                className="pl-10"
                style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-primary)' }}
              />
            </div>
          </div>

          {/* Status Filter */}
          <div className="space-y-2">
            <Label style={{ color: 'var(--text-secondary)' }}>账号状态</Label>
            <Select
              value={statusFilter}
              onValueChange={(v) => {
                setStatusFilter(v as typeof statusFilter);
                setCurrentPage(1);
              }}
            >
              <SelectTrigger style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-primary)' }}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="active">正常</SelectItem>
                <SelectItem value="disabled">禁用</SelectItem>
                <SelectItem value="banned">封禁</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Membership Filter */}
          <div className="space-y-2">
            <Label style={{ color: 'var(--text-secondary)' }}>会员等级</Label>
            <Select
              value={membershipFilter}
              onValueChange={(v) => {
                setMembershipFilter(v as typeof membershipFilter);
                setCurrentPage(1);
              }}
            >
              <SelectTrigger style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-primary)' }}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}>
                <SelectItem value="all">全部等级</SelectItem>
                <SelectItem value="free">免费版</SelectItem>
                <SelectItem value="pro">Pro 专业版</SelectItem>
                <SelectItem value="gold">Gold 黄金版</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Role Filter */}
          <div className="space-y-2">
            <Label style={{ color: 'var(--text-secondary)' }}>用户角色</Label>
            <Select
              value={roleFilter}
              onValueChange={(v) => {
                setRoleFilter(v as typeof roleFilter);
                setCurrentPage(1);
              }}
            >
              <SelectTrigger style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-primary)' }}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}>
                <SelectItem value="all">全部角色</SelectItem>
                <SelectItem value="user">普通用户</SelectItem>
                <SelectItem value="admin">管理员</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
