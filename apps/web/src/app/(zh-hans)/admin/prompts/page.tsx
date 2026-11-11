'use client';

import { Plus, RefreshCw } from 'lucide-react';
import { Button } from "@/components/ui/button";
import AdminLoadingState from '@/components/admin/AdminLoadingState';
import AdminErrorState from '@/components/admin/AdminErrorState';
import { usePromptsAdmin } from './usePromptsAdmin';
import { PromptsSummary } from './PromptsSummary';
import { PromptsTable } from './PromptsTable';
import { PromptConfirmDialog } from './PromptConfirmDialog';
import { PromptEditorDialog } from './PromptEditorDialog';
import { PromptBatchEditDialog } from './PromptBatchEditDialog';

export default function AdminPromptsPage() {
  const admin = usePromptsAdmin();
  const { dashboard, isLoading, error, refetch, openCreateDialog } = admin;

  if (isLoading) {
    return <AdminLoadingState />;
  }

  if (error && !dashboard) {
    return <AdminErrorState error={error} onRetry={() => refetch()} />;
  }

  return (
    <div className="p-8 overflow-auto">
      {error && dashboard && <p role="alert" className="mb-4 text-amber-400">列表刷新失败，当前显示上次结果。已确认的删除不受影响，请点击刷新重试。</p>}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
            功能模块
          </h1>
          <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
            管理功能广场展示、提示词对话和 Skill 分步流程
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => refetch()}
            className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            刷新
          </Button>
          <Button
            onClick={openCreateDialog}
            className="bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
          >
            <Plus className="h-4 w-4 mr-2" />
            新建模块
          </Button>
        </div>
      </div>

      <PromptsSummary admin={admin} />

      <PromptsTable admin={admin} />

      <PromptConfirmDialog admin={admin} />

      <PromptEditorDialog admin={admin} />

      <PromptBatchEditDialog admin={admin} />
    </div>
  );
}
