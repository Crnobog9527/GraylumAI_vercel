'use client';

import { trpc } from '@/trpc/client';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Users, Coins, TrendingUp, TrendingDown, Ticket, MessageSquare,
  Activity, Settings, Megaphone, Bot, RefreshCw, ArrowRight,
  CheckCircle, AlertTriangle, XCircle, Calendar, Clock,
  CreditCard, Gift, Zap, Crown
} from 'lucide-react';
import StatsCard from '@/components/admin/StatsCard';
import Link from 'next/link';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Legend
} from 'recharts';

interface User {
  id: string;
  email: string;
  nickname: string | null;
  avatar_url: string | null;
  role: string;
  credits: number;
  created_at: string;
}

interface TopUser {
  id: string;
  email: string;
  nickname: string | null;
  avatar_url: string | null;
  credits: number;
}

interface TrendData {
  date: string;
  day: string;
  additions: number;
  deductions: number;
}

interface Model {
  id: string;
  name: string;
  model_id: string;
  is_active: string;
}

const healthConfig = {
  healthy: { label: '健康', color: 'text-emerald-400', bgColor: 'bg-emerald-500/20', icon: CheckCircle },
  attention: { label: '需关注', color: 'text-amber-400', bgColor: 'bg-amber-500/20', icon: AlertTriangle },
  warning: { label: '警告', color: 'text-rose-400', bgColor: 'bg-rose-500/20', icon: XCircle },
};

const quickActions = [
  { label: '用户管理', icon: Users, href: '/admin/users', color: 'text-blue-400' },
  { label: '工单处理', icon: Ticket, href: '/admin/tickets', color: 'text-rose-400' },
  { label: 'AI模型', icon: Bot, href: '/admin/models', color: 'text-purple-400' },
  { label: '系统设置', icon: Settings, href: '/admin/settings', color: 'text-emerald-400' },
  { label: '公告管理', icon: Megaphone, href: '/admin/announcements', color: 'text-amber-400' },
  { label: '积分包', icon: CreditCard, href: '/admin/packages', color: 'text-cyan-400' },
];

