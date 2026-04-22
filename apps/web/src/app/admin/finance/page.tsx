'use client';

import { trpc } from '@/trpc/client';
import {
  DollarSign, TrendingUp, TrendingDown, Users,
  Coins, Package, RefreshCw, Calendar,
  ArrowUpCircle, ArrowDownCircle, ShoppingCart,
  Cpu, MessageSquare, Globe, Settings,
  Zap, Activity, CircleDollarSign, PiggyBank
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import AdminErrorState from '@/components/admin/AdminErrorState';
import { formatUsd, formatUsdFromCents } from '@/lib/currency';

function formatCreditsRange(range: { min: number; max: number } | null, suffix: string) {
  if (!range) {
    return '未配置';
  }

  if (range.min === range.max) {
    return `${range.min.toFixed(2)} ${suffix}`;
  }

  return `${range.min.toFixed(2)} - ${range.max.toFixed(2)} ${suffix}`;
}

export default function AdminFinancePage() {
  const { data, isLoading, error, refetch } = trpc.admin.getFinanceStats.useQuery();

  // Error state
  if (error && !data) {
    return <AdminErrorState error={error} onRetry={() => refetch()} />;
  }

  const isInitialLoading = isLoading && !data;

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
  const apiStats = data?.apiStats ?? { totalRequests: 0, totalConversations: 0, messagesThisMonth: 0, messagesThisWeek: 0 };
  const modelStats = data?.modelStats ?? [];
  const financeOverview = data?.financeOverview ?? { estimatedRevenue: 0, creditsConsumed: 0, creditsPurchased: 0, creditsGiven: 0, netCreditsFlow: 0 };
  const runtimeBilling = data?.runtimeBilling ?? {
    creditsPerUsd: 1000,
    tokenPriceMultiplier: 1.5,
    activeModelCount: 0,
    inputCreditsPer1KRange: null,
    outputCreditsPer1KRange: null,
    searchCreditsPer1KRange: null,
    searchSurchargeCredits: 0,
    newUserCredits: 100,
  };

  // Calculate profit (revenue - estimated cost based on consumption)
  const estimatedProfit = financeOverview.estimatedRevenue - (financeOverview.creditsConsumed * 0.01); // Rough cost estimation

  return (
    <div className="space-y-6 p-4 md:p-8" data-testid="admin-finance-page">
      {/* Page Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between" data-testid="admin-finance-header">
        <div>
          <h1 className="text-2xl font-bold md:text-3xl" style={{ color: 'var(--text-primary)' }}>
            财务统计
          </h1>
          <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
            平台收入、成本与 API 使用统计（USD）
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => refetch()}
          className="w-full border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] sm:w-auto"
        >
          {isInitialLoading && <span className="mr-2 text-xs">加载中</span>}
          <RefreshCw className="h-4 w-4 mr-2" />
          刷新数据
        </Button>
      </div>

      <Tabs data-testid="admin-finance-tabs" defaultValue="overview" className="w-full">
        <TabsList
          className="mb-2 flex h-auto justify-start gap-1 overflow-x-auto p-1"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
        >
          <TabsTrigger
            value="overview"
            className="shrink-0 data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black"
          >
            <CircleDollarSign className="h-4 w-4 mr-2" />
            收入概览
          </TabsTrigger>
          <TabsTrigger
            value="api"
            className="shrink-0 data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black"
          >
            <Activity className="h-4 w-4 mr-2" />
            API 统计
          </TabsTrigger>
          <TabsTrigger
            value="models"
            className="shrink-0 data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black"
          >
            <Cpu className="h-4 w-4 mr-2" />
            模型渠道
          </TabsTrigger>
          <TabsTrigger
            value="rules"
            className="shrink-0 data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black"
          >
            <Settings className="h-4 w-4 mr-2" />
            积分规则
          </TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-6">
          {/* Finance Overview Cards */}
          <div data-testid="admin-finance-api-summary" className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <Card data-testid="admin-finance-overview-revenue" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-xl bg-emerald-500/20">
                    <PiggyBank className="h-6 w-6 text-emerald-400" />
                  </div>
                  <div>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>预估收入 (USD)</p>
                    <p className="text-2xl font-bold text-emerald-400">
                      {formatUsdFromCents(financeOverview.estimatedRevenue)}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card data-testid="admin-finance-overview-consumed" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-xl bg-rose-500/20">
                    <TrendingDown className="h-6 w-6 text-rose-400" />
                  </div>
                  <div>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>积分消耗</p>
                    <p className="text-2xl font-bold text-rose-400">
                      {financeOverview.creditsConsumed.toLocaleString()}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card data-testid="admin-finance-overview-purchased" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-xl bg-blue-500/20">
                    <ShoppingCart className="h-6 w-6 text-blue-400" />
                  </div>
                  <div>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>积分购买</p>
                    <p className="text-2xl font-bold text-blue-400">
                      {financeOverview.creditsPurchased.toLocaleString()}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card data-testid="admin-finance-overview-profit" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-6">
                <div className="flex items-center gap-4">
                  <div className={`p-3 rounded-xl ${estimatedProfit >= 0 ? 'bg-emerald-500/20' : 'bg-rose-500/20'}`}>
                    <DollarSign className={`h-6 w-6 ${estimatedProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`} />
                  </div>
                  <div>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>预估盈利 (USD)</p>
                    <p className={`text-2xl font-bold ${estimatedProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {formatUsd(estimatedProfit / 100)}
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
                    <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>系统总积分</span>
                    <Badge className="bg-amber-500/20 text-amber-400">{users.totalCreditsInSystem.toLocaleString()}</Badge>
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
                      <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>赠送</span>
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

          {/* Daily Chart */}
          <Card data-testid="admin-finance-daily-chart" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
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
                    <span>赠送</span>
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
          <Card data-testid="admin-finance-packages-section" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                <Package className="h-5 w-5" />
                积分套餐列表
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
              <Table className="min-w-[720px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>套餐名称</TableHead>
                    <TableHead>价格</TableHead>
                    <TableHead>积分数量</TableHead>
                    <TableHead>单价($/千积分)</TableHead>
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
                          {formatUsdFromCents(pkg.price)}
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
                        <span style={{ color: 'var(--text-secondary)' }}>
                          ${((pkg.price / pkg.creditsAmount) * 10).toFixed(3)}
                        </span>
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
                      <TableCell colSpan={5} className="text-center py-12" style={{ color: 'var(--text-disabled)' }}>
                        暂无积分套餐
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* API Statistics Tab */}
        <TabsContent value="api" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-xl bg-blue-500/20">
                    <Zap className="h-6 w-6 text-blue-400" />
                  </div>
                  <div>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总请求数</p>
                    <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                      {apiStats.totalRequests.toLocaleString()}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-xl bg-purple-500/20">
                    <MessageSquare className="h-6 w-6 text-purple-400" />
                  </div>
                  <div>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总对话数</p>
                    <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                      {apiStats.totalConversations.toLocaleString()}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-xl bg-emerald-500/20">
                    <Activity className="h-6 w-6 text-emerald-400" />
                  </div>
                  <div>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>本周消息</p>
                    <p className="text-2xl font-bold text-emerald-400">
                      {apiStats.messagesThisWeek.toLocaleString()}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-xl bg-amber-500/20">
                    <Calendar className="h-6 w-6 text-amber-400" />
                  </div>
                  <div>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>本月消息</p>
                    <p className="text-2xl font-bold text-amber-400">
                      {apiStats.messagesThisMonth.toLocaleString()}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card data-testid="admin-finance-api-section" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                <Activity className="h-5 w-5" />
                API 使用说明
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  API 统计与运行时记账已接通同一套 Token/成本链路。这里的请求与消息面板仅用于运营概览，不再作为独立结算口径；精确 Token、积分消耗和路由结果请结合成本页与 Token 统计页查看。
                </p>
                <ul className="mt-3 space-y-2 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                  <li>• 总请求数 = AI 回复消息数量</li>
                  <li>• 总对话数 = 创建的对话数量</li>
                  <li>• 精确 Token 使用与积分消耗以运行时写入的 usage/token stats 为准</li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Model Channel Statistics Tab */}
        <TabsContent value="models" className="space-y-6">
          <Card data-testid="admin-finance-models-section" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                <Cpu className="h-5 w-5" />
                模型渠道统计
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
              <Table className="min-w-[900px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>模型名称</TableHead>
                    <TableHead>提供商</TableHead>
                    <TableHead>输入成本</TableHead>
                    <TableHead>输出成本</TableHead>
                    <TableHead>搜索成本</TableHead>
                    <TableHead>对话数</TableHead>
                    <TableHead>状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {modelStats.map((model) => (
                    <TableRow key={model.id} data-testid={`admin-finance-model-row-${model.id}`}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                            {model.name}
                          </span>
                          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                            {model.modelId}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge className="bg-blue-500/20 text-blue-400">
                          {model.provider}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">
                          <div style={{ color: 'var(--text-primary)' }}>
                            ${(model.inputTokenCost / 1000000).toFixed(3)}/1M
                          </div>
                          {model.inputTokenCostAbove200k > 0 && (
                            <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                              &gt;200K: ${(model.inputTokenCostAbove200k / 1000000).toFixed(3)}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">
                          <div style={{ color: 'var(--text-primary)' }}>
                            ${(model.outputTokenCost / 1000000).toFixed(3)}/1M
                          </div>
                          {model.outputTokenCostAbove200k > 0 && (
                            <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                              &gt;200K: ${(model.outputTokenCostAbove200k / 1000000).toFixed(3)}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span style={{ color: 'var(--text-primary)' }}>
                          {model.webSearchCost > 0 ? `$${(model.webSearchCost / 1000).toFixed(3)}/1K` : '-'}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <MessageSquare className="h-4 w-4" style={{ color: 'var(--text-tertiary)' }} />
                          <span style={{ color: 'var(--text-primary)' }}>
                            {model.conversationCount}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={model.isActive === 'true'
                            ? 'bg-emerald-500/20 text-emerald-400'
                            : 'bg-rose-500/20 text-rose-400'
                          }
                        >
                          {model.isActive === 'true' ? '启用' : '禁用'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                  {modelStats.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-12" style={{ color: 'var(--text-disabled)' }}>
                        暂无模型数据
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Credits Rules Tab */}
        <TabsContent value="rules" className="space-y-6">
          <div
            data-testid="admin-finance-rules-note"
            className="rounded-lg border p-4"
            style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-primary)' }}
          >
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              本标签页现在展示运行时计费口径：实际扣费取决于活跃模型在
              <a href="/admin/models" className="mx-1 underline hover:no-underline" style={{ color: 'var(--color-primary)' }}>
                AI 模型管理
              </a>
              中配置的美元成本、实时 token 记账，以及站内积分换算常量；旧的 `system_settings.input/output/web_search` 规则仅保留历史兼容，不再视为 authoritative。
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card data-testid="admin-finance-rules-section" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                  <Coins className="h-5 w-5" />
                  运行时计费基线
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex justify-between items-center p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-blue-500/20">
                        <TrendingUp className="h-4 w-4 text-blue-400" />
                      </div>
                      <div>
                        <p className="font-medium" style={{ color: 'var(--text-primary)' }}>积分兑美元比例</p>
                        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>站内统一换算基线</p>
                      </div>
                    </div>
                    <Badge className="bg-blue-500/20 text-blue-400 text-lg px-3">
                      {runtimeBilling.creditsPerUsd}
                    </Badge>
                  </div>

                  <div className="flex justify-between items-center p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-purple-500/20">
                        <TrendingDown className="h-4 w-4 text-purple-400" />
                      </div>
                      <div>
                        <p className="font-medium" style={{ color: 'var(--text-primary)' }}>价格倍率</p>
                        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>用户价格 = API 成本 × 倍率</p>
                      </div>
                    </div>
                    <Badge className="bg-purple-500/20 text-purple-400 text-lg px-3">
                      {runtimeBilling.tokenPriceMultiplier.toFixed(2)}x
                    </Badge>
                  </div>

                  <div className="flex justify-between items-center p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-emerald-500/20">
                        <Globe className="h-4 w-4 text-emerald-400" />
                      </div>
                      <div>
                        <p className="font-medium" style={{ color: 'var(--text-primary)' }}>活跃计费模型</p>
                        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>当前参与运行时计费折算</p>
                      </div>
                    </div>
                    <Badge className="bg-emerald-500/20 text-emerald-400 text-lg px-3">
                      {runtimeBilling.activeModelCount}
                    </Badge>
                  </div>

                  <div className="flex justify-between items-center p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-amber-500/20">
                        <Zap className="h-4 w-4 text-amber-400" />
                      </div>
                      <div>
                        <p className="font-medium" style={{ color: 'var(--text-primary)' }}>联网附加积分</p>
                        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>每次真实联网搜索额外增加</p>
                      </div>
                    </div>
                    <Badge className="bg-amber-500/20 text-amber-400 text-lg px-3">
                      {runtimeBilling.searchSurchargeCredits}
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card data-testid="admin-finance-benefits-section" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                  <Users className="h-5 w-5" />
                  运行时折算与福利
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex justify-between items-center p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <div>
                      <p className="font-medium" style={{ color: 'var(--text-primary)' }}>输入成本区间</p>
                      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>按活跃模型折算，每 1K 输入 Token</p>
                    </div>
                    <Badge className="bg-blue-500/20 text-blue-400 text-sm px-3 py-1">
                      {formatCreditsRange(runtimeBilling.inputCreditsPer1KRange, '积分')}
                    </Badge>
                  </div>

                  <div className="flex justify-between items-center p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <div>
                      <p className="font-medium" style={{ color: 'var(--text-primary)' }}>输出成本区间</p>
                      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>按活跃模型折算，每 1K 输出 Token</p>
                    </div>
                    <Badge className="bg-purple-500/20 text-purple-400 text-sm px-3 py-1">
                      {formatCreditsRange(runtimeBilling.outputCreditsPer1KRange, '积分')}
                    </Badge>
                  </div>

                  <div className="flex justify-between items-center p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <div>
                      <p className="font-medium" style={{ color: 'var(--text-primary)' }}>模型联网成本区间</p>
                      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>按活跃模型折算，每 1K 次真实搜索</p>
                    </div>
                    <Badge className="bg-emerald-500/20 text-emerald-400 text-sm px-3 py-1">
                      {formatCreditsRange(runtimeBilling.searchCreditsPer1KRange, '积分')}
                    </Badge>
                  </div>

                  <div className="flex justify-between items-center p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-[var(--color-primary-20)]">
                        <Zap className="h-4 w-4 text-[var(--color-primary)]" />
                      </div>
                      <div>
                        <p className="font-medium" style={{ color: 'var(--text-primary)' }}>注册赠送积分</p>
                        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>新用户注册时获得</p>
                      </div>
                    </div>
                    <Badge className="bg-[var(--color-primary-20)] text-[var(--color-primary)] text-lg px-3">
                      {runtimeBilling.newUserCredits}
                    </Badge>
                  </div>
                </div>

                <div className="mt-6 p-4 rounded-lg border" style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-primary)' }}>
                  <h4 className="font-medium mb-2" style={{ color: 'var(--text-primary)' }}>说明</h4>
                  <div className="text-sm space-y-1" style={{ color: 'var(--text-secondary)' }}>
                    <p>• 实际扣费 = 模型美元成本 × 实时 token 用量 × 积分换算比例 × 价格倍率</p>
                    <p>• 联网总成本 = 模型搜索成本 + 站内联网附加积分</p>
                    <p>• 旧的 `input/output/web_search` 系统设置仅作历史兼容，不再作为实时计费真相</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
