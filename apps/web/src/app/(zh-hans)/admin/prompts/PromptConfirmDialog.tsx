/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import type { PromptsAdmin } from './usePromptsAdmin';

// 删除 / 下架的确认弹窗。从 page.tsx 原样搬出。
export function PromptConfirmDialog({ admin }: { admin: PromptsAdmin }) {
  const {
    confirmation, setConfirmation, confirmationError, setConfirmationError, confirmationPending, deletePrompt,
    batchDeletePrompts,
  } = admin;

  return (
    <Dialog open={confirmation !== null} onOpenChange={open => { if (!open && !confirmationPending) setConfirmation(null); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{confirmation?.kind === 'delete' ? '删除功能模块' : '下架功能模块'}</DialogTitle>
          <DialogDescription>
            {confirmation?.kind === 'delete'
              ? `确定删除“${confirmation.title}”吗？删除后无法恢复。若存在功能卡片、对话或项目引用，本次全部取消删除。`
              : `确定下架选中的 ${confirmation?.title} 吗？前台将不再展示，已有记录保留。`}
          </DialogDescription>
        </DialogHeader>
        {confirmationError && <p role="alert" className="text-red-400">{confirmationError}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={confirmationPending} onClick={() => setConfirmation(null)}>取消</Button>
          <Button data-testid="admin-module-confirm" disabled={confirmationPending} onClick={() => {
            if (!confirmation || confirmationPending) return;
            setConfirmationError('');
            if (confirmation.kind === 'delete') deletePrompt.mutate({ids: confirmation.ids});
            else batchDeletePrompts.mutate({ids: confirmation.ids});
          }}>{confirmationPending ? '处理中…' : confirmation?.kind === 'delete' ? '确认删除' : '确认下架'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