export default function AdminDashboardPage() {
  const { data: stats, refetch, isLoading } = trpc.admin.getStatistics.useQuery();

  const healthStatus = healthConfig[stats?.systemHealth as keyof typeof healthConfig] || healthConfig.healthy;
  const HealthIcon = healthStatus.icon;

  return (
    <div className="p-8 overflow-auto">
      {/* Page Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
            管理后台仪表盘
          </h1>
          <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
            平台运营数据概览
          </p>
        </div>
        <div className="flex items-center gap-4">
          {/* System Health */}
          <div className={`flex items-center gap-2 px-4 py-2 rounded-lg ${healthStatus.bgColor}`}>
            <HealthIcon className={`h-4 w-4 ${healthStatus.color}`} />
            <span className={`text-sm font-medium ${healthStatus.color}`}>
              工单状态: {healthStatus.label}
            </span>
          </div>
          <Button
            variant="outline"
            onClick={() => refetch()}
            disabled={isLoading}
            className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
        </div>
      </div>

      {/* Stats Cards Row 1 - Main Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <StatsCard
          title="总用户数"
          value={stats?.users.total ?? 0}
          icon={Users}
          color="primary"
          trend="up"
          trendValue={`今日 +${stats?.users.today ?? 0}`}
        />
        <StatsCard
          title="对话总数"
          value={stats?.conversations.total ?? 0}
          subtitle={`今日 ${stats?.conversations.today ?? 0} / 本周 ${stats?.conversations.thisWeek ?? 0}`}
          icon={MessageSquare}
          color="blue"
        />
        <StatsCard
          title="账户积分总额"
          value={(stats?.credits.totalInSystem ?? 0).toLocaleString()}
          icon={Coins}
          color="amber"
        />
        <StatsCard
          title="待处理工单"
          value={stats?.tickets.open ?? 0}
          subtitle={`${stats?.tickets.inProgress ?? 0} 处理中 / ${stats?.tickets.total ?? 0} 总计`}
          icon={Ticket}
          color="rose"
        />
      </div>

      {/* Time Comparison Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        {/* Today */}
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-lg bg-emerald-500/20">
                <Clock className="h-5 w-5 text-emerald-400" />
              </div>
              <div>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>今日</p>
                <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>实时数据</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>新增用户</p>
                <p className="text-xl font-bold text-emerald-400">{stats?.users.today ?? 0}</p>
              </div>
              <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>新增对话</p>
                <p className="text-xl font-bold text-blue-400">{stats?.conversations.today ?? 0}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* This Week */}
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-lg bg-blue-500/20">
                <Calendar className="h-5 w-5 text-blue-400" />
              </div>
              <div>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>本周</p>
                <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>周统计</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>新增用户</p>
                <p className="text-xl font-bold text-blue-400">{stats?.users.thisWeek ?? 0}</p>
              </div>
              <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>新增对话</p>
                <p className="text-xl font-bold text-purple-400">{stats?.conversations.thisWeek ?? 0}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* This Month */}
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-lg bg-amber-500/20">
                <Activity className="h-5 w-5 text-amber-400" />
              </div>
              <div>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>本月</p>
                <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>月统计</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>新增用户</p>
                <p className="text-xl font-bold text-amber-400">{stats?.users.thisMonth ?? 0}</p>
              </div>
              <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>已启用模型</p>
                <p className="text-xl font-bold text-rose-400">{stats?.models.activeCount ?? 0}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts and Lists Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Trend Chart */}
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <TrendingUp className="h-5 w-5 text-[var(--color-primary)]" />
              积分趋势 (近7天)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[250px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats?.trends ?? []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-primary)" />
                  <XAxis
                    dataKey="day"
                    stroke="var(--text-tertiary)"
                    fontSize={12}
                  />
                  <YAxis stroke="var(--text-tertiary)" fontSize={12} />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--bg-secondary)',
                      border: '1px solid var(--border-primary)',
                      borderRadius: '8px',
                    }}
                    labelStyle={{ color: 'var(--text-primary)' }}
                  />
                  <Legend />
                  <Bar dataKey="additions" name="增加" fill="#22c55e" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="deductions" name="消耗" fill="#f43f5e" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Credit Statistics */}
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <Coins className="h-5 w-5 text-[var(--color-primary)]" />
              积分统计
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 rounded-lg text-center" style={{ background: 'var(--bg-tertiary)' }}>
                <TrendingUp className="h-8 w-8 mx-auto mb-2 text-emerald-400" />
                <p className="text-2xl font-bold text-emerald-400">
                  {(stats?.credits.transactions?.totalAdditions ?? 0).toLocaleString()}
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>累计增加</p>
              </div>
              <div className="p-4 rounded-lg text-center" style={{ background: 'var(--bg-tertiary)' }}>
                <TrendingDown className="h-8 w-8 mx-auto mb-2 text-rose-400" />
                <p className="text-2xl font-bold text-rose-400">
                  {(stats?.credits.transactions?.totalDeductions ?? 0).toLocaleString()}
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>累计消耗</p>
              </div>
              <div className="p-4 rounded-lg text-center" style={{ background: 'var(--bg-tertiary)' }}>
                <CreditCard className="h-8 w-8 mx-auto mb-2 text-blue-400" />
                <p className="text-2xl font-bold text-blue-400">
                  {(stats?.credits.transactions?.totalPurchases ?? 0).toLocaleString()}
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>累计购入积分</p>
              </div>
              <div className="p-4 rounded-lg text-center" style={{ background: 'var(--bg-tertiary)' }}>
                <Gift className="h-8 w-8 mx-auto mb-2 text-amber-400" />
                <p className="text-2xl font-bold text-amber-400">
                  {(stats?.credits.transactions?.totalRefunds ?? 0).toLocaleString()}
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>累计退回积分</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions & Overview Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        {/* Quick Actions */}
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <Zap className="h-5 w-5 text-[var(--color-primary)]" />
              快捷入口
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              {quickActions.map((action) => (
                <Link key={action.href} href={action.href}>
                  <Button
                    variant="outline"
                    className="w-full h-auto py-4 flex-col gap-2 border-[var(--border-primary)] hover:bg-[var(--bg-tertiary)]"
                  >
                    <action.icon className={`h-5 w-5 ${action.color}`} />
                    <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{action.label}</span>
                  </Button>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Ticket Overview */}
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardHeader>
            <CardTitle className="flex items-center justify-between" style={{ color: 'var(--text-primary)' }}>
              <div className="flex items-center gap-2">
                <Ticket className="h-5 w-5 text-[var(--color-primary)]" />
                工单概览
              </div>
              <Link href="/admin/tickets">
                <Button variant="ghost" size="sm" className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                  查看全部 <ArrowRight className="h-3 w-3 ml-1" />
                </Button>
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-orange-400" />
                  <span style={{ color: 'var(--text-secondary)' }}>待处理</span>
                </div>
                <span className="font-semibold text-orange-400">{stats?.tickets.open ?? 0}</span>
              </div>
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-blue-400" />
                  <span style={{ color: 'var(--text-secondary)' }}>处理中</span>
                </div>
                <span className="font-semibold text-blue-400">{stats?.tickets.inProgress ?? 0}</span>
              </div>
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-emerald-400" />
                  <span style={{ color: 'var(--text-secondary)' }}>已关闭</span>
                </div>
                <span className="font-semibold text-emerald-400">{stats?.tickets.closed ?? 0}</span>
              </div>
              <div className="pt-3 mt-3 flex justify-between items-center font-bold" style={{ borderTop: '1px solid var(--border-primary)' }}>
                <span style={{ color: 'var(--text-primary)' }}>总计</span>
                <span style={{ color: 'var(--text-primary)' }}>{stats?.tickets.total ?? 0}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Invitation Overview */}
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardHeader>
            <CardTitle className="flex items-center justify-between" style={{ color: 'var(--text-primary)' }}>
              <div className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-[var(--color-primary)]" />
                邀请码概览
              </div>
              <Link href="/admin/invitations">
                <Button variant="ghost" size="sm" className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                  查看全部 <ArrowRight className="h-3 w-3 ml-1" />
                </Button>
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-emerald-400" />
                  <span style={{ color: 'var(--text-secondary)' }}>有效</span>
                </div>
                <span className="font-semibold text-emerald-400">{stats?.invitations.active ?? 0}</span>
              </div>
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-blue-400" />
                  <span style={{ color: 'var(--text-secondary)' }}>已使用</span>
                </div>
                <span className="font-semibold text-blue-400">{stats?.invitations.used ?? 0}</span>
              </div>
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-slate-400" />
                  <span style={{ color: 'var(--text-secondary)' }}>已过期</span>
                </div>
                <span className="font-semibold" style={{ color: 'var(--text-disabled)' }}>{stats?.invitations.expired ?? 0}</span>
              </div>
              <div className="pt-3 mt-3 flex justify-between items-center font-bold" style={{ borderTop: '1px solid var(--border-primary)' }}>
                <span style={{ color: 'var(--text-primary)' }}>总计</span>
                <span style={{ color: 'var(--text-primary)' }}>{stats?.invitations.total ?? 0}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Top Users & Active Models Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Top Users */}
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardHeader>
            <CardTitle className="flex items-center justify-between" style={{ color: 'var(--text-primary)' }}>
              <div className="flex items-center gap-2">
                <Crown className="h-5 w-5 text-[var(--color-primary)]" />
                积分排行
              </div>
              <Link href="/admin/users">
                <Button variant="ghost" size="sm" className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                  查看全部 <ArrowRight className="h-3 w-3 ml-1" />
                </Button>
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {stats?.users.topUsers && stats.users.topUsers.length > 0 ? (
              <div className="space-y-3">
                {stats.users.topUsers.map((user: TopUser, index: number) => (
                  <div key={user.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors">
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                      index === 0 ? 'bg-amber-500/20 text-amber-400' :
                      index === 1 ? 'bg-slate-500/20 text-slate-400' :
                      index === 2 ? 'bg-orange-500/20 text-orange-400' :
                      'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]'
                    }`}>
                      {index + 1}
                    </div>
                    <Avatar className="h-8 w-8">
                      <AvatarImage src={user.avatar_url || undefined} />
                      <AvatarFallback className="text-xs bg-[var(--color-primary-20)] text-[var(--color-primary)]">
                        {user.nickname?.[0] || user.email?.[0]?.toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                        {user.nickname || '未设置昵称'}
                      </p>
                      <p className="text-xs truncate" style={{ color: 'var(--text-tertiary)' }}>{user.email}</p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Coins className="h-4 w-4 text-amber-400" />
                      <span className="font-semibold text-amber-400">{user.credits.toLocaleString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-center py-8" style={{ color: 'var(--text-disabled)' }}>暂无数据</p>
            )}
          </CardContent>
        </Card>

        {/* Active Models */}
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardHeader>
            <CardTitle className="flex items-center justify-between" style={{ color: 'var(--text-primary)' }}>
              <div className="flex items-center gap-2">
                <Bot className="h-5 w-5 text-[var(--color-primary)]" />
                活跃模型
              </div>
              <Link href="/admin/models">
                <Button variant="ghost" size="sm" className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                  管理模型 <ArrowRight className="h-3 w-3 ml-1" />
                </Button>
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {stats?.models.list && stats.models.list.length > 0 ? (
              <div className="space-y-3">
                {stats.models.list.slice(0, 5).map((model: Model) => (
                  <div key={model.id} className="flex items-center justify-between p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-purple-500/20">
                        <Bot className="h-4 w-4 text-purple-400" />
                      </div>
                      <div>
                        <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{model.name}</p>
                        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{model.model_id}</p>
                      </div>
                    </div>
                    <Badge className="bg-emerald-500/20 text-emerald-400">
                      <CheckCircle className="h-3 w-3 mr-1" />
                      运行中
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-center py-8" style={{ color: 'var(--text-disabled)' }}>暂无活跃模型</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent Users */}
      <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
        <CardHeader>
          <CardTitle className="flex items-center justify-between" style={{ color: 'var(--text-primary)' }}>
            <div className="flex items-center gap-2">
              <Users className="h-5 w-5 text-[var(--color-primary)]" />
              最近注册用户
            </div>
            <Link href="/admin/users">
              <Button variant="ghost" size="sm" className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                查看全部 <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {stats?.users.recentUsers && stats.users.recentUsers.length > 0 ? (
            <ScrollArea className="h-[300px]">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-primary)' }}>
                    <th className="text-left py-3 px-2" style={{ color: 'var(--text-tertiary)' }}>用户</th>
                    <th className="text-left py-3 px-2" style={{ color: 'var(--text-tertiary)' }}>角色</th>
                    <th className="text-right py-3 px-2" style={{ color: 'var(--text-tertiary)' }}>积分</th>
                    <th className="text-left py-3 px-2" style={{ color: 'var(--text-tertiary)' }}>注册时间</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.users.recentUsers.map((user: User) => (
                    <tr
                      key={user.id}
                      className="hover:bg-[var(--bg-tertiary)] transition-colors"
                      style={{ borderBottom: '1px solid var(--border-primary)' }}
                    >
                      <td className="py-3 px-2">
                        <div className="flex items-center gap-3">
                          <Avatar className="h-8 w-8">
                            <AvatarImage src={user.avatar_url || undefined} />
                            <AvatarFallback className="text-xs bg-[var(--color-primary-20)] text-[var(--color-primary)]">
                              {user.nickname?.[0] || user.email?.[0]?.toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
                              {user.nickname || '未设置昵称'}
                            </p>
                            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{user.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 px-2">
                        <Badge className={user.role === 'admin' ? 'bg-[var(--color-primary-20)] text-[var(--color-primary)]' : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'}>
                          {user.role === 'admin' ? '管理员' : '用户'}
                        </Badge>
                      </td>
                      <td className="py-3 px-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Coins className="h-3 w-3 text-amber-400" />
                          <span style={{ color: 'var(--text-primary)' }}>{user.credits}</span>
                        </div>
                      </td>
                      <td className="py-3 px-2" style={{ color: 'var(--text-tertiary)' }}>
                        {new Date(user.created_at).toLocaleDateString('zh-CN')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollArea>
          ) : (
            <p className="text-center py-8" style={{ color: 'var(--text-disabled)' }}>暂无用户数据</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
