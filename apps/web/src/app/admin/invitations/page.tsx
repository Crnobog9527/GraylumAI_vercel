'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import {
  Users, Gift, CheckCircle, Clock, AlertTriangle,
  ShieldAlert, Search, RefreshCw, TrendingUp, BarChart3
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import AdminLoadingState from '@/components/admin/AdminLoadingState';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar
} from 'recharts';

interface InvitationRecord {
  id: string;
  invite_code: string;
  inviter_email: string | null;
  invitee_email: string | null;
  status: 'pending' | 'registered' | 'rewarded' | 'rejected';
  risk_level: 'low' | 'medium' | 'high';
  block_reason: string | null;
  inviter_reward: number;
  created_at: string;
}

const statusLabels: Record<string, string> = {
  pending: '待注册',
  registered: '待发放',
  rewarded: '已发放',
  rejected: '已拒绝',
};

const statusColors: Record<string, string> = {
  pending: 'bg-slate-500/20 text-slate-400',
  registered: 'bg-blue-500/20 text-blue-400',
  rewarded: 'bg-emerald-500/20 text-emerald-400',
  rejected: 'bg-rose-500/20 text-rose-400',
};

const riskColors: Record<string, string> = {
  low: 'bg-emerald-500/20 text-emerald-400',
  medium: 'bg-amber-500/20 text-amber-400',
  high: 'bg-rose-500/20 text-rose-400',
};

const riskLabels: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
};

