'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import {
  Activity, MessageSquare, MessagesSquare, Bot,
  RefreshCw, Calendar, TrendingUp, Users, Zap,
  Clock, DollarSign, Database, Shield, AlertTriangle,
  CheckCircle, XCircle, Cpu, HardDrive, Gauge,
  ArrowUpRight, ArrowDownRight, Coins, Server
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
import AdminErrorState from '@/components/admin/AdminErrorState';
import { formatUsd } from '@/lib/currency';

type TimeRange = '7d' | '14d' | '30d';
type HealthStatus = 'healthy' | 'warning' | 'critical';

const healthConfig: Record<HealthStatus, { label: string; color: string; bgColor: string; icon: React.ElementType }> = {
  healthy: { label: '健康', color: 'text-emerald-400', bgColor: 'bg-emerald-500/20', icon: CheckCircle },
  warning: { label: '警告', color: 'text-amber-400', bgColor: 'bg-amber-500/20', icon: AlertTriangle },
  critical: { label: '异常', color: 'text-red-400', bgColor: 'bg-red-500/20', icon: XCircle },
};

const formatNumber = (num: number) => {
  if (num >= 1000000) return `${(num / 1000000).toFixed(2)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toString();
};

const formatCost = (cost: number) => {
  if (cost < 0.01) return `$${cost.toFixed(6)}`;
  if (cost < 1) return `$${cost.toFixed(4)}`;
  return formatUsd(cost);
};

export default function AdminPerformancePage() {
  const [timeRange, setTimeRange] = useState<TimeRange>('14d');

  const { data, isLoading, error, refetch } = trpc.admin.getPerformanceStats.useQuery({
    timeRange,
  });

  if (error && !data) {
    return <AdminErrorState error={error} onRetry={() => refetch()} />;
  }

  const isInitialLoading = isLoading && !data;

  const conversations = data?.conversations ?? { total: 0, today: 0, thisWeek: 0, thisMonth: 0, inRange: 0 };
  const messages = data?.messages ?? {
    total: 0, userMessages: 0, assistantMessages: 0,
    today: 0, thisWeek: 0, thisMonth: 0, inRange: 0
  };
  const modelUsage = data?.modelUsage ?? [];
  const dailyChart = data?.dailyChart ?? [];
  const averages = data?.averages ?? { messagesPerConversation: 0, conversationsPerDay: 0, messagesPerDay: 0, requestsPerDay: 0 };
  const aiPerformance = data?.aiPerformance ?? {
    totalRequests: 0, rangeRequests: 0, avgResponseTime: 0, p95ResponseTime: 0,
    errorRate: 0, cacheHitRate: 0, healthStatus: 'healthy' as HealthStatus
  };
  const tokenUsage = data?.tokenUsage ?? {
    inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0
  };
  const costStats = data?.costStats ?? {
    totalCost: 0, avgCostPerRequest: 0, cacheSavings: 0, estimatedMonthly: 0
  };

  const healthInfo = healthConfig[aiPerformance.healthStatus];
  const HealthIcon = healthInfo.icon;

  return (
    <div className="p-8 overflow-auto" data-testid="admin-performance-page">
      {/* Page Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
              AI 性能监控
            </h1>
            <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
              实时监控 AI 服务性能和资源使用情况
            </p>
          </div>
          {/* Health Status Badge */}
          <Badge className={`${healthInfo.bgColor} ${healthInfo.color} px-3 py-1 text-sm`}>
            <HealthIcon className="h-4 w-4 mr-1" />
            系统 {healthInfo.label}
          </Badge>
        </div>
        <div className="flex items-center gap-3">
          {isInitialLoading ? (
            <Badge
              variant="secondary"
              className="border border-[var(--border-primary)] bg-[var(--bg-secondary)] text-[var(--text-tertiary)]"
            >
              正在加载性能数据...
            </Badge>
          ) : null}
          {/* Time Range Selector */}
          <Select value={timeRange} onValueChange={(v) => setTimeRange(v as TimeRange)}>
            <SelectTrigger className="w-[140px] bg-[var(--bg-secondary)] border-[var(--border-primary)] text-[var(--text-primary)]">
              <Calendar className="h-4 w-4 mr-2 text-[var(--text-tertiary)]" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <SelectItem value="7d">近 7 天</SelectItem>
              <SelectItem value="14d">近 14 天</SelectItem>
              <SelectItem value="30d">近 30 天</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            onClick={() => refetch()}
            className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            {isInitialLoading ? '加载中...' : '刷新数据'}
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <Tabs data-testid="admin-performance-tabs" defaultValue="overview" className="space-y-6">
        <TabsList className="bg-[var(--bg-tertiary)]">
          <TabsTrigger value="overview" className="data-[state=active]:bg-[var(--bg-secondary)]">
            <Gauge className="h-4 w-4 mr-2" />
            性能概览
          </TabsTrigger>
          <TabsTrigger value="tokens" className="data-[state=active]:bg-[var(--bg-secondary)]">
            <Database className="h-4 w-4 mr-2" />
            Token 统计
          </TabsTrigger>
          <TabsTrigger value="costs" className="data-[state=active]:bg-[var(--bg-secondary)]">
            <DollarSign className="h-4 w-4 mr-2" />
            成本统计
          </TabsTrigger>
          <TabsTrigger value="models" className="data-[state=active]:bg-[var(--bg-secondary)]">
            <Bot className="h-4 w-4 mr-2" />
            模型使用
          </TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-6">
          {/* Performance Cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card data-testid="admin-performance-overview-requests" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总请求数</p>
                    <p className="text-2xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                      {formatNumber(aiPerformance.totalRequests)}
                    </p>
                    <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                      {timeRange === '7d' ? '本周' : timeRange === '14d' ? '近两周' : '本月'}: {formatNumber(aiPerformance.rangeRequests)}
                    </p>
                  </div>
                  <div className="p-3 rounded-xl bg-[var(--color-primary-20)]">
                    <Server className="h-6 w-6 text-[var(--color-primary)]" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card data-testid="admin-performance-overview-latency" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>平均响应时间</p>
                    <p className="text-2xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                      {aiPerformance.avgResponseTime}ms
                    </p>
                    <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                      P95: {aiPerformance.p95ResponseTime}ms
                    </p>
                  </div>
                  <div className="p-3 rounded-xl bg-blue-500/20">
                    <Clock className="h-6 w-6 text-blue-400" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card data-testid="admin-performance-overview-cache" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>缓存命中率</p>
                    <p className="text-2xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                      {aiPerformance.cacheHitRate}%
                    </p>
                    <div className="flex items-center gap-1 mt-1">
                      <ArrowUpRight className="h-3 w-3 text-emerald-400" />
                      <span className="text-xs text-emerald-400">节省成本</span>
                    </div>
                  </div>
                  <div className="p-3 rounded-xl bg-emerald-500/20">
                    <HardDrive className="h-6 w-6 text-emerald-400" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card data-testid="admin-performance-overview-errors" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>错误率</p>
                    <p className="text-2xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                      {aiPerformance.errorRate}%
                    </p>
                    <div className="flex items-center gap-1 mt-1">
                      {aiPerformance.errorRate < 1 ? (
                        <>
                          <CheckCircle className="h-3 w-3 text-emerald-400" />
                          <span className="text-xs text-emerald-400">正常</span>
                        </>
                      ) : (
                        <>
                          <AlertTriangle className="h-3 w-3 text-amber-400" />
                          <span className="text-xs text-amber-400">需关注</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className={`p-3 rounded-xl ${aiPerformance.errorRate < 1 ? 'bg-emerald-500/20' : 'bg-amber-500/20'}`}>
                    <Shield className={`h-6 w-6 ${aiPerformance.errorRate < 1 ? 'text-emerald-400' : 'text-amber-400'}`} />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Activity Stats */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2" style={{ color: 'var(--text-tertiary)' }}>
                  <MessagesSquare className="h-4 w-4" />
                  对话统计
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>今日对话</span>
                    <Badge className="bg-blue-500/20 text-blue-400">{conversations.today}</Badge>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>本周对话</span>
                    <Badge className="bg-purple-500/20 text-purple-400">{conversations.thisWeek}</Badge>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>本月对话</span>
                    <Badge className="bg-amber-500/20 text-amber-400">{conversations.thisMonth}</Badge>
                  </div>
                  <div className="flex justify-between items-center pt-2 border-t border-[var(--border-primary)]">
                    <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>日均对话</span>
                    <span className="text-lg font-bold" style={{ color: 'var(--color-primary)' }}>
                      {averages.conversationsPerDay}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2" style={{ color: 'var(--text-tertiary)' }}>
                  <MessageSquare className="h-4 w-4" />
                  消息统计
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <Users className="h-4 w-4 text-emerald-400" />
                      <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>用户消息</span>
                    </div>
                    <span className="text-emerald-400">{formatNumber(messages.userMessages)}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <Bot className="h-4 w-4 text-blue-400" />
                      <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>AI 回复</span>
                    </div>
                    <span className="text-blue-400">{formatNumber(messages.assistantMessages)}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>今日消息</span>
                    <Badge className="bg-[var(--color-primary-20)] text-[var(--color-primary)]">{messages.today}</Badge>
                  </div>
                  <div className="flex justify-between items-center pt-2 border-t border-[var(--border-primary)]">
                    <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>日均消息</span>
                    <span className="text-lg font-bold" style={{ color: 'var(--color-primary)' }}>
                      {averages.messagesPerDay}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2" style={{ color: 'var(--text-tertiary)' }}>
                  <Activity className="h-4 w-4" />
                  性能指标
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>平均消息/对话</span>
                    <span style={{ color: 'var(--text-primary)' }}>{averages.messagesPerConversation}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>日均请求</span>
                    <span style={{ color: 'var(--text-primary)' }}>{averages.requestsPerDay}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>总对话数</span>
                    <span style={{ color: 'var(--text-primary)' }}>{formatNumber(conversations.total)}</span>
                  </div>
                  <div className="flex justify-between items-center pt-2 border-t border-[var(--border-primary)]">
                    <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>总消息数</span>
                    <span className="text-lg font-bold" style={{ color: 'var(--color-primary)' }}>
                      {formatNumber(messages.total)}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Activity Chart */}
          <Card data-testid="admin-performance-activity-trend" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                <TrendingUp className="h-5 w-5" />
                {timeRange === '7d' ? '近7天' : timeRange === '14d' ? '近14天' : '近30天'}活动趋势
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div className="flex items-center gap-4 text-xs mb-4" style={{ color: 'var(--text-tertiary)' }}>
                  <div className="flex items-center gap-1">
                    <div className="w-3 h-3 bg-[var(--color-primary)] rounded"></div>
                    <span>对话</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="w-3 h-3 bg-blue-400 rounded"></div>
                    <span>消息</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="w-3 h-3 bg-emerald-400 rounded"></div>
                    <span>请求</span>
                  </div>
                </div>
                <div className="h-40 flex items-end gap-1">
                  {dailyChart.map((day, index) => {
                    const maxValue = Math.max(
                      ...dailyChart.map(d => Math.max((d.conversations || 0) * 10, d.messages || 0, (d.requests || 0) * 5))
                    ) || 1;
                    return (
                      <div key={index} className="flex-1 flex flex-col gap-0.5" title={`${day.date}: ${day.conversations}对话, ${day.messages}消息, ${day.requests}请求`}>
                        <div
                          className="bg-[var(--color-primary)] rounded-t"
                          style={{ height: `${(((day.conversations || 0) * 10) / maxValue) * 100}%`, minHeight: (day.conversations || 0) > 0 ? '4px' : '0' }}
                        />
                        <div
                          className="bg-blue-400"
                          style={{ height: `${((day.messages || 0) / maxValue) * 100}%`, minHeight: (day.messages || 0) > 0 ? '2px' : '0' }}
                        />
                        <div
                          className="bg-emerald-400 rounded-b"
                          style={{ height: `${(((day.requests || 0) * 5) / maxValue) * 100}%`, minHeight: (day.requests || 0) > 0 ? '2px' : '0' }}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-between text-xs" style={{ color: 'var(--text-disabled)' }}>
                  <span>{dailyChart[0]?.date?.slice(5) || ''}</span>
                  <span>{dailyChart[dailyChart.length - 1]?.date?.slice(5) || ''}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Token Usage Tab */}
        <TabsContent value="tokens" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>输入 Tokens</p>
                    <p className="text-2xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                      {formatNumber(tokenUsage.inputTokens)}
                    </p>
                  </div>
                  <div className="p-3 rounded-xl bg-blue-500/20">
                    <ArrowUpRight className="h-6 w-6 text-blue-400" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>输出 Tokens</p>
                    <p className="text-2xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                      {formatNumber(tokenUsage.outputTokens)}
                    </p>
                  </div>
                  <div className="p-3 rounded-xl bg-purple-500/20">
                    <ArrowDownRight className="h-6 w-6 text-purple-400" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>缓存读取</p>
                    <p className="text-2xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                      {formatNumber(tokenUsage.cacheReadTokens)}
                    </p>
                  </div>
                  <div className="p-3 rounded-xl bg-emerald-500/20">
                    <HardDrive className="h-6 w-6 text-emerald-400" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>缓存创建</p>
                    <p className="text-2xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                      {formatNumber(tokenUsage.cacheCreationTokens)}
                    </p>
                  </div>
                  <div className="p-3 rounded-xl bg-amber-500/20">
                    <Database className="h-6 w-6 text-amber-400" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Token Distribution */}
          <Card data-testid="admin-performance-token-summary" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader>
              <CardTitle style={{ color: 'var(--text-primary)' }}>Token 使用分布</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div>
                  <div className="flex justify-between mb-2">
                    <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>输入 Tokens</span>
                    <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                      {tokenUsage.totalTokens > 0 ? ((tokenUsage.inputTokens / tokenUsage.totalTokens) * 100).toFixed(1) : 0}%
                    </span>
                  </div>
                  <div className="h-3 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-400 rounded-full"
                      style={{ width: `${tokenUsage.totalTokens > 0 ? (tokenUsage.inputTokens / tokenUsage.totalTokens) * 100 : 0}%` }}
                    />
                  </div>
                </div>
                <div>
                  <div className="flex justify-between mb-2">
                    <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>输出 Tokens</span>
                    <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                      {tokenUsage.totalTokens > 0 ? ((tokenUsage.outputTokens / tokenUsage.totalTokens) * 100).toFixed(1) : 0}%
                    </span>
                  </div>
                  <div className="h-3 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-purple-400 rounded-full"
                      style={{ width: `${tokenUsage.totalTokens > 0 ? (tokenUsage.outputTokens / tokenUsage.totalTokens) * 100 : 0}%` }}
                    />
                  </div>
                </div>
                <div className="pt-4 border-t border-[var(--border-primary)]">
                  <div className="flex justify-between items-center">
                    <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>总计 Tokens</span>
                    <span className="text-xl font-bold" style={{ color: 'var(--color-primary)' }}>
                      {formatNumber(tokenUsage.totalTokens)}
                    </span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Cost Stats Tab */}
        <TabsContent value="costs" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总成本</p>
                    <p className="text-2xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                      {formatCost(costStats.totalCost)}
                    </p>
                    <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                      {timeRange === '7d' ? '近7天' : timeRange === '14d' ? '近14天' : '近30天'}
                    </p>
                  </div>
                  <div className="p-3 rounded-xl bg-[var(--color-primary-20)]">
                    <DollarSign className="h-6 w-6 text-[var(--color-primary)]" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>平均每次请求</p>
                    <p className="text-2xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                      {formatCost(costStats.avgCostPerRequest)}
                    </p>
                  </div>
                  <div className="p-3 rounded-xl bg-blue-500/20">
                    <Coins className="h-6 w-6 text-blue-400" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>缓存节省</p>
                    <p className="text-2xl font-bold mt-1 text-emerald-400">
                      -{formatCost(costStats.cacheSavings)}
                    </p>
                  </div>
                  <div className="p-3 rounded-xl bg-emerald-500/20">
                    <TrendingUp className="h-6 w-6 text-emerald-400" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>预估月成本</p>
                    <p className="text-2xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                      {formatCost(costStats.estimatedMonthly)}
                    </p>
                  </div>
                  <div className="p-3 rounded-xl bg-purple-500/20">
                    <Calendar className="h-6 w-6 text-purple-400" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Cost Breakdown */}
          <Card data-testid="admin-performance-models-section" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader>
              <CardTitle style={{ color: 'var(--text-primary)' }}>成本明细</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-blue-500/20">
                      <ArrowUpRight className="h-4 w-4 text-blue-400" />
                    </div>
                    <div>
                      <p className="font-medium" style={{ color: 'var(--text-primary)' }}>输入 Token 成本</p>
                      <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{formatNumber(tokenUsage.inputTokens)} tokens</p>
                    </div>
                  </div>
                  <span className="font-mono text-lg" style={{ color: 'var(--text-primary)' }}>
                    ~{formatCost(costStats.totalCost * 0.3)}
                  </span>
                </div>
                <div className="flex items-center justify-between p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-purple-500/20">
                      <ArrowDownRight className="h-4 w-4 text-purple-400" />
                    </div>
                    <div>
                      <p className="font-medium" style={{ color: 'var(--text-primary)' }}>输出 Token 成本</p>
                      <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{formatNumber(tokenUsage.outputTokens)} tokens</p>
                    </div>
                  </div>
                  <span className="font-mono text-lg" style={{ color: 'var(--text-primary)' }}>
                    ~{formatCost(costStats.totalCost * 0.7)}
                  </span>
                </div>
                <div className="flex items-center justify-between p-4 rounded-lg border-2 border-dashed border-emerald-500/30" style={{ background: 'var(--bg-tertiary)' }}>
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-emerald-500/20">
                      <HardDrive className="h-4 w-4 text-emerald-400" />
                    </div>
                    <div>
                      <p className="font-medium text-emerald-400">缓存节省</p>
                      <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>命中率 {aiPerformance.cacheHitRate}%</p>
                    </div>
                  </div>
                  <span className="font-mono text-lg text-emerald-400">
                    -{formatCost(costStats.cacheSavings)}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Model Usage Tab */}
        <TabsContent value="models" className="space-y-6">
          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                <Bot className="h-5 w-5" />
                AI 模型使用情况
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>模型名称</TableHead>
                    <TableHead>提供商</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>对话数</TableHead>
                    <TableHead>输入成本</TableHead>
                    <TableHead>输出成本</TableHead>
                    <TableHead>占比</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {modelUsage.map((model) => {
                    const percentage = conversations.total > 0
                      ? ((model.conversationCount / conversations.total) * 100).toFixed(1)
                      : '0';
                    return (
                      <TableRow key={model.id} data-testid={`admin-performance-model-row-${model.id}`}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <div
                              className="p-2 rounded-lg"
                              style={{ background: 'var(--bg-tertiary)' }}
                            >
                              <Bot className="h-4 w-4 text-[var(--color-primary)]" />
                            </div>
                            <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                              {model.name}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge className="bg-blue-500/20 text-blue-400">
                            {model.provider || '未知'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge className={model.isActive === 'true' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-gray-500/20 text-gray-400'}>
                            {model.isActive === 'true' ? '启用' : '禁用'}
                          </Badge>
                        </TableCell>
                        <TableCell style={{ color: 'var(--text-primary)' }}>
                          {model.conversationCount.toLocaleString()}
                        </TableCell>
                        <TableCell style={{ color: 'var(--text-tertiary)' }}>
                          ${(model.inputTokenCost / 1000000).toFixed(2)}/M
                        </TableCell>
                        <TableCell style={{ color: 'var(--text-tertiary)' }}>
                          ${(model.outputTokenCost / 1000000).toFixed(2)}/M
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                              <div
                                className="h-full bg-[var(--color-primary)] rounded-full"
                                style={{ width: `${percentage}%` }}
                              />
                            </div>
                            <span className="text-xs w-12 text-right" style={{ color: 'var(--text-tertiary)' }}>
                              {percentage}%
                            </span>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {modelUsage.length === 0 && (
                    <TableRow>
                      <TableCell
                        data-testid="admin-performance-models-empty"
                        colSpan={7}
                        className="text-center py-12"
                        style={{ color: 'var(--text-disabled)' }}
                      >
                        暂无模型使用数据
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
