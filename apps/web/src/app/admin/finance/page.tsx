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
  const apiStats = data?.apiStats ?? { totalRequests: 0, totalConversations: 0, messagesThisMonth: 0, messagesThisWeek: 0 };
  const modelStats = data?.modelStats ?? [];
  const financeOverview = data?.financeOverview ?? { estimatedRevenue: 0, creditsConsumed: 0, creditsPurchased: 0, creditsGiven: 0, netCreditsFlow: 0 };
  const creditsRules = data?.creditsRules ?? { inputCreditsPerK: 1, outputCreditsPerK: 3, webSearchCredits: 5, newUserCredits: 100 };

  // Calculate profit (revenue - estimated cost based on consumption)
  const estimatedProfit = financeOverview.estimatedRevenue - (financeOverview.creditsConsumed * 0.01); // Rough cost estimation

  return (
    <div className="p-8 overflow-auto">
      {/* Page Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
            财务统计
          </h1>
          <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
            平台收入、成本与 API 使用统计
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

      <Tabs defaultValue="overview" className="w-full">
        <TabsList
          className="mb-6"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
        >
          <TabsTrigger
            value="overview"
            className="data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black"
          >
            <CircleDollarSign className="h-4 w-4 mr-2" />
            收入概览
          </TabsTrigger>
          <TabsTrigger
            value="api"
            className="data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black"
          >
            <Activity className="h-4 w-4 mr-2" />
            API 统计
          </TabsTrigger>
          <TabsTrigger
            value="models"
            className="data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black"
          >
            <Cpu className="h-4 w-4 mr-2" />
            模型渠道
          </TabsTrigger>
          <TabsTrigger
            value="rules"
            className="data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black"
          >
            <Settings className="h-4 w-4 mr-2" />
            积分规则
          </TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview">
          {/* Finance Overview Cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-xl bg-emerald-500/20">
                    <PiggyBank className="h-6 w-6 text-emerald-400" />
                  </div>
                  <div>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>预估收入</p>
                    <p className="text-2xl font-bold text-emerald-400">
                      ${(financeOverview.estimatedRevenue / 100).toFixed(2)}
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
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>积分消耗</p>
                    <p className="text-2xl font-bold text-rose-400">
                      {financeOverview.creditsConsumed.toLocaleString()}
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
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>积分购买</p>
                    <p className="text-2xl font-bold text-blue-400">
                      {financeOverview.creditsPurchased.toLocaleString()}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-6">
                <div className="flex items-center gap-4">
                  <div className={`p-3 rounded-xl ${estimatedProfit >= 0 ? 'bg-emerald-500/20' : 'bg-rose-500/20'}`}>
                    <DollarSign className={`h-6 w-6 ${estimatedProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`} />
                  </div>
                  <div>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>预估盈利</p>
                    <p className={`text-2xl font-bold ${estimatedProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      ${(estimatedProfit / 100).toFixed(2)}
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
                          ${(pkg.price / 100).toFixed(2)}
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
            </CardContent>
          </Card>
        </TabsContent>

        {/* API Statistics Tab */}
        <TabsContent value="api">
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

          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                <Activity className="h-5 w-5" />
                API 使用说明
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  API 统计基于消息记录估算。详细的 Token 使用量和成本追踪需要在消息保存时记录具体的 Token 消耗数据。
                </p>
                <ul className="mt-3 space-y-2 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                  <li>• 总请求数 = AI 回复消息数量</li>
                  <li>• 总对话数 = 创建的对话数量</li>
                  <li>• 实际 Token 使用需要集成 API 响应中的 usage 数据</li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Model Channel Statistics Tab */}
        <TabsContent value="models">
          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                <Cpu className="h-5 w-5" />
                模型渠道统计
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
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
                    <TableRow key={model.id}>
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
            </CardContent>
          </Card>
        </TabsContent>

        {/* Credits Rules Tab */}
        <TabsContent value="rules">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                  <Coins className="h-5 w-5" />
                  积分换算规则
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
                        <p className="font-medium" style={{ color: 'var(--text-primary)' }}>输入 Token 费率</p>
                        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>每 1K Token 消耗积分</p>
                      </div>
                    </div>
                    <Badge className="bg-blue-500/20 text-blue-400 text-lg px-3">
                      {typeof creditsRules.inputCreditsPerK === 'number' ? creditsRules.inputCreditsPerK : 1}
                    </Badge>
                  </div>

                  <div className="flex justify-between items-center p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-purple-500/20">
                        <TrendingDown className="h-4 w-4 text-purple-400" />
                      </div>
                      <div>
                        <p className="font-medium" style={{ color: 'var(--text-primary)' }}>输出 Token 费率</p>
                        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>每 1K Token 消耗积分</p>
                      </div>
                    </div>
                    <Badge className="bg-purple-500/20 text-purple-400 text-lg px-3">
                      {typeof creditsRules.outputCreditsPerK === 'number' ? creditsRules.outputCreditsPerK : 3}
                    </Badge>
                  </div>

                  <div className="flex justify-between items-center p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-emerald-500/20">
                        <Globe className="h-4 w-4 text-emerald-400" />
                      </div>
                      <div>
                        <p className="font-medium" style={{ color: 'var(--text-primary)' }}>联网搜索费用</p>
                        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>每次搜索消耗积分</p>
                      </div>
                    </div>
                    <Badge className="bg-emerald-500/20 text-emerald-400 text-lg px-3">
                      {typeof creditsRules.webSearchCredits === 'number' ? creditsRules.webSearchCredits : 5}
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                  <Users className="h-5 w-5" />
                  新用户福利
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
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
                      {typeof creditsRules.newUserCredits === 'number' ? creditsRules.newUserCredits : 100}
                    </Badge>
                  </div>
                </div>

                <div className="mt-6 p-4 rounded-lg border" style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-primary)' }}>
                  <h4 className="font-medium mb-2" style={{ color: 'var(--text-primary)' }}>计算示例</h4>
                  <div className="text-sm space-y-1" style={{ color: 'var(--text-secondary)' }}>
                    <p>• 发送 1000 Token 输入 = {typeof creditsRules.inputCreditsPerK === 'number' ? creditsRules.inputCreditsPerK : 1} 积分</p>
                    <p>• 接收 1000 Token 输出 = {typeof creditsRules.outputCreditsPerK === 'number' ? creditsRules.outputCreditsPerK : 3} 积分</p>
                    <p>• 一次完整对话(1K 输入 + 1K 输出) ≈ {(typeof creditsRules.inputCreditsPerK === 'number' ? creditsRules.inputCreditsPerK : 1) + (typeof creditsRules.outputCreditsPerK === 'number' ? creditsRules.outputCreditsPerK : 3)} 积分</p>
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
