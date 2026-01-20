'use client';

import { useState, useMemo } from 'react';
import { trpc } from '@/trpc/client';
import {
  CreditCard, TrendingUp, TrendingDown, RefreshCw,
  ArrowUpCircle, ArrowDownCircle, ShoppingCart, RotateCcw,
  User, Search, Calendar, ChevronLeft, ChevronRight, X,
  Filter, Download
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import AdminLoadingState from '@/components/admin/AdminLoadingState';
import AdminErrorState from '@/components/admin/AdminErrorState';

type TransactionType = 'deduction' | 'addition' | 'purchase' | 'refund';

interface Transaction {
  id: string;
  user_id: string;
  amount: number;
  type: TransactionType;
  description: string | null;
  created_at: string;
  profiles: {
    id: string;
    email: string;
    nickname: string | null;
    avatar_url?: string | null;
  } | null;
}

interface UserProfile {
  id: string;
  email: string;
  nickname: string | null;
  avatar_url?: string | null;
}

const typeConfig: Record<TransactionType, { label: string; color: string; icon: React.ElementType }> = {
  addition: { label: '增加', color: 'bg-emerald-500/20 text-emerald-400', icon: ArrowUpCircle },
  deduction: { label: '扣除', color: 'bg-rose-500/20 text-rose-400', icon: ArrowDownCircle },
  purchase: { label: '购买', color: 'bg-blue-500/20 text-blue-400', icon: ShoppingCart },
  refund: { label: '退款', color: 'bg-amber-500/20 text-amber-400', icon: RotateCcw },
};

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

export default function AdminTransactionsPage() {
  // Filter state
  const [typeFilter, setTypeFilter] = useState<TransactionType | 'all'>('all');
  const [userSearch, setUserSearch] = useState('');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedUserName, setSelectedUserName] = useState<string>('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [isUserSearchOpen, setIsUserSearchOpen] = useState(false);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // Query with filters
  const { data, isLoading, error, refetch } = trpc.admin.getAllTransactions.useQuery({
    type: typeFilter === 'all' ? undefined : typeFilter,
    userId: selectedUserId || undefined,
    startDate: startDate || undefined,
    endDate: endDate || undefined,
    limit: pageSize,
    offset: (currentPage - 1) * pageSize,
  });

  // User search query
  const { data: usersData } = trpc.admin.getAllUsers.useQuery({
    limit: 10,
    offset: 0,
  });

  // Filter users based on search input
  const filteredUsers = useMemo(() => {
    if (!usersData?.users || !userSearch.trim()) return [];
    const search = userSearch.toLowerCase();
    return usersData.users.filter((user: UserProfile) =>
      user.email?.toLowerCase().includes(search) ||
      user.nickname?.toLowerCase().includes(search)
    ).slice(0, 5);
  }, [usersData?.users, userSearch]);

  const transactions = data?.transactions ?? [];
  const total = data?.total ?? 0;
  const stats = data?.stats ?? {
    totalAdditions: 0,
    totalDeductions: 0,
    totalPurchases: 0,
    totalRefunds: 0,
  };

  const totalPages = Math.ceil(total / pageSize);

  // Handle user selection
  const handleUserSelect = (user: UserProfile) => {
    setSelectedUserId(user.id);
    setSelectedUserName(user.nickname || user.email);
    setUserSearch('');
    setIsUserSearchOpen(false);
    setCurrentPage(1);
  };

  // Clear user filter
  const clearUserFilter = () => {
    setSelectedUserId(null);
    setSelectedUserName('');
    setUserSearch('');
    setCurrentPage(1);
  };

  // Clear all filters
  const clearAllFilters = () => {
    setTypeFilter('all');
    setSelectedUserId(null);
    setSelectedUserName('');
    setUserSearch('');
    setStartDate('');
    setEndDate('');
    setCurrentPage(1);
  };

  // Check if any filter is active
  const hasActiveFilters = typeFilter !== 'all' || selectedUserId || startDate || endDate;

  // Calculate date range presets
  const setDatePreset = (days: number) => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);
    setStartDate(start.toISOString().split('T')[0]);
    setEndDate(end.toISOString().split('T')[0]);
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
            交易记录
          </h1>
          <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
            查看所有用户的积分交易记录 · 共 {total.toLocaleString()} 条记录
          </p>
        </div>
        <div className="flex items-center gap-3">
          {hasActiveFilters && (
            <Button
              variant="outline"
              onClick={clearAllFilters}
              className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
            >
              <X className="h-4 w-4 mr-2" />
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

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-xl bg-emerald-500/20">
                <TrendingUp className="h-6 w-6 text-emerald-400" />
              </div>
              <div>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总增加</p>
                <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                  +{stats.totalAdditions.toLocaleString()}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-xl bg-rose-500/20">
                <TrendingDown className="h-6 w-6 text-rose-400" />
              </div>
              <div>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总扣除</p>
                <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                  -{stats.totalDeductions.toLocaleString()}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-xl bg-blue-500/20">
                <ShoppingCart className="h-6 w-6 text-blue-400" />
              </div>
              <div>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总购买</p>
                <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                  +{stats.totalPurchases.toLocaleString()}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-xl bg-amber-500/20">
                <RotateCcw className="h-6 w-6 text-amber-400" />
              </div>
              <div>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总退款</p>
                <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                  +{stats.totalRefunds.toLocaleString()}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Advanced Filters */}
      <Card className="mb-6" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
        <CardHeader className="pb-4">
          <CardTitle className="text-base flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <Filter className="h-4 w-4" />
            筛选条件
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* User Search */}
            <div className="space-y-2">
              <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                按用户筛选
              </label>
              <Popover open={isUserSearchOpen} onOpenChange={setIsUserSearchOpen}>
                <PopoverTrigger asChild>
                  <div className="relative">
                    {selectedUserId ? (
                      <div
                        className="flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer"
                        style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)' }}
                      >
                        <div className="flex items-center gap-2">
                          <User className="h-4 w-4" style={{ color: 'var(--text-tertiary)' }} />
                          <span style={{ color: 'var(--text-primary)' }}>{selectedUserName}</span>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 hover:bg-[var(--bg-secondary)]"
                          onClick={(e) => {
                            e.stopPropagation();
                            clearUserFilter();
                          }}
                        >
                          <X className="h-3 w-3" style={{ color: 'var(--text-tertiary)' }} />
                        </Button>
                      </div>
                    ) : (
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4" style={{ color: 'var(--text-tertiary)' }} />
                        <Input
                          value={userSearch}
                          onChange={(e) => setUserSearch(e.target.value)}
                          placeholder="搜索用户邮箱或昵称..."
                          className="pl-10"
                          style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-primary)' }}
                        />
                      </div>
                    )}
                  </div>
                </PopoverTrigger>
                {!selectedUserId && filteredUsers.length > 0 && (
                  <PopoverContent
                    className="w-[300px] p-0"
                    align="start"
                    style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
                  >
                    <div className="py-2">
                      {filteredUsers.map((user: UserProfile) => (
                        <button
                          key={user.id}
                          className="w-full px-4 py-2 text-left hover:bg-[var(--bg-tertiary)] flex items-center gap-3"
                          onClick={() => handleUserSelect(user)}
                        >
                          <div
                            className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium"
                            style={{ background: 'var(--bg-tertiary)' }}
                          >
                            {user.avatar_url ? (
                              <img src={user.avatar_url} alt="" className="w-full h-full rounded-full object-cover" />
                            ) : (
                              <span style={{ color: 'var(--text-tertiary)' }}>
                                {(user.nickname || user.email)?.[0]?.toUpperCase()}
                              </span>
                            )}
                          </div>
                          <div>
                            <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                              {user.nickname || '未设置昵称'}
                            </p>
                            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                              {user.email}
                            </p>
                          </div>
                        </button>
                      ))}
                    </div>
                  </PopoverContent>
                )}
              </Popover>
            </div>

            {/* Date Range */}
            <div className="space-y-2">
              <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                开始日期
              </label>
              <div className="relative">
                <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4" style={{ color: 'var(--text-tertiary)' }} />
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => {
                    setStartDate(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="pl-10"
                  style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-primary)' }}
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                结束日期
              </label>
              <div className="relative">
                <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4" style={{ color: 'var(--text-tertiary)' }} />
                <Input
                  type="date"
                  value={endDate}
                  onChange={(e) => {
                    setEndDate(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="pl-10"
                  style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-primary)' }}
                />
              </div>
            </div>
          </div>

          {/* Quick Date Presets */}
          <div className="flex items-center gap-2 pt-2">
            <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>快捷:</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDatePreset(7)}
              className="text-xs border-[var(--border-primary)] hover:bg-[var(--bg-tertiary)]"
            >
              近7天
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDatePreset(30)}
              className="text-xs border-[var(--border-primary)] hover:bg-[var(--bg-tertiary)]"
            >
              近30天
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDatePreset(90)}
              className="text-xs border-[var(--border-primary)] hover:bg-[var(--bg-tertiary)]"
            >
              近90天
            </Button>
            {(startDate || endDate) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setStartDate('');
                  setEndDate('');
                  setCurrentPage(1);
                }}
                className="text-xs text-rose-400 hover:text-rose-300 hover:bg-rose-500/10"
              >
                清除日期
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Type Filter Tabs */}
      <Tabs value={typeFilter} onValueChange={(v) => {
        setTypeFilter(v as typeof typeFilter);
        setCurrentPage(1);
      }} className="mb-6">
        <TabsList className="bg-[var(--bg-tertiary)]">
          <TabsTrigger value="all" className="data-[state=active]:bg-[var(--bg-secondary)]">
            全部
          </TabsTrigger>
          <TabsTrigger value="addition" className="data-[state=active]:bg-[var(--bg-secondary)]">
            <ArrowUpCircle className="h-4 w-4 mr-1 text-emerald-400" />
            增加
          </TabsTrigger>
          <TabsTrigger value="deduction" className="data-[state=active]:bg-[var(--bg-secondary)]">
            <ArrowDownCircle className="h-4 w-4 mr-1 text-rose-400" />
            扣除
          </TabsTrigger>
          <TabsTrigger value="purchase" className="data-[state=active]:bg-[var(--bg-secondary)]">
            <ShoppingCart className="h-4 w-4 mr-1 text-blue-400" />
            购买
          </TabsTrigger>
          <TabsTrigger value="refund" className="data-[state=active]:bg-[var(--bg-secondary)]">
            <RotateCcw className="h-4 w-4 mr-1 text-amber-400" />
            退款
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Transactions Table */}
      <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>用户</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>金额</TableHead>
                <TableHead>描述</TableHead>
                <TableHead>时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transactions.map((transaction: Transaction) => {
                const config = typeConfig[transaction.type];
                const TypeIcon = config.icon;
                const isPositive = transaction.amount > 0;
                return (
                  <TableRow key={transaction.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div
                          className="w-9 h-9 rounded-lg flex items-center justify-center"
                          style={{ background: 'var(--bg-tertiary)' }}
                        >
                          {transaction.profiles?.avatar_url ? (
                            <img
                              src={transaction.profiles.avatar_url}
                              alt=""
                              className="w-full h-full rounded-lg object-cover"
                            />
                          ) : (
                            <User className="h-4 w-4 text-[var(--text-tertiary)]" />
                          )}
                        </div>
                        <div>
                          <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
                            {transaction.profiles?.nickname || '未知用户'}
                          </p>
                          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                            {transaction.profiles?.email || transaction.user_id.slice(0, 8) + '...'}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge className={config.color}>
                        <TypeIcon className="h-3 w-3 mr-1" />
                        {config.label}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span
                        className="font-semibold"
                        style={{ color: isPositive ? 'var(--success)' : 'var(--error)' }}
                      >
                        {isPositive ? '+' : ''}{transaction.amount.toLocaleString()}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm truncate max-w-[200px] block" style={{ color: 'var(--text-tertiary)' }}>
                        {transaction.description || '-'}
                      </span>
                    </TableCell>
                    <TableCell style={{ color: 'var(--text-tertiary)' }}>
                      {new Date(transaction.created_at).toLocaleString('zh-CN')}
                    </TableCell>
                  </TableRow>
                );
              })}
              {transactions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-12" style={{ color: 'var(--text-disabled)' }}>
                    {hasActiveFilters ? '没有符合筛选条件的交易记录' : '暂无交易记录'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          {/* Pagination */}
          {total > 0 && (
            <div className="flex items-center justify-between px-6 py-4 border-t" style={{ borderColor: 'var(--border-primary)' }}>
              <div className="flex items-center gap-4">
                <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                  共 {total.toLocaleString()} 条记录
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
                    <SelectTrigger
                      className="w-[70px] h-8"
                      style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-primary)' }}
                    >
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
                  <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>条</span>
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
    </div>
  );
}
