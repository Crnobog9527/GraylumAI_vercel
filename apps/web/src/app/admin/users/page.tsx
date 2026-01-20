'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { Search, Coins, Plus, Minus } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import AdminSidebar from '@/components/admin/AdminSidebar';

interface User {
  id: string;
  email: string;
  nickname: string | null;
  avatar_url: string | null;
  role: string;
  credits: number;
  created_at: string;
}

export default function AdminUsersPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [creditAdjustment, setCreditAdjustment] = useState({ amount: 0, reason: '' });

  const { data, isLoading, error, refetch } = trpc.admin.getAllUsers.useQuery({});
  const users = data?.users ?? [];
  const updateCredits = trpc.admin.adjustUserCredits.useMutation({
    onSuccess: () => {
      refetch();
      setDialogOpen(false);
      setCreditAdjustment({ amount: 0, reason: '' });
      setSelectedUser(null);
    }
  });

  const handleAdjustCredits = async () => {
    if (!selectedUser || creditAdjustment.amount === 0) return;

    updateCredits.mutate({
      userId: selectedUser.id,
      amount: creditAdjustment.amount,
      reason: creditAdjustment.reason || '管理员调整',
    });
  };

  const filteredUsers = users.filter((u: User) =>
    u.email?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    u.nickname?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // 加载状态
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

  // 错误状态
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

  return (
    <div className="flex min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <AdminSidebar />

      <div className="flex-1 p-8 overflow-auto">
        {/* 页面标题 */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
              用户管理
            </h1>
            <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
              管理平台用户和积分
            </p>
          </div>
        </div>

        {/* 搜索框 */}
        <div className="mb-6">
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--text-tertiary)]" />
            <Input
              placeholder="搜索用户邮箱或昵称..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 bg-[var(--bg-secondary)] border-[var(--border-primary)] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)]"
            />
          </div>
        </div>

        {/* 用户表格 */}
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>用户</TableHead>
                  <TableHead>角色</TableHead>
                  <TableHead>积分余额</TableHead>
                  <TableHead>注册时间</TableHead>
                  <TableHead className="w-[100px]">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredUsers.map((u: User) => (
                  <TableRow key={u.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar className="h-10 w-10">
                          <AvatarImage src={u.avatar_url || undefined} />
                          <AvatarFallback className="bg-[var(--color-primary-20)] text-[var(--color-primary)]">
                            {u.nickname?.[0] || u.email?.[0]?.toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
                            {u.nickname || '未设置昵称'}
                          </p>
                          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{u.email}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={u.role === 'admin' ? 'default' : 'secondary'}>
                        {u.role === 'admin' ? '管理员' : '用户'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Coins className="h-4 w-4 text-amber-400" />
                        <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                          {u.credits || 0}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell style={{ color: 'var(--text-tertiary)' }}>
                      {new Date(u.created_at).toLocaleDateString('zh-CN')}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSelectedUser(u);
                          setDialogOpen(true);
                        }}
                        className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                      >
                        <Coins className="h-4 w-4 mr-1" />
                        调整
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {filteredUsers.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-12" style={{ color: 'var(--text-disabled)' }}>
                      未找到用户
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* 积分调整对话框 */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent
            className="max-w-md"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
          >
            <DialogHeader>
              <DialogTitle style={{ color: 'var(--text-primary)' }}>调整积分</DialogTitle>
            </DialogHeader>

            {selectedUser && (
              <div className="space-y-4 py-4">
                {/* 用户信息 */}
                <div
                  className="flex items-center gap-3 p-4 rounded-lg"
                  style={{ background: 'var(--bg-tertiary)' }}
                >
                  <Avatar className="h-12 w-12">
                    <AvatarImage src={selectedUser.avatar_url || undefined} />
                    <AvatarFallback className="bg-[var(--color-primary-20)] text-[var(--color-primary)]">
                      {selectedUser.nickname?.[0] || selectedUser.email?.[0]?.toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
                      {selectedUser.nickname || '未设置昵称'}
                    </p>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                      {selectedUser.email}
                    </p>
                    <p className="text-sm mt-1 text-amber-400">
                      当前余额: {selectedUser.credits || 0}
                    </p>
                  </div>
                </div>

                {/* 调整金额 */}
                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>调整数量</Label>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setCreditAdjustment(prev => ({ ...prev, amount: prev.amount - 10 }))}
                      className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                    >
                      <Minus className="h-4 w-4" />
                    </Button>
                    <Input
                      type="number"
                      value={creditAdjustment.amount}
                      onChange={(e) => setCreditAdjustment(prev => ({ ...prev, amount: parseInt(e.target.value) || 0 }))}
                      className="text-center bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setCreditAdjustment(prev => ({ ...prev, amount: prev.amount + 10 }))}
                      className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  <p className="text-xs" style={{ color: 'var(--text-disabled)' }}>
                    正数增加积分，负数扣除积分
                  </p>
                </div>

                {/* 原因 */}
                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>调整原因</Label>
                  <Input
                    value={creditAdjustment.reason}
                    onChange={(e) => setCreditAdjustment(prev => ({ ...prev, reason: e.target.value }))}
                    placeholder="奖励积分、退款等..."
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)]"
                  />
                </div>

                {/* 预览 */}
                {creditAdjustment.amount !== 0 && (
                  <div
                    className="p-3 rounded-lg text-center"
                    style={{ background: 'var(--color-primary-10)' }}
                  >
                    <p className="text-sm" style={{ color: 'var(--color-primary)' }}>
                      调整后余额: <span className="font-bold">{(selectedUser.credits || 0) + creditAdjustment.amount}</span>
                    </p>
                  </div>
                )}
              </div>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setDialogOpen(false)}
                className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
              >
                取消
              </Button>
              <Button
                onClick={handleAdjustCredits}
                disabled={creditAdjustment.amount === 0 || updateCredits.isPending}
                className="bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
              >
                {updateCredits.isPending ? '保存中...' : '确认调整'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
