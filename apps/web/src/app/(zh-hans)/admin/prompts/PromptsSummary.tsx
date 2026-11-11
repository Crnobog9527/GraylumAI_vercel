/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { Wand2, Pencil, Trash2, Check, X, Star } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { categoryConfig } from './promptsShared';
import type { PromptsAdmin } from './usePromptsAdmin';

// 已选模块的批量操作条、四个统计卡片、分类筛选。从 page.tsx 原样搬出。
export function PromptsSummary({ admin }: { admin: PromptsAdmin }) {
  const {
    categoryFilter, setCategoryFilter, selectedModuleIds, setConfirmation, setConfirmationError,
    handleBatchSetActive, handleOpenBatchEdit, handleBatchDisable, hasSelectedModules, stats,
  } = admin;

  return (
    <>
      {hasSelectedModules && (
        <Card className="mb-6" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
                已选择 {selectedModuleIds.length} 个模块
              </p>
              <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                可批量启用、下架、设置精选状态，或批量编辑共享字段
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={handleOpenBatchEdit}
                className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
              >
                <Pencil className="h-4 w-4 mr-2" />
                批量编辑
              </Button>
              <Button
                variant="outline"
                onClick={() => handleBatchSetActive(true)}
                className="border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10"
              >
                <Check className="h-4 w-4 mr-2" />
                批量启用
              </Button>
              <Button
                variant="outline"
                onClick={handleBatchDisable}
                className="border-amber-500/40 text-amber-300 hover:bg-amber-500/10"
              >
                <X className="h-4 w-4 mr-2" />
                批量下架
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setConfirmationError('');
                  setConfirmation({ kind: 'delete', ids: [...selectedModuleIds], title: `${selectedModuleIds.length} 个模块` });
                }}
                className="border-rose-500/40 text-rose-300 hover:bg-rose-500/10"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                删除选中
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-xl bg-[var(--color-primary-20)]">
                <Wand2 className="h-6 w-6 text-[var(--color-primary)]" />
              </div>
              <div>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总模块</p>
                <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{stats.total}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-xl bg-emerald-500/20">
                <Check className="h-6 w-6 text-emerald-400" />
              </div>
              <div>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>前台展示</p>
                <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{stats.active}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-xl bg-rose-500/20">
                <X className="h-6 w-6 text-rose-400" />
              </div>
              <div>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>已下架</p>
                <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{stats.inactive}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-xl bg-amber-500/20">
                <Star className="h-6 w-6 text-amber-300" />
              </div>
              <div>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>精选置顶</p>
                <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{stats.featured}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs value={categoryFilter} onValueChange={(value) => setCategoryFilter(value as typeof categoryFilter)} className="mb-6">
        <TabsList className="bg-[var(--bg-tertiary)] flex h-auto flex-wrap justify-start">
          <TabsTrigger value="all" className="data-[state=active]:bg-[var(--bg-secondary)]">
            全部
          </TabsTrigger>
          {Object.entries(categoryConfig).map(([key, config]) => {
            const IconComponent = config.icon;
            return (
              <TabsTrigger key={key} value={key} className="data-[state=active]:bg-[var(--bg-secondary)]">
                <IconComponent className={`h-4 w-4 mr-1 ${config.color.split(' ')[1]}`} />
                {config.label}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>
    </>
  );
}
