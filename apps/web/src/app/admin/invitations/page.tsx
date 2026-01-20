'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import {
  Gift, Plus, Copy, Check, Clock, CheckCircle, XCircle
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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

type InvitationStatus = 'active' | 'used' | 'expired';

interface Invitation {
  id: string;
  code: string;
  created_by: string;
  used_by: string | null;
  status: InvitationStatus;
  created_at: string;
}

const statusConfig: Record<InvitationStatus, { label: string; color: string; icon: React.ElementType }> = {
  active: { label: '可用', color: 'bg-emerald-500/20 text-emerald-400', icon: CheckCircle },
  used: { label: '已使用', color: 'bg-blue-500/20 text-blue-400', icon: Check },
  expired: { label: '已过期', color: 'bg-rose-500/20 text-rose-400', icon: XCircle },
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

  const invitationList = invitations ?? [];

  // Count by status
  const statusCounts = {
    total: invitationList.length,
    active: invitationList.filter((i: Invitation) => i.status === 'active').length,
    used: invitationList.filter((i: Invitation) => i.status === 'used').length,
    expired: invitationList.filter((i: Invitation) => i.status === 'expired').length,
  };

  return (
    <div className="flex min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <AdminSidebar />

      <div className="flex-1 p-8 overflow-auto">
        {/* Page Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
              邀请码管理
            </h1>
            <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
              生成和管理用户邀请码
            </p>
          </div>
          <Button
            onClick={() => generateCode.mutate()}
            disabled={generateCode.isPending}
            className="bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
          >
            <Plus className="h-4 w-4 mr-2" />
            {generateCode.isPending ? '生成中...' : '生成邀请码'}
          </Button>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-[var(--color-primary-20)]">
                  <Gift className="h-6 w-6 text-[var(--color-primary)]" />
                </div>
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总邀请码</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {statusCounts.total}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-emerald-500/20">
                  <CheckCircle className="h-6 w-6 text-emerald-400" />
                </div>
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>可用</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {statusCounts.active}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-blue-500/20">
                  <Check className="h-6 w-6 text-blue-400" />
                </div>
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>已使用</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {statusCounts.used}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-rose-500/20">
                  <XCircle className="h-6 w-6 text-rose-400" />
                </div>
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>已过期</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {statusCounts.expired}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

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
                {invitationList.map((invitation: Invitation) => {
                  const statusInfo = statusConfig[invitation.status];
                  const StatusIcon = statusInfo.icon;
                  return (
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
                        <Badge className={statusInfo.color}>
                          <StatusIcon className="h-3 w-3 mr-1" />
                          {statusInfo.label}
                        </Badge>
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
                  );
                })}
                {invitationList.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center py-12" style={{ color: 'var(--text-disabled)' }}>
                      暂无邀请码，点击上方按钮生成
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
