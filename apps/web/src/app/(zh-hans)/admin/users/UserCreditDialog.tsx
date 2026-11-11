/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { Plus, Minus } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { adminUserContact } from '@/lib/adminUserContact';
import type { UsersAdmin } from './useUsersAdmin';

// 调整积分的弹窗。从 page.tsx 原样搬出。
export function UserCreditDialog({ admin }: { admin: UsersAdmin }) {
  const {
    creditDialogOpen, setCreditDialogOpen, selectedUser, creditAdjustment, setCreditAdjustment, updateCredits,
    handleAdjustCredits,
  } = admin;

  return (
    <Dialog open={creditDialogOpen} onOpenChange={setCreditDialogOpen}>
      <DialogContent className="max-w-md" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
        <DialogHeader>
          <DialogTitle style={{ color: 'var(--text-primary)' }}>调整积分</DialogTitle>
          <DialogDescription className="sr-only">
            为所选用户调整积分余额，并记录本次调整原因。
          </DialogDescription>
        </DialogHeader>

        {selectedUser && (
          <div className="space-y-4 py-4">
            <div className="flex items-center gap-3 p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
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
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{adminUserContact(selectedUser)}</p>
                <p className="text-sm mt-1 text-amber-400">当前余额: {selectedUser.credits || 0}</p>
              </div>
            </div>

            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>调整数量</Label>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="减少积分"
                  onClick={() => setCreditAdjustment(prev => ({ ...prev, amount: prev.amount - 100 }))}
                  className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                >
                  <Minus className="h-4 w-4" />
                </Button>
                <Input
                  type="number"
                  value={creditAdjustment.amount}
                  onChange={(e) => setCreditAdjustment(prev => ({ ...prev, amount: parseInt(e.target.value) || 0 }))}
                  className="text-center"
                  style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-primary)' }}
                />
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="增加积分"
                  onClick={() => setCreditAdjustment(prev => ({ ...prev, amount: prev.amount + 100 }))}
                  className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs" style={{ color: 'var(--text-disabled)' }}>正数增加积分，负数扣除积分</p>
            </div>

            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>调整原因</Label>
              <Input
                value={creditAdjustment.reason}
                onChange={(e) => setCreditAdjustment(prev => ({ ...prev, reason: e.target.value }))}
                placeholder="奖励积分、退款等..."
                style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-primary)' }}
              />
            </div>

            {creditAdjustment.amount !== 0 && (
              <div className="p-3 rounded-lg text-center" style={{ background: 'var(--color-primary-10)' }}>
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
            onClick={() => setCreditDialogOpen(false)}
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
  );
}
