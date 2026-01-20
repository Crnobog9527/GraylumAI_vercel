'use client';

import { trpc } from '@/trpc/client';
import {
  Activity, MessageSquare, MessagesSquare, Bot,
  RefreshCw, Calendar, TrendingUp, Users,
  TicketCheck, Clock, Zap
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
import AdminSidebar from '@/components/admin/AdminSidebar';

export default function AdminPerformancePage() {
  const { data, isLoading, error, refetch } = trpc.admin.getPerformanceStats.useQuery();

  // Loading state
  if (isLoading) {
    return (
      <div className="flex min-h-screen" style={{ background: 'var(--bg-primary)' }}>
        <AdminSidebar />
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--color-primary)]"></div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex min-h-screen" style={{ background: 'var(--bg-primary)' }}>
        <AdminSidebar />
        <div className="flex-1 p-8">
          <Card
            className="max-w-md mx-auto mt-20"
            style={{ background: 'var(--error-bg)', border: '1px solid var(--error)' }}
          >
            <CardContent className="pt-6">
              <p style={{ color: 'var(--error)' }}>
                {error.message.includes('Admin role required')
                  ? '访问被拒绝：您需要管理员权限才能查看此页面。'
                  : `错误: ${error.message}`}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const conversations = data?.conversations ?? { total: 0, today: 0, thisWeek: 0, thisMonth: 0 };
  const messages = data?.messages ?? {
    total: 0, userMessages: 0, assistantMessages: 0,
    today: 0, thisWeek: 0, thisMonth: 0
  };
  const tickets = data?.tickets ?? { total: 0, open: 0, inProgress: 0, closed: 0 };
  const modelUsage = data?.modelUsage ?? [];
  const dailyChart = data?.dailyChart ?? [];
  const averages = data?.averages ?? { messagesPerConversation: 0, conversationsPerDay: 0, messagesPerDay: 0 };

  return (
    <div className="flex min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <AdminSidebar />

      <div className="flex-1 p-8 overflow-auto">
        {/* Page Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
              性能监控
            </h1>
            <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
              系统性能和使用情况统计
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
                  <MessagesSquare className="h-6 w-6 text-[var(--color-primary)]" />
                </div>
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总对话数</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {conversations.total.toLocaleString()}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-blue-500/20">
                  <MessageSquare className="h-6 w-6 text-blue-400" />
                </div>
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总消息数</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {messages.total.toLocaleString()}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-emerald-500/20">
                  <Zap className="h-6 w-6 text-emerald-400" />
                </div>
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>平均消息/对话</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {averages.messagesPerConversation}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-purple-500/20">
                  <TrendingUp className="h-6 w-6 text-purple-400" />
                </div>
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>日均消息</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {averages.messagesPerDay}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Activity Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium" style={{ color: 'var(--text-tertiary)' }}>
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
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium" style={{ color: 'var(--text-tertiary)' }}>
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
                  <span className="text-emerald-400">{messages.userMessages.toLocaleString()}</span>
                </div>
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <Bot className="h-4 w-4 text-blue-400" />
                    <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>AI 回复</span>
                  </div>
                  <span className="text-blue-400">{messages.assistantMessages.toLocaleString()}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>今日消息</span>
                  <Badge className="bg-[var(--color-primary-20)] text-[var(--color-primary)]">{messages.today}</Badge>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium" style={{ color: 'var(--text-tertiary)' }}>
                工单状态
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>待处理</span>
                  <Badge className="bg-amber-500/20 text-amber-400">{tickets.open}</Badge>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>处理中</span>
                  <Badge className="bg-blue-500/20 text-blue-400">{tickets.inProgress}</Badge>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>已关闭</span>
                  <Badge className="bg-emerald-500/20 text-emerald-400">{tickets.closed}</Badge>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Activity Chart */}
        <Card className="mb-8" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <Calendar className="h-5 w-5" />
              近14天活动趋势
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
              </div>
              <div className="h-40 flex items-end gap-2">
                {dailyChart.map((day, index) => {
                  const maxValue = Math.max(
                    ...dailyChart.map(d => Math.max(d.conversations * 10, d.messages))
                  ) || 1;
                  return (
                    <div key={index} className="flex-1 flex flex-col gap-1" title={day.date}>
                      <div
                        className="bg-[var(--color-primary)] rounded-t"
                        style={{ height: `${((day.conversations * 10) / maxValue) * 100}%`, minHeight: day.conversations > 0 ? '4px' : '0' }}
                      />
                      <div
                        className="bg-blue-400 rounded-b"
                        style={{ height: `${(day.messages / maxValue) * 100}%`, minHeight: day.messages > 0 ? '2px' : '0' }}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between text-xs" style={{ color: 'var(--text-disabled)' }}>
                <span>{dailyChart[0]?.date.slice(5) || ''}</span>
                <span>{dailyChart[dailyChart.length - 1]?.date.slice(5) || ''}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Model Usage Table */}
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
                  <TableHead>对话数</TableHead>
                  <TableHead>占比</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {modelUsage.map((model) => {
                  const percentage = conversations.total > 0
                    ? ((model.conversationCount / conversations.total) * 100).toFixed(1)
                    : '0';
                  return (
                    <TableRow key={model.id}>
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
                      <TableCell style={{ color: 'var(--text-primary)' }}>
                        {model.conversationCount.toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                            <div
                              className="h-full bg-[var(--color-primary)] rounded-full"
                              style={{ width: `${percentage}%` }}
                            />
                          </div>
                          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                            {percentage}%
                          </span>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {modelUsage.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center py-12" style={{ color: 'var(--text-disabled)' }}>
                      暂无模型使用数据
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
