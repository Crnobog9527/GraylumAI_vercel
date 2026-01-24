'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import {
  Search, Coins, Plus, Minus, User, Shield, Crown, Ban,
  CheckCircle, XCircle, Clock, MessageSquare, History,
  ChevronLeft, ChevronRight, RefreshCw, Filter, Eye,
  AlertTriangle, Activity, Mail, Calendar
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import AdminLoadingState from '@/components/admin/AdminLoadingState';
import AdminErrorState from '@/components/admin/AdminErrorState';
import { RoleBadge } from '@/components/ui/status-badge';
import { TableEmptyState } from '@/components/ui/empty-state';

type UserStatus = 'active' | 'disabled' | 'banned';
type MembershipLevel = 'free' | 'pro' | 'gold';
type UserRole = 'user' | 'admin';

interface User {
  id: string;
  email: string;
  nickname: string | null;
  avatar_url: string | null;
  role: UserRole;
  status: UserStatus;
  membership_level: MembershipLevel;
  credits: number;
  last_login_at: string | null;
  last_ip: string | null;
  created_at: string;
}

interface ActivityLog {
  id: string;
  action: string;
  action_type: string;
  details: Record<string, unknown>;
  created_at: string;
  admin?: {
    id: string;
    email: string;
    nickname: string | null;
    avatar_url: string | null;
  };
}

const statusConfig: Record<UserStatus, { label: string; color: string; icon: React.ElementType }> = {
  active: { label: '正常', color: 'bg-emerald-500/20 text-emerald-400', icon: CheckCircle },
  disabled: { label: '禁用', color: 'bg-amber-500/20 text-amber-400', icon: XCircle },
  banned: { label: '封禁', color: 'bg-rose-500/20 text-rose-400', icon: Ban },
};

const membershipConfig: Record<MembershipLevel, { label: string; color: string; icon: React.ElementType }> = {
  free: { label: '免费版', color: 'bg-slate-500/20 text-slate-400', icon: User },
  pro: { label: 'Pro 专业版', color: 'bg-blue-500/20 text-blue-400', icon: Shield },
  gold: { label: 'Gold 黄金版', color: 'bg-amber-500/20 text-amber-400', icon: Crown },
};

const PAGE_SIZE_OPTIONS = [10, 20, 50];

