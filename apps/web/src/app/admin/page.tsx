'use client';

import { trpc } from '@/trpc/client';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Users, Coins, TrendingUp, Ticket } from 'lucide-react';
import StatsCard from '@/components/admin/StatsCard';

interface User {
  id: string;
  email: string;
  nickname: string | null;
  role: string;
  credits: number;
  created_at: string;
}

export default function AdminDashboardPage() {
  // Note: AdminGuard in layout.tsx already verified admin access
  // This query will succeed since we passed the guard
  const { data: stats } = trpc.admin.getStatistics.useQuery();

  return (
    <div className="p-8 overflow-auto">
      {/* 页面标题 */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
          管理后台仪表盘
        </h1>
        <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
          平台运营数据概览
        </p>
      </div>

      {/* 统计卡片网格 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <StatsCard
          title="总用户数"
          value={stats?.users.total ?? 0}
          icon={Users}
          color="primary"
          trend="up"
          trendValue="+12%"
        />
        <StatsCard
          title="系统积分"
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
        <StatsCard
          title="有效邀请码"
          value={stats?.invitations.active ?? 0}
          subtitle={`${stats?.invitations.used ?? 0} 已使用 / ${stats?.invitations.total ?? 0} 总计`}
          icon={TrendingUp}
          color="emerald"
        />
      </div>

      {/* 详细信息卡片 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* 工单概览 */}
        <Card
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-primary)'
          }}
        >
          <CardHeader>
            <CardTitle
              className="flex items-center gap-2"
              style={{ color: 'var(--text-primary)' }}
            >
              <Ticket className="h-5 w-5 text-[var(--color-primary)]" />
              工单概览
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span style={{ color: 'var(--text-secondary)' }}>待处理</span>
                <span className="font-semibold text-orange-400">{stats?.tickets.open ?? 0}</span>
              </div>
              <div className="flex justify-between items-center">
                <span style={{ color: 'var(--text-secondary)' }}>处理中</span>
                <span className="font-semibold text-blue-400">{stats?.tickets.inProgress ?? 0}</span>
              </div>
              <div className="flex justify-between items-center">
                <span style={{ color: 'var(--text-secondary)' }}>已关闭</span>
                <span className="font-semibold text-emerald-400">{stats?.tickets.closed ?? 0}</span>
              </div>
              <div
                className="pt-3 mt-3 flex justify-between items-center font-bold"
                style={{ borderTop: '1px solid var(--border-primary)' }}
              >
                <span style={{ color: 'var(--text-primary)' }}>总计</span>
                <span style={{ color: 'var(--text-primary)' }}>{stats?.tickets.total ?? 0}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 邀请码概览 */}
        <Card
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-primary)'
          }}
        >
          <CardHeader>
            <CardTitle
              className="flex items-center gap-2"
              style={{ color: 'var(--text-primary)' }}
            >
              <TrendingUp className="h-5 w-5 text-[var(--color-primary)]" />
              邀请码概览
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span style={{ color: 'var(--text-secondary)' }}>有效</span>
                <span className="font-semibold text-emerald-400">{stats?.invitations.active ?? 0}</span>
              </div>
              <div className="flex justify-between items-center">
                <span style={{ color: 'var(--text-secondary)' }}>已使用</span>
                <span className="font-semibold text-blue-400">{stats?.invitations.used ?? 0}</span>
              </div>
              <div className="flex justify-between items-center">
                <span style={{ color: 'var(--text-secondary)' }}>已过期</span>
                <span className="font-semibold" style={{ color: 'var(--text-disabled)' }}>{stats?.invitations.expired ?? 0}</span>
              </div>
              <div
                className="pt-3 mt-3 flex justify-between items-center font-bold"
                style={{ borderTop: '1px solid var(--border-primary)' }}
              >
                <span style={{ color: 'var(--text-primary)' }}>总计</span>
                <span style={{ color: 'var(--text-primary)' }}>{stats?.invitations.total ?? 0}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 最近用户 */}
      <Card
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)'
        }}
      >
        <CardHeader>
          <CardTitle
            className="flex items-center gap-2"
            style={{ color: 'var(--text-primary)' }}
          >
            <Users className="h-5 w-5 text-[var(--color-primary)]" />
            最近注册用户
          </CardTitle>
        </CardHeader>
        <CardContent>
          {stats?.users.recentUsers && stats.users.recentUsers.length > 0 ? (
            <ScrollArea className="h-[300px]">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-primary)' }}>
                    <th className="text-left py-3 px-2" style={{ color: 'var(--text-tertiary)' }}>邮箱</th>
                    <th className="text-left py-3 px-2" style={{ color: 'var(--text-tertiary)' }}>昵称</th>
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
                      <td className="py-3 px-2" style={{ color: 'var(--text-primary)' }}>{user.email}</td>
                      <td className="py-3 px-2" style={{ color: 'var(--text-secondary)' }}>{user.nickname || '-'}</td>
                      <td className="py-3 px-2">
                        <span className={`px-2 py-1 rounded text-xs font-medium ${
                          user.role === 'admin'
                            ? 'bg-[var(--color-primary-20)] text-[var(--color-primary)]'
                            : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
                        }`}>
                          {user.role === 'admin' ? '管理员' : '用户'}
                        </span>
                      </td>
                      <td className="py-3 px-2 text-right" style={{ color: 'var(--text-primary)' }}>{user.credits}</td>
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
