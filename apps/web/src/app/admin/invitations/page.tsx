'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { Gift, Plus, Copy, Check, Clock, CheckCircle, XCircle } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import AdminSidebar from '@/components/admin/AdminSidebar';
import AdminLoadingState from '@/components/admin/AdminLoadingState';
import AdminErrorState from '@/components/admin/AdminErrorState';
import AdminPageHeader from '@/components/admin/AdminPageHeader';
import StatsCardGrid from '@/components/admin/StatsCardGrid';
import { StatusBadge } from '@/components/ui/status-badge';
import { TableEmptyState } from '@/components/ui/empty-state';

interface Invitation {
  id: string;
  code: string;
  created_by: string;
  used_by: string | null;
  status: 'active' | 'used' | 'expired';
  created_at: string;
}

// 邀请码状态映射到 StatusBadge 的 status
const invitationStatusMap: Record<string, string> = {
  active: 'available',
  used: 'used',
  expired: 'expired',
};

export default function AdminInvitationsPage() {
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const { data: invitations, isLoading, error, refetch } = trpc.invitation.getInvitationHistory.useQuery();

  const generateCode = trpc.invitation.generateInvitationCode.useMutation({
    onSuccess: () => {
      refetch();
    }
  });

  const copyToClipboard = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  // Loading state
  if (isLoading) {
    return <AdminLoadingState />;
  }

  // Error state
  if (error) {
    return <AdminErrorState error={error} onRetry={() => refetch()} />;
  }

  const invitationList = invitations ?? [];

  // Count by status
  const statusCounts = {
    total: invitationList.length,
    active: invitationList.filter((i: Invitation) => i.status === 'active').length,
    used: invitationList.filter((i: Invitation) => i.status === 'used').length,
    expired: invitationList.filter((i: Invitation) => i.status === 'expired').length,
  };

  // Stats for StatsCardGrid
  const stats = [
    { label: '总邀请码', value: statusCounts.total, icon: Gift, color: 'amber' },
    { label: '可用', value: statusCounts.active, icon: CheckCircle, color: 'emerald' },
    { label: '已使用', value: statusCounts.used, icon: Check, color: 'blue' },
    { label: '已过期', value: statusCounts.expired, icon: XCircle, color: 'rose' },
  ];

  return (
    <div className="flex min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <AdminSidebar />

      <div className="flex-1 p-8 overflow-auto">
        {/* Page Header */}
        <AdminPageHeader
          title="邀请码管理"
          subtitle="生成和管理用户邀请码"
          onRefresh={() => refetch()}
        >
          <Button
            onClick={() => generateCode.mutate()}
            disabled={generateCode.isPending}
            className="bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
          >
            <Plus className="h-4 w-4 mr-2" />
            {generateCode.isPending ? '生成中...' : '生成邀请码'}
          </Button>
        </AdminPageHeader>

        {/* Stats Cards */}
        <StatsCardGrid stats={stats} />

        {/* Invitations Table */}
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>邀请码</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="w-[100px]">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invitationList.map((invitation: Invitation) => (
                  <TableRow key={invitation.code}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div
                          className="p-2 rounded-lg"
                          style={{ background: 'var(--bg-tertiary)' }}
                        >
                          <Gift className="h-4 w-4 text-[var(--color-primary)]" />
                        </div>
                        <code
                          className="font-mono text-sm px-2 py-1 rounded"
                          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
                        >
                          {invitation.code}
                        </code>
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={invitationStatusMap[invitation.status] || invitation.status} />
                    </TableCell>
                    <TableCell style={{ color: 'var(--text-tertiary)' }}>
                      <div className="flex items-center gap-1">
                        <Clock className="h-4 w-4" />
                        {new Date(invitation.created_at).toLocaleDateString('zh-CN')}
                      </div>
                    </TableCell>
                    <TableCell>
                      {invitation.status === 'active' && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => copyToClipboard(invitation.code)}
                          className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                        >
                          {copiedCode === invitation.code ? (
                            <>
                              <Check className="h-4 w-4 mr-1 text-emerald-400" />
                              已复制
                            </>
                          ) : (
                            <>
                              <Copy className="h-4 w-4 mr-1" />
                              复制
                            </>
                          )}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {invitationList.length === 0 && (
                  <TableEmptyState
                    colSpan={4}
                    message="暂无邀请码"
                    action="点击上方按钮生成"
                  />
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