export default function AdminInvitationsPage() {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');

  // Queries
  const { data: statsData, isLoading: statsLoading, refetch: refetchStats } = trpc.invitation.getInvitationStats.useQuery();
  const { data: records, isLoading: recordsLoading, refetch: refetchRecords } = trpc.invitation.getAllInvitationRecords.useQuery({
    status: filterStatus as 'all' | 'pending' | 'registered' | 'rewarded' | 'rejected',
    search: searchTerm || undefined,
  });

  const handleRefresh = () => {
    refetchStats();
    refetchRecords();
  };

  // Loading state
  if (statsLoading) {
    return <AdminLoadingState />;
  }

  const stats = statsData?.stats ?? { total: 0, rewarded: 0, rejected: 0, pending: 0, highRisk: 0, totalRewards: 0 };
  const trend = statsData?.trend ?? [];
  const riskDistribution = statsData?.riskDistribution ?? [];
  const recordList = (records ?? []) as InvitationRecord[];

  return (
    <div className="p-8 overflow-auto">
      {/* Page Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
              邀请管理
            </h1>
            <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
              监控邀请数据和风控情况
            </p>
          </div>
          <Button
            onClick={handleRefresh}
            variant="outline"
            className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            刷新数据
          </Button>
        </div>

        {/* Stats Cards - 6 cards */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4 mb-8">
          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-blue-500/20">
                  <Users className="h-5 w-5 text-blue-400" />
                </div>
                <div>
                  <div className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{stats.total}</div>
                  <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总邀请</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-emerald-500/20">
                  <CheckCircle className="h-5 w-5 text-emerald-400" />
                </div>
                <div>
                  <div className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{stats.rewarded}</div>
                  <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>已发放</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-amber-500/20">
                  <Clock className="h-5 w-5 text-amber-400" />
                </div>
                <div>
                  <div className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{stats.pending}</div>
                  <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>待处理</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-rose-500/20">
                  <AlertTriangle className="h-5 w-5 text-rose-400" />
                </div>
                <div>
                  <div className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{stats.rejected}</div>
                  <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>已拒绝</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-violet-500/20">
                  <ShieldAlert className="h-5 w-5 text-violet-400" />
                </div>
                <div>
                  <div className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{stats.highRisk}</div>
                  <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>高风险</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-indigo-500/20">
                  <Gift className="h-5 w-5 text-indigo-400" />
                </div>
                <div>
                  <div className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{stats.totalRewards}</div>
                  <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>发放积分</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Charts */}
        <div className="grid md:grid-cols-2 gap-6 mb-8">
          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                <TrendingUp className="h-5 w-5" />
                近7天邀请趋势
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={trend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-primary)" />
                  <XAxis dataKey="date" stroke="var(--text-tertiary)" />
                  <YAxis stroke="var(--text-tertiary)" />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--bg-secondary)',
                      border: '1px solid var(--border-primary)',
                      borderRadius: '8px',
                    }}
                    labelStyle={{ color: 'var(--text-primary)' }}
                  />
                  <Line type="monotone" dataKey="count" stroke="#6366f1" name="总邀请" strokeWidth={2} />
                  <Line type="monotone" dataKey="rewarded" stroke="#10b981" name="已发放" strokeWidth={2} />
                  <Line type="monotone" dataKey="rejected" stroke="#ef4444" name="已拒绝" strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                <BarChart3 className="h-5 w-5" />
                风险分布
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={riskDistribution}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-primary)" />
                  <XAxis dataKey="name" stroke="var(--text-tertiary)" />
                  <YAxis stroke="var(--text-tertiary)" />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--bg-secondary)',
                      border: '1px solid var(--border-primary)',
                      borderRadius: '8px',
                    }}
                    labelStyle={{ color: 'var(--text-primary)' }}
                  />
                  <Bar dataKey="value" fill="#6366f1" name="数量" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>

        {/* Invitation Records */}
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle style={{ color: 'var(--text-primary)' }}>邀请记录</CardTitle>
                <CardDescription style={{ color: 'var(--text-tertiary)' }}>
                  所有邀请记录详情
                </CardDescription>
              </div>
              <div className="flex items-center gap-4">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4" style={{ color: 'var(--text-tertiary)' }} />
                  <Input
                    placeholder="搜索邮箱或邀请码..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-9 w-64 bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  />
                </div>
                <Select value={filterStatus} onValueChange={setFilterStatus}>
                  <SelectTrigger
                    className="w-32 bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                    <SelectItem value="all">全部状态</SelectItem>
                    <SelectItem value="rewarded">已发放</SelectItem>
                    <SelectItem value="registered">待发放</SelectItem>
                    <SelectItem value="pending">待注册</SelectItem>
                    <SelectItem value="rejected">已拒绝</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {recordsLoading ? (
              <div className="text-center py-12">
                <RefreshCw className="h-8 w-8 animate-spin mx-auto" style={{ color: 'var(--text-tertiary)' }} />
              </div>
            ) : recordList.length === 0 ? (
              <div className="text-center py-12" style={{ color: 'var(--text-tertiary)' }}>
                暂无邀请记录
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border-primary)' }}>
                      <th className="text-left py-3 px-4 text-sm font-medium" style={{ color: 'var(--text-tertiary)' }}>邀请人</th>
                      <th className="text-left py-3 px-4 text-sm font-medium" style={{ color: 'var(--text-tertiary)' }}>被邀请人</th>
                      <th className="text-left py-3 px-4 text-sm font-medium" style={{ color: 'var(--text-tertiary)' }}>邀请码</th>
                      <th className="text-left py-3 px-4 text-sm font-medium" style={{ color: 'var(--text-tertiary)' }}>状态</th>
                      <th className="text-left py-3 px-4 text-sm font-medium" style={{ color: 'var(--text-tertiary)' }}>风险</th>
                      <th className="text-left py-3 px-4 text-sm font-medium" style={{ color: 'var(--text-tertiary)' }}>奖励</th>
                      <th className="text-left py-3 px-4 text-sm font-medium" style={{ color: 'var(--text-tertiary)' }}>时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recordList.slice(0, 100).map((record) => (
                      <tr
                        key={record.id}
                        className="hover:bg-[var(--bg-tertiary)]"
                        style={{ borderBottom: '1px solid var(--border-secondary)' }}
                      >
                        <td className="py-3 px-4 text-sm" style={{ color: 'var(--text-primary)' }}>
                          {record.inviter_email || '-'}
                        </td>
                        <td className="py-3 px-4 text-sm" style={{ color: 'var(--text-primary)' }}>
                          {record.invitee_email || '-'}
                        </td>
                        <td className="py-3 px-4 text-sm font-mono" style={{ color: 'var(--text-secondary)' }}>
                          {record.invite_code}
                        </td>
                        <td className="py-3 px-4">
                          <Badge className={statusColors[record.status]}>
                            {statusLabels[record.status]}
                          </Badge>
                        </td>
                        <td className="py-3 px-4">
                          <Badge className={riskColors[record.risk_level]}>
                            {riskLabels[record.risk_level]}
                          </Badge>
                          {record.block_reason && (
                            <span className="ml-2 text-xs text-rose-400">{record.block_reason}</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-sm" style={{ color: 'var(--text-primary)' }}>
                          {record.inviter_reward > 0 ? `+${record.inviter_reward}` : '-'}
                        </td>
                        <td className="py-3 px-4 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                          {new Date(record.created_at).toLocaleDateString('zh-CN', {
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
    </div>
  );
}
