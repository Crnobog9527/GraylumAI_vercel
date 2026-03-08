'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import {
  DollarSign, TrendingUp, Activity, Cpu, Users, Clock,
  BarChart3, PieChart, RefreshCw, Download, Zap, Database
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
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import AdminLoadingState from '@/components/admin/AdminLoadingState';
import AdminErrorState from '@/components/admin/AdminErrorState';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart as RechartsPieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';

const COLORS = ['#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#ec4899'];

function formatCredits(credits: number): string {
  if (credits >= 10000) {
    return `${(credits / 1000).toFixed(1)}K`;
  }
  return credits.toLocaleString();
}

function formatTooltipCredits(
  value: number | string | ReadonlyArray<number | string> | undefined
): string {
  const normalizedValue = Array.isArray(value) ? value[0] : value;

  if (typeof normalizedValue === 'number') {
    return formatCredits(normalizedValue);
  }

  const numericValue = Number(normalizedValue);
  return Number.isFinite(numericValue) ? formatCredits(numericValue) : '0';
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function formatDateTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function StatCard({
  title,
  value,
  subValue,
  icon: Icon,
  trend,
}: {
  title: string;
  value: string;
  subValue?: string;
  icon: React.ElementType;
  trend?: 'up' | 'down' | 'neutral';
}) {
  return (
    <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{title}</p>
            <p className="text-2xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>{value}</p>
            {subValue && (
              <p className="text-xs mt-1" style={{ color: 'var(--text-disabled)' }}>{subValue}</p>
            )}
          </div>
          <div className={`p-3 rounded-xl ${
            trend === 'up' ? 'bg-emerald-500/20' :
            trend === 'down' ? 'bg-red-500/20' :
            'bg-[var(--color-primary-20)]'
          }`}>
            <Icon className={`h-6 w-6 ${
              trend === 'up' ? 'text-emerald-400' :
              trend === 'down' ? 'text-red-400' :
              'text-[var(--color-primary)]'
            }`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CostOverviewTab() {
  const [days, setDays] = useState<number>(7);

  const { data: overview, isLoading: overviewLoading } = trpc.costs.getOverview.useQuery({});
  const { data: trend, isLoading: trendLoading } = trpc.costs.getCostTrend.useQuery({ days });
  const { data: distribution, isLoading: distLoading } = trpc.costs.getModelDistribution.useQuery({ days });
  const { data: topUsers, isLoading: usersLoading } = trpc.costs.getTopUsers.useQuery({ days, limit: 10 });
  const { data: cacheEfficiency } = trpc.costs.getCacheEfficiency.useQuery({ days });

  if (overviewLoading) {
    return <AdminLoadingState message="加载成本数据..." />;
  }

  return (
    <div className="space-y-8">
      {/* 统计卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          title="今日消耗"
          value={formatCredits(overview?.todayCost ?? 0)}
          subValue={`${overview?.todayCalls ?? 0} 次调用`}
          icon={DollarSign}
        />
        <StatCard
          title="本月累计"
          value={formatCredits(overview?.monthCost ?? 0)}
          subValue={`${overview?.monthCalls ?? 0} 次调用`}
          icon={TrendingUp}
        />
        <StatCard
          title="平均成本/次"
          value={formatCredits(overview?.avgCostPerCall ?? 0)}
          icon={Activity}
        />
        <StatCard
          title="缓存命中率"
          value={`${cacheEfficiency?.hitRate ?? 0}%`}
          subValue={`节省 ${formatCredits(cacheEfficiency?.savedCredits ?? 0)} 积分`}
          icon={Zap}
          trend="up"
        />
      </div>

      {/* 时间范围选择 */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>成本趋势</h3>
        <Select value={days.toString()} onValueChange={(v) => setDays(parseInt(v))}>
          <SelectTrigger
            className="w-32"
            style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-primary)' }}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}>
            <SelectItem value="7">近 7 天</SelectItem>
            <SelectItem value="14">近 14 天</SelectItem>
            <SelectItem value="30">近 30 天</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* 成本趋势图 */}
      <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
        <CardContent className="p-6">
          {trendLoading ? (
            <div className="h-64 flex items-center justify-center">
              <RefreshCw className="h-6 w-6 animate-spin text-zinc-400" />
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={trend ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatDate}
                  stroke="#71717a"
                  fontSize={12}
                />
                <YAxis
                  stroke="#71717a"
                  fontSize={12}
                  tickFormatter={(v) => formatCredits(v)}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#27272a',
                    border: '1px solid #3f3f46',
                    borderRadius: '8px',
                  }}
                  labelStyle={{ color: '#a1a1aa' }}
                  formatter={(value) => [formatTooltipCredits(value), '积分']}
                  labelFormatter={(label) => `日期: ${label}`}
                />
                <Line
                  type="monotone"
                  dataKey="cost"
                  stroke="#8b5cf6"
                  strokeWidth={2}
                  dot={{ fill: '#8b5cf6', strokeWidth: 0 }}
                  activeDot={{ r: 6, fill: '#8b5cf6' }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* 模型分布和高消耗用户 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 模型分布饼图 */}
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <PieChart className="h-5 w-5" style={{ color: 'var(--color-primary)' }} />
              模型使用分布
            </CardTitle>
          </CardHeader>
          <CardContent>
            {distLoading ? (
              <div className="h-48 flex items-center justify-center">
                <RefreshCw className="h-6 w-6 animate-spin text-zinc-400" />
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <RechartsPieChart>
                  <Pie
                    data={distribution ?? []}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                    dataKey="cost"
                    nameKey="modelName"
                    label={({ percent }) => `${Math.round((percent ?? 0) * 100)}%`}
                    labelLine={false}
                  >
                    {(distribution ?? []).map((_, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Legend
                    formatter={(value) => <span className="text-zinc-300 text-sm">{value}</span>}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#27272a',
                      border: '1px solid #3f3f46',
                      borderRadius: '8px',
                    }}
                    formatter={(value) => [formatTooltipCredits(value), '积分']}
                  />
                </RechartsPieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* 高消耗用户 */}
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <Users className="h-5 w-5 text-cyan-400" />
              高消耗用户 TOP 10
            </CardTitle>
          </CardHeader>
          <CardContent>
            {usersLoading ? (
              <div className="h-48 flex items-center justify-center">
                <RefreshCw className="h-6 w-6 animate-spin" style={{ color: 'var(--text-tertiary)' }} />
              </div>
            ) : (
              <div className="space-y-3 max-h-[240px] overflow-y-auto">
                {(topUsers ?? []).map((user, index) => (
                  <div
                    key={user.userId}
                    className="flex items-center justify-between p-3 rounded-lg"
                    style={{ background: 'var(--bg-tertiary)' }}
                  >
                    <div className="flex items-center gap-3">
                      <span className={`w-7 h-7 flex items-center justify-center rounded-full text-xs font-bold ${
                        index === 0 ? 'bg-amber-500 text-black' :
                        index === 1 ? 'bg-zinc-400 text-black' :
                        index === 2 ? 'bg-amber-700 text-white' :
                        'bg-zinc-600 text-zinc-300'
                      }`}>
                        {index + 1}
                      </span>
                      <div>
                        <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{user.nickname || user.email}</p>
                        <p className="text-xs" style={{ color: 'var(--text-disabled)' }}>{user.totalCalls} 次调用</p>
                      </div>
                    </div>
                    <span className="text-sm font-medium" style={{ color: 'var(--color-primary)' }}>
                      {formatCredits(user.totalCost)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function UsageLogsTab() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<'all' | 'success' | 'failed'>('all');
  const pageSize = 20;

  const { data, isLoading, refetch } = trpc.costs.getUsageLogs.useQuery({
    page,
    pageSize,
    status,
  });

  const totalPages = Math.ceil((data?.total ?? 0) / pageSize);

  return (
    <div className="space-y-4">
      {/* 筛选器 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Select value={status} onValueChange={(v) => { setStatus(v as typeof status); setPage(1); }}>
            <SelectTrigger className="w-32 bg-zinc-800 border-zinc-700">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="success">成功</SelectItem>
              <SelectItem value="failed">失败</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button data-testid="admin-usage-logs-refresh" variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4 mr-2" />
          刷新
        </Button>
      </div>

      {/* 日志表格 */}
      <Card className="bg-zinc-800/50 border-zinc-700">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="h-96 flex items-center justify-center">
              <RefreshCw className="h-6 w-6 animate-spin text-zinc-400" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-zinc-700">
                  <TableHead className="text-zinc-400">时间</TableHead>
                  <TableHead className="text-zinc-400">用户</TableHead>
                  <TableHead className="text-zinc-400">模型</TableHead>
                  <TableHead className="text-zinc-400">状态</TableHead>
                  <TableHead className="text-zinc-400">延迟</TableHead>
                  <TableHead className="text-zinc-400">提示词</TableHead>
                  <TableHead className="text-zinc-400">路由原因</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.logs ?? []).map((log) => (
                  <TableRow key={log.id} data-testid={`admin-usage-log-row-${log.id}`} className="border-zinc-700">
                    <TableCell className="text-zinc-300 text-sm">
                      {formatDateTime(log.createdAt)}
                    </TableCell>
                    <TableCell className="text-zinc-300 text-sm">
                      {log.userEmail}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {log.modelId.split('-').slice(-2).join('-')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className={log.status === 'success'
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : 'bg-red-500/20 text-red-400'
                      }>
                        {log.status === 'success' ? '成功' : '失败'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-zinc-400 text-sm">
                      {log.latencyMs}ms
                    </TableCell>
                    <TableCell data-testid="admin-usage-log-prompt-name" className="text-zinc-400 text-sm max-w-[180px] truncate">
                      {log.promptName || '-'}
                    </TableCell>
                    <TableCell className="text-zinc-500 text-sm max-w-[200px] truncate">
                      {log.routingReason || '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-zinc-500">
            共 {data?.total ?? 0} 条记录
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1}
              onClick={() => setPage(p => p - 1)}
            >
              上一页
            </Button>
            <span className="text-sm text-zinc-400">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage(p => p + 1)}
            >
              下一页
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function TokenStatsTab() {
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const { data, isLoading, refetch } = trpc.costs.getTokenStats.useQuery({
    page,
    pageSize,
  });

  const totalPages = Math.ceil((data?.total ?? 0) / pageSize);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4 mr-2" />
          刷新
        </Button>
      </div>

      {/* Token 统计表格 */}
      <Card className="bg-zinc-800/50 border-zinc-700">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="h-96 flex items-center justify-center">
              <RefreshCw className="h-6 w-6 animate-spin text-zinc-400" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-zinc-700">
                  <TableHead className="text-zinc-400">时间</TableHead>
                  <TableHead className="text-zinc-400">模型</TableHead>
                  <TableHead className="text-zinc-400 text-right">输入 Tokens</TableHead>
                  <TableHead className="text-zinc-400 text-right">输出 Tokens</TableHead>
                  <TableHead className="text-zinc-400 text-right">缓存 Tokens</TableHead>
                  <TableHead className="text-zinc-400 text-right">积分消耗</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.stats ?? []).map((stat) => (
                  <TableRow key={stat.id} className="border-zinc-700">
                    <TableCell className="text-zinc-300 text-sm">
                      {formatDateTime(stat.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {stat.modelUsed.split('-').slice(-2).join('-')}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-zinc-300">
                      {stat.inputTokens.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right text-zinc-300">
                      {stat.outputTokens.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      {stat.cachedTokens > 0 ? (
                        <span className="text-emerald-400">{stat.cachedTokens.toLocaleString()}</span>
                      ) : (
                        <span className="text-zinc-500">0</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-purple-400 font-medium">
                      {stat.totalCredits.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-zinc-500">
            共 {data?.total ?? 0} 条记录
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1}
              onClick={() => setPage(p => p - 1)}
            >
              上一页
            </Button>
            <span className="text-sm text-zinc-400">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage(p => p + 1)}
            >
              下一页
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AICostsPage() {
  return (
    <div className="p-8 space-y-8 overflow-auto">
      {/* 页面标题 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-3" style={{ color: 'var(--text-primary)' }}>
            <BarChart3 className="h-8 w-8" style={{ color: 'var(--color-primary)' }} />
            AI 成本监控
          </h1>
          <p className="mt-2" style={{ color: 'var(--text-tertiary)' }}>
            追踪 AI 调用成本、Token 使用和模型分布
          </p>
        </div>
      </div>

      {/* 选项卡 */}
      <Tabs defaultValue="overview" className="space-y-6">
        <TabsList
          className="mb-2"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
        >
          <TabsTrigger
            value="overview"
            className="data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black"
          >
            <TrendingUp className="h-4 w-4 mr-2" />
            成本概览
          </TabsTrigger>
          <TabsTrigger
            value="logs"
            className="data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black"
          >
            <Activity className="h-4 w-4 mr-2" />
            AI 调用日志
          </TabsTrigger>
          <TabsTrigger
            value="tokens"
            className="data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black"
          >
            <Database className="h-4 w-4 mr-2" />
            Token 统计
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <CostOverviewTab />
        </TabsContent>

        <TabsContent value="logs">
          <UsageLogsTab />
        </TabsContent>

        <TabsContent value="tokens">
          <TokenStatsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
