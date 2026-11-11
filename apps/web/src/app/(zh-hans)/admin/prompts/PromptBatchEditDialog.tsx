/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  platformConfig, iconOptions, categoryConfig, BATCH_NO_CHANGE,
  type ModuleCategory, type Platform, type BatchSentinel, type BatchEditForm,
} from './promptsShared';
import type { PromptsAdmin } from './usePromptsAdmin';

// 批量编辑共享字段的弹窗。从 page.tsx 原样搬出。
export function PromptBatchEditDialog({ admin }: { admin: PromptsAdmin }) {
  const {
    mode, skillModels, batchEditOpen, setBatchEditOpen, batchForm, setBatchForm, selectedModuleIds,
    batchUpdatePrompts, handleBatchEditSubmit, modelsData,
  } = admin;

  return (
    <Dialog open={batchEditOpen} onOpenChange={setBatchEditOpen}>
      <DialogContent
        className="max-w-xl"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
      >
        <DialogHeader>
          <DialogTitle style={{ color: 'var(--text-primary)' }}>
            批量编辑共享字段
          </DialogTitle>
          <DialogDescription className="sr-only">
            为已选中的功能模块统一更新共享字段，未选择的字段保持不变。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
            将为选中的 {selectedModuleIds.length} 个模块统一更新分类、平台、模型、图标或精选状态。未选择的字段保持不变。
          </p>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>分类</Label>
              <Select
                value={batchForm.category}
                onValueChange={(value) => setBatchForm({ ...batchForm, category: value as ModuleCategory | BatchSentinel })}
              >
                <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                  <SelectItem value={BATCH_NO_CHANGE}>保持不变</SelectItem>
                  {Object.entries(categoryConfig).map(([key, config]) => (
                    <SelectItem key={key} value={key}>{config.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>适用平台</Label>
              <Select
                value={batchForm.platform}
                onValueChange={(value) => setBatchForm({ ...batchForm, platform: value as Platform | BatchSentinel })}
              >
                <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                  <SelectItem value={BATCH_NO_CHANGE}>保持不变</SelectItem>
                  {Object.entries(platformConfig).map(([key, label]) => (
                    <SelectItem key={key} value={key}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>指定模型</Label>
              <Select
                value={batchForm.modelId}
                onValueChange={(value) => setBatchForm({ ...batchForm, modelId: value })}
              >
                <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                  <SelectItem value={BATCH_NO_CHANGE}>保持不变</SelectItem>
                  <SelectItem value="none">清空模型限制</SelectItem>
                  {(mode === 'skill' ? skillModels.data ?? [] : modelsData)?.map((model) => (
                    <SelectItem key={model.id} value={model.id} disabled={'available' in model && !model.available}>
                      {model.name}{'reason' in model && model.reason ? `（${model.reason}）` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>图标</Label>
              <Select
                value={batchForm.icon}
                onValueChange={(value) => setBatchForm({ ...batchForm, icon: value })}
              >
                <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                  <SelectItem value={BATCH_NO_CHANGE}>保持不变</SelectItem>
                  {iconOptions.map((icon) => (
                    <SelectItem key={icon} value={icon}>{icon}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>精选</Label>
              <Select
                value={batchForm.isFeatured}
                onValueChange={(value) => setBatchForm({ ...batchForm, isFeatured: value as BatchEditForm['isFeatured'] })}
              >
                <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                  <SelectItem value={BATCH_NO_CHANGE}>保持不变</SelectItem>
                  <SelectItem value="featured">设为精选</SelectItem>
                  <SelectItem value="standard">取消精选</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setBatchEditOpen(false)}
            className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          >
            取消
          </Button>
          <Button
            onClick={handleBatchEditSubmit}
            disabled={batchUpdatePrompts.isPending}
            className="bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
          >
            {batchUpdatePrompts.isPending ? '保存中...' : '应用到选中项'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
