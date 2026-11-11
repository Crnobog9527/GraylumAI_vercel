/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { Wand2, Pencil, Trash2, Check, X, Star, Image as ImageIcon } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { categoryConfig, type FeatureModule } from './promptsShared';
import type { PromptsAdmin } from './usePromptsAdmin';

// 功能模块列表。从 page.tsx 原样搬出。
export function PromptsTable({ admin }: { admin: PromptsAdmin }) {
  const {
    selectedModuleIds, deletePrompt, openEditDialog, handleToggleActive, handleToggleFeatured, handleDelete,
    handleToggleModuleSelection, handleToggleSelectAll, modules, allModulesSelected,
  } = admin;

  return (
    <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[48px]">
                <Checkbox
                  checked={allModulesSelected}
                  onCheckedChange={(checked) => handleToggleSelectAll(Boolean(checked))}
                  aria-label="Select all modules"
                />
              </TableHead>
              <TableHead>模块</TableHead>
              <TableHead>分类</TableHead>
              <TableHead>精选</TableHead>
              <TableHead>排序</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead className="w-[132px]">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {modules.map((module: FeatureModule) => {
              const config = categoryConfig[module.category] ?? categoryConfig.other;
              const CategoryIcon = config.icon;
              const isSelected = selectedModuleIds.includes(module.id);
              return (
                <TableRow key={module.id} data-testid={`admin-prompt-row-${module.id}`}>
                  <TableCell>
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={(checked) => handleToggleModuleSelection(module.id, Boolean(checked))}
                      aria-label={`Select module ${module.title}`}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                        <Wand2 className="h-4 w-4 text-[var(--color-primary)]" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <p data-testid="admin-prompt-name" className="font-medium" style={{ color: 'var(--text-primary)' }}>
                            {module.title}
                          </p>
                          {module.image_url && <ImageIcon className="h-3 w-3 text-sky-300" />}
                        </div>
                        <p className="text-xs truncate max-w-[280px]" style={{ color: 'var(--text-tertiary)' }}>
                          {module.description || module.prompt_content || '未填写模块说明'}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge className={config.color}>
                      <CategoryIcon className="h-3 w-3 mr-1" />
                      {config.label}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      className={module.is_featured
                        ? 'bg-amber-500/20 text-amber-300 cursor-pointer'
                        : 'bg-slate-500/20 text-slate-300 cursor-pointer'
                      }
                      onClick={() => handleToggleFeatured(module)}
                    >
                      <Star className="h-3 w-3 mr-1" />
                      {module.is_featured ? '精选' : '普通'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span style={{ color: 'var(--text-primary)' }}>{module.sort_order}</span>
                  </TableCell>
                  <TableCell>
                    <Badge
                      data-testid={`admin-prompt-toggle-${module.id}`}
                      className={module.active
                        ? 'bg-emerald-500/20 text-emerald-400 cursor-pointer'
                        : 'bg-rose-500/20 text-rose-400 cursor-pointer'
                      }
                      onClick={() => handleToggleActive(module)}
                    >
                      {module.active ? (
                        <>
                          <Check className="h-3 w-3 mr-1" />
                          展示中
                        </>
                      ) : (
                        <>
                          <X className="h-3 w-3 mr-1" />
                          已下架
                        </>
                      )}
                    </Badge>
                  </TableCell>
                  <TableCell style={{ color: 'var(--text-tertiary)' }}>
                    {new Date(module.created_at).toLocaleDateString('zh-CN')}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        data-testid={`admin-prompt-edit-${module.id}`}
                        onClick={() => openEditDialog(module)}
                        className="h-8 w-8 text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)]"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        data-testid={`admin-prompt-delete-${module.id}`}
                        onClick={() => handleDelete(module)}
                        disabled={deletePrompt.isPending}
                        aria-label={`删除 ${module.title}`}
                        className="h-8 w-8 text-rose-400 hover:bg-rose-500/20 disabled:opacity-30"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {modules.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-12" style={{ color: 'var(--text-disabled)' }}>
                  暂无功能模块，点击上方按钮创建
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
