'use client';

import { trpc } from '@/trpc/client';
import {
  DollarSign, TrendingUp, TrendingDown, Users,
  Coins, Package, RefreshCw, Calendar,
  ArrowUpCircle, ArrowDownCircle, ShoppingCart
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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

export default function AdminFinancePage() {
  const { data, isLoading, error, refetch } = trpc.admin.getFinanceStats.useQuery();

  // Loading state
  if (isLoading) {
    return <AdminLoadingState />;
  }

  // Error state
  if (error) {
    return <AdminErrorState error={error} onRetry={() => refetch()} />;
  }

  const transactions = data?.transactions ?? {
    totalAdditions: 0, totalDeductions: 0, totalPurchases: 0, totalRefunds: 0,
    todayTransactions: 0, weekTransactions: 0, monthTransactions: 0
  };
  const users = data?.users ?? {
    totalUsers: 0, totalCreditsInSystem: 0, averageCreditsPerUser: 0,
    newUsersThisMonth: 0, newUsersThisWeek: 0
  };
  const packages = data?.packages ?? { totalPackages: 0, activePackages: 0, packages: [] };
  const dailyChart = data?.dailyChart ?? [];

  // Calculate net flow
  const netFlow = transactions.totalAdditions + transactions.totalPurchases - transactions.totalDeductions;

  return (
    <div className="p-8 overflow-auto">
      {/* Page Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
              财务统计
            </h1>
            <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
              平台收入与积分流动统计
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => refetch()}
            className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            刷新数据
          </Button>
        </div>

        {/* Main Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-[var(--color-primary-20)]">
                  <Coins className="h-6 w-6 text-[var(--color-primary)]" />
                </div>
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>系统总积分</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {users.totalCreditsInSystem.toLocaleString()}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-emerald-500/20">
                  <TrendingUp className="h-6 w-6 text-emerald-400" />
                </div>
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总增加</p>
                  <p className="text-2xl font-bold text-emerald-400">
                    +{transactions.totalAdditions.toLocaleString()}
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
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总消耗</p>
                  <p className="text-2xl font-bold text-rose-400">
                    -{transactions.totalDeductions.toLocaleString()}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className={`p-3 rounded-xl ${netFlow >= 0 ? 'bg-emerald-500/20' : 'bg-rose-500/20'}`}>
                  <DollarSign className={`h-6 w-6 ${netFlow >= 0 ? 'text-emerald-400' : 'text-rose-400'}`} />
                </div>
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>净流入</p>
                  <p className={`text-2xl font-bold ${netFlow >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {netFlow >= 0 ? '+' : ''}{netFlow.toLocaleString()}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Secondary Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium" style={{ color: 'var(--text-tertiary)' }}>
                交易统计
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>今日交易</span>
                  <Badge className="bg-blue-500/20 text-blue-400">{transactions.todayTransactions}</Badge>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>本周交易</span>
                  <Badge className="bg-purple-500/20 text-purple-400">{transactions.weekTransactions}</Badge>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>本月交易</span>
                  <Badge className="bg-amber-500/20 text-amber-400">{transactions.monthTransactions}</Badge>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium" style={{ color: 'var(--text-tertiary)' }}>
                用户统计
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>总用户数</span>
                  <Badge className="bg-[var(--color-primary-20)] text-[var(--color-primary)]">{users.totalUsers}</Badge>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>人均积分</span>
                  <Badge className="bg-emerald-500/20 text-emerald-400">{users.averageCreditsPerUser}</Badge>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>本周新增</span>
                  <Badge className="bg-blue-500/20 text-blue-400">{users.newUsersThisWeek}</Badge>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium" style={{ color: 'var(--text-tertiary)' }}>
                积分类型分布
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <ArrowUpCircle className="h-4 w-4 text-emerald-400" />
                    <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>增加</span>
                  </div>
                  <span className="text-emerald-400">+{transactions.totalAdditions.toLocaleString()}</span>
                </div>
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <ShoppingCart className="h-4 w-4 text-blue-400" />
                    <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>购买</span>
                  </div>
                  <span className="text-blue-400">+{transactions.totalPurchases.toLocaleString()}</span>
                </div>
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <ArrowDownCircle className="h-4 w-4 text-rose-400" />
                    <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>消耗</span>
                  </div>
                  <span className="text-rose-400">-{transactions.totalDeductions.toLocaleString()}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Daily Chart - Simple Bar Representation */}
        <Card className="mb-8" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <Calendar className="h-5 w-5" />
              近30天积分流动
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex items-center gap-4 text-xs mb-4" style={{ color: 'var(--text-tertiary)' }}>
                <div className="flex items-center gap-1">
                  <div className="w-3 h-3 bg-emerald-400 rounded"></div>
                  <span>增加</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-3 h-3 bg-blue-400 rounded"></div>
                  <span>购买</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-3 h-3 bg-rose-400 rounded"></div>
                  <span>消耗</span>
                </div>
              </div>
              <div className="h-40 flex items-end gap-1">
                {dailyChart.slice(-14).map((day, index) => {
                  const maxValue = Math.max(
                    ...dailyChart.map(d => Math.max(d.additions, d.purchases, d.deductions))
                  ) || 1;
                  return (
                    <div key={index} className="flex-1 flex flex-col gap-0.5" title={day.date}>
                      <div
                        className="bg-emerald-400 rounded-t"
                        style={{ height: `${(day.additions / maxValue) * 100}%`, minHeight: day.additions > 0 ? '2px' : '0' }}
                      />
                      <div
                        className="bg-blue-400"
                        style={{ height: `${(day.purchases / maxValue) * 100}%`, minHeight: day.purchases > 0 ? '2px' : '0' }}
                      />
                      <div
                        className="bg-rose-400 rounded-b"
                        style={{ height: `${(day.deductions / maxValue) * 100}%`, minHeight: day.deductions > 0 ? '2px' : '0' }}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between text-xs" style={{ color: 'var(--text-disabled)' }}>
                <span>{dailyChart[dailyChart.length - 14]?.date.slice(5) || ''}</span>
                <span>{dailyChart[dailyChart.length - 1]?.date.slice(5) || ''}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Credit Packages Table */}
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <Package className="h-5 w-5" />
              积分套餐列表
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>套餐名称</TableHead>
                  <TableHead>价格</TableHead>
                  <TableHead>积分数量</TableHead>
                  <TableHead>状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {packages.packages.map((pkg) => (
                  <TableRow key={pkg.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div
                          className="p-2 rounded-lg"
                          style={{ background: 'var(--bg-tertiary)' }}
                        >
                          <Package className="h-4 w-4 text-[var(--color-primary)]" />
                        </div>
                        <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                          {pkg.name}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span style={{ color: 'var(--text-primary)' }}>
                        ¥{(pkg.price / 100).toFixed(2)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Coins className="h-4 w-4 text-amber-400" />
                        <span style={{ color: 'var(--text-primary)' }}>
                          {pkg.creditsAmount.toLocaleString()}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={pkg.active === 'true'
                          ? 'bg-emerald-500/20 text-emerald-400'
                          : 'bg-rose-500/20 text-rose-400'
                        }
                      >
                        {pkg.active === 'true' ? '已上架' : '已下架'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
                {packages.packages.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center py-12" style={{ color: 'var(--text-disabled)' }}>
                      暂无积分套餐
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
    </div>
  );
}