export default function AdminUsersPage() {
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

  const updateCredits = trpc.admin.adjustUserCredits.useMutation({
    onSuccess: () => {
      utils.admin.getAllUsers.invalidate();
      utils.admin.getUserDetails.invalidate();
      setCreditDialogOpen(false);
      setCreditAdjustment({ amount: 0, reason: '' });
      setSelectedUser(null);
    }
  });

  const updateStatus = trpc.admin.updateUserStatus.useMutation({
    onSuccess: () => {
      utils.admin.getAllUsers.invalidate();
      utils.admin.getUserDetails.invalidate();
    }
  });

  const updateMembership = trpc.admin.updateUserMembership.useMutation({
    onSuccess: () => {
      utils.admin.getAllUsers.invalidate();
      utils.admin.getUserDetails.invalidate();
    }
  });

  const updateRole = trpc.admin.updateUserRole.useMutation({
    onSuccess: () => {
      utils.admin.getAllUsers.invalidate();
      utils.admin.getUserDetails.invalidate();
    }
  });

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

  // Loading state
  if (isLoading) {
    return <AdminLoadingState />;
  }

  // Error state
  if (error) {
    return <AdminErrorState error={error} onRetry={() => refetch()} />;
  }

  return (
    <div className="p-8 overflow-auto">
      {/* Page Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
            用户管理
          </h1>
          <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
            管理平台用户、权限和积分 · 共 {total.toLocaleString()} 位用户
          </p>
        </div>
        <div className="flex items-center gap-3">
          {hasActiveFilters && (
            <Button
              variant="outline"
              onClick={clearAllFilters}
              className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
            >
              清除筛选
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => refetch()}
            className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            刷新
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card className="mb-6" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
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
                  placeholder="邮箱或昵称..."
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

      {/* Users Table */}
      <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
        <CardContent className="p-0">
          <Table>
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
                  <TableRow key={user.id}>
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
                          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{user.email}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={user.status || 'active'}
                        onValueChange={(v) => handleStatusChange(user.id, v as UserStatus)}
                      >
                        <SelectTrigger className="w-[110px] h-8">
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
                        <SelectTrigger className="w-[140px] h-8">
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
                        <SelectTrigger className="w-[100px] h-8">
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
                        {user.last_login_at
                          ? new Date(user.last_login_at).toLocaleString('zh-CN')
                          : '从未登录'}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openUserDetail(user.id)}
                          className="h-8 border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                        >
                          <Eye className="h-3 w-3 mr-1" />
                          详情
                        </Button>
                        <Button
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

          {/* Pagination */}
          {total > 0 && (
            <div className="flex items-center justify-between px-6 py-4 border-t" style={{ borderColor: 'var(--border-primary)' }}>
              <div className="flex items-center gap-4">
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

              <div className="flex items-center gap-2">
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

      {/* Credit Adjustment Dialog */}
      <Dialog open={creditDialogOpen} onOpenChange={setCreditDialogOpen}>
        <DialogContent className="max-w-md" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <DialogHeader>
            <DialogTitle style={{ color: 'var(--text-primary)' }}>调整积分</DialogTitle>
          </DialogHeader>

          {selectedUser && (
            <div className="space-y-4 py-4">
              <div className="flex items-center gap-3 p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                <Avatar className="h-12 w-12">
                  <AvatarImage src={selectedUser.avatar_url || undefined} />
                  <AvatarFallback className="bg-[var(--color-primary-20)] text-[var(--color-primary)]">
                    {selectedUser.nickname?.[0] || selectedUser.email?.[0]?.toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
                    {selectedUser.nickname || '未设置昵称'}
                  </p>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{selectedUser.email}</p>
                  <p className="text-sm mt-1 text-amber-400">当前余额: {selectedUser.credits || 0}</p>
                </div>
              </div>

              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>调整数量</Label>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setCreditAdjustment(prev => ({ ...prev, amount: prev.amount - 100 }))}
                    className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                  >
                    <Minus className="h-4 w-4" />
                  </Button>
                  <Input
                    type="number"
                    value={creditAdjustment.amount}
                    onChange={(e) => setCreditAdjustment(prev => ({ ...prev, amount: parseInt(e.target.value) || 0 }))}
                    className="text-center"
                    style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-primary)' }}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setCreditAdjustment(prev => ({ ...prev, amount: prev.amount + 100 }))}
                    className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs" style={{ color: 'var(--text-disabled)' }}>正数增加积分，负数扣除积分</p>
              </div>

              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>调整原因</Label>
                <Input
                  value={creditAdjustment.reason}
                  onChange={(e) => setCreditAdjustment(prev => ({ ...prev, reason: e.target.value }))}
                  placeholder="奖励积分、退款等..."
                  style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-primary)' }}
                />
              </div>

              {creditAdjustment.amount !== 0 && (
                <div className="p-3 rounded-lg text-center" style={{ background: 'var(--color-primary-10)' }}>
                  <p className="text-sm" style={{ color: 'var(--color-primary)' }}>
                    调整后余额: <span className="font-bold">{(selectedUser.credits || 0) + creditAdjustment.amount}</span>
                  </p>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreditDialogOpen(false)}
              className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
            >
              取消
            </Button>
            <Button
              onClick={handleAdjustCredits}
              disabled={creditAdjustment.amount === 0 || updateCredits.isPending}
              className="bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
            >
              {updateCredits.isPending ? '保存中...' : '确认调整'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* User Detail Sheet */}
      <Sheet open={detailSheetOpen} onOpenChange={setDetailSheetOpen}>
        <SheetContent className="w-[500px] sm:max-w-[500px] overflow-y-auto" style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-primary)' }}>
          <SheetHeader>
            <SheetTitle style={{ color: 'var(--text-primary)' }}>用户详情</SheetTitle>
          </SheetHeader>

          {isLoadingDetails ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-[var(--color-primary)]" />
            </div>
          ) : userDetails ? (
            <div className="mt-6 space-y-6">
              {/* User Profile Card */}
              <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-4">
                    <Avatar className="h-16 w-16">
                      <AvatarImage src={userDetails.profile.avatar_url || undefined} />
                      <AvatarFallback className="text-xl bg-[var(--color-primary-20)] text-[var(--color-primary)]">
                        {userDetails.profile.nickname?.[0] || userDetails.profile.email?.[0]?.toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1">
                      <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {userDetails.profile.nickname || '未设置昵称'}
                      </h3>
                      <div className="flex items-center gap-2 mt-1">
                        <Mail className="h-4 w-4" style={{ color: 'var(--text-tertiary)' }} />
                        <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                          {userDetails.profile.email}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-2 flex-wrap">
                        <RoleBadge role={userDetails.profile.role} />
                        <Badge className={`${statusConfig[userDetails.profile.status as UserStatus || 'active'].color} flex items-center gap-1`}>
                          {(() => {
                            const StatusIcon = statusConfig[userDetails.profile.status as UserStatus || 'active'].icon;
                            return <StatusIcon className="h-3 w-3 flex-shrink-0" />;
                          })()}
                          <span>{statusConfig[userDetails.profile.status as UserStatus || 'active'].label}</span>
                        </Badge>
                        <Badge className={`${membershipConfig[userDetails.profile.membership_level as MembershipLevel || 'free'].color} flex items-center gap-1`}>
                          {(() => {
                            const MemberIcon = membershipConfig[userDetails.profile.membership_level as MembershipLevel || 'free'].icon;
                            return <MemberIcon className="h-3 w-3 flex-shrink-0" />;
                          })()}
                          <span>{membershipConfig[userDetails.profile.membership_level as MembershipLevel || 'free'].label}</span>
                        </Badge>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 mt-6">
                    <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                      <div className="flex items-center gap-2">
                        <Calendar className="h-4 w-4" style={{ color: 'var(--text-tertiary)' }} />
                        <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>注册时间</span>
                      </div>
                      <p className="mt-1 text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                        {new Date(userDetails.profile.created_at).toLocaleDateString('zh-CN')}
                      </p>
                    </div>
                    <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4" style={{ color: 'var(--text-tertiary)' }} />
                        <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>最后登录</span>
                      </div>
                      <p className="mt-1 text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                        {userDetails.profile.last_login_at
                          ? new Date(userDetails.profile.last_login_at).toLocaleString('zh-CN')
                          : '从未登录'}
                      </p>
                    </div>
                  </div>

                  {userDetails.profile.last_ip && (
                    <div className="mt-4 p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                      <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>最后登录 IP</span>
                      <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                        {userDetails.profile.last_ip}
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Usage Statistics */}
              <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                    <Activity className="h-4 w-4" />
                    使用统计
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="text-center p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                      <MessageSquare className="h-6 w-6 mx-auto mb-2 text-blue-400" />
                      <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                        {userDetails.stats.totalConversations}
                      </p>
                      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>对话数</p>
                    </div>
                    <div className="text-center p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                      <Coins className="h-6 w-6 mx-auto mb-2 text-amber-400" />
                      <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                        {userDetails.stats.totalCreditsSpent.toLocaleString()}
                      </p>
                      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>消耗积分</p>
                    </div>
                    <div className="text-center p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                      <Coins className="h-6 w-6 mx-auto mb-2 text-emerald-400" />
                      <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                        {(userDetails.profile.credits || 0).toLocaleString()}
                      </p>
                      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>当前余额</p>
                    </div>
                    <div className="text-center p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                      <AlertTriangle className="h-6 w-6 mx-auto mb-2 text-purple-400" />
                      <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                        {userDetails.stats.totalTickets}
                      </p>
                      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>工单数</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Recent Activity */}
              <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                    <History className="h-4 w-4" />
                    操作日志
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {userDetails.recentActivity.length > 0 ? (
                    <div className="space-y-3">
                      {userDetails.recentActivity.map((log: ActivityLog) => (
                        <div key={log.id} className="flex items-start gap-3 p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                          <div className="flex-1">
                            <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                              {log.action}
                            </p>
                            <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                              {new Date(log.created_at).toLocaleString('zh-CN')}
                            </p>
                          </div>
                          <Badge className="text-xs bg-slate-500/20 text-slate-400">
                            {log.action_type}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-8" style={{ color: 'var(--text-disabled)' }}>
                      暂无操作日志
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
