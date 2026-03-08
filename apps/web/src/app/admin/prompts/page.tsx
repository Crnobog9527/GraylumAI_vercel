'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import {
  Wand2, Plus, Pencil, Trash2, Check, X,
  Code, MessageSquare, Sparkles, Languages, BarChart3,
  Layers, RefreshCw, Lock
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import AdminLoadingState from '@/components/admin/AdminLoadingState';
import AdminErrorState from '@/components/admin/AdminErrorState';

type PromptCategory = 'general' | 'assistant' | 'creative' | 'coding' | 'translation' | 'analysis';
type Platform = 'all' | 'web' | 'mobile' | 'desktop' | 'api';

interface Prompt {
  id: string;
  name: string;
  description: string | null;
  content: string;
  system_prompt: string | null;
  user_prompt_template: string | null;
  model_id: string | null;
  platform: Platform;
  features: string | null;
  user_questions: string | null;
  icon: string;
  category: PromptCategory;
  is_system: string;
  active: string;
  sort_order: number;
  created_at: string;
}

const platformConfig: Record<Platform, string> = {
  all: '全平台',
  web: '网页端',
  mobile: '移动端',
  desktop: '桌面端',
  api: 'API',
};

const iconOptions = [
  'Wand2', 'Sparkles', 'MessageSquare', 'Code', 'Languages', 'BarChart3',
  'Brain', 'Lightbulb', 'Rocket', 'Target', 'Zap', 'Star', 'Heart', 'BookOpen',
  'PenTool', 'Camera', 'Music', 'Film', 'Globe', 'Search', 'Settings', 'Users',
];

const categoryConfig: Record<PromptCategory, { label: string; color: string; icon: React.ElementType }> = {
  general: { label: '通用', color: 'bg-slate-500/20 text-slate-400', icon: Layers },
  assistant: { label: '助手', color: 'bg-blue-500/20 text-blue-400', icon: MessageSquare },
  creative: { label: '创意', color: 'bg-purple-500/20 text-purple-400', icon: Sparkles },
  coding: { label: '编程', color: 'bg-emerald-500/20 text-emerald-400', icon: Code },
  translation: { label: '翻译', color: 'bg-amber-500/20 text-amber-400', icon: Languages },
  analysis: { label: '分析', color: 'bg-rose-500/20 text-rose-400', icon: BarChart3 },
};

export default function AdminPromptsPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<Prompt | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<PromptCategory | 'all'>('all');
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    content: '',
    systemPrompt: '',
    userPromptTemplate: '',
    modelId: '',
    platform: 'all' as Platform,
    features: '',
    userQuestions: '',
    icon: 'Wand2',
    category: 'general' as PromptCategory,
    sortOrder: '0',
    isSystem: false,
  });

  // Fetch models for selector
  const { data: modelsData } = trpc.model.getActiveModels.useQuery();

  const { data, isLoading, error, refetch } = trpc.admin.getAllPrompts.useQuery({
    limit: 50,
    category: categoryFilter === 'all' ? undefined : categoryFilter,
  });

  const createPrompt = trpc.admin.createPrompt.useMutation({
    onSuccess: () => {
      refetch();
      closeDialog();
    }
  });

  const updatePrompt = trpc.admin.updatePrompt.useMutation({
    onSuccess: () => {
      refetch();
      closeDialog();
    }
  });

  const deletePrompt = trpc.admin.deletePrompt.useMutation({
    onSuccess: () => {
      refetch();
    }
  });

  const openCreateDialog = () => {
    setEditingPrompt(null);
    setFormData({
      name: '',
      description: '',
      content: '',
      systemPrompt: '',
      userPromptTemplate: '',
      modelId: '',
      platform: 'all',
      features: '',
      userQuestions: '',
      icon: 'Wand2',
      category: 'general',
      sortOrder: '0',
      isSystem: false,
    });
    setDialogOpen(true);
  };

  const parseJsonArray = (str: string | null): string[] => {
    if (!str) return [];
    try {
      return JSON.parse(str);
    } catch {
      return [];
    }
  };

  const openEditDialog = (prompt: Prompt) => {
    setEditingPrompt(prompt);
    setFormData({
      name: prompt.name,
      description: prompt.description || '',
      content: prompt.content,
      systemPrompt: prompt.system_prompt || '',
      userPromptTemplate: prompt.user_prompt_template || '',
      modelId: prompt.model_id || '',
      platform: prompt.platform || 'all',
      features: parseJsonArray(prompt.features).join('\n'),
      userQuestions: parseJsonArray(prompt.user_questions).join('\n'),
      icon: prompt.icon || 'Wand2',
      category: prompt.category,
      sortOrder: prompt.sort_order.toString(),
      isSystem: prompt.is_system === 'true',
    });
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingPrompt(null);
    setFormData({
      name: '',
      description: '',
      content: '',
      systemPrompt: '',
      userPromptTemplate: '',
      modelId: '',
      platform: 'all',
      features: '',
      userQuestions: '',
      icon: 'Wand2',
      category: 'general',
      sortOrder: '0',
      isSystem: false,
    });
  };

  const stringToArray = (str: string): string[] => {
    return str.split('\n').map(s => s.trim()).filter(s => s.length > 0);
  };

  const handleSubmit = () => {
    const sortOrder = parseInt(formData.sortOrder) || 0;
    const featuresArray = stringToArray(formData.features);
    const userQuestionsArray = stringToArray(formData.userQuestions);

    if (editingPrompt) {
      updatePrompt.mutate({
        id: editingPrompt.id,
        name: formData.name,
        description: formData.description || null,
        content: formData.content,
        systemPrompt: formData.systemPrompt || null,
        userPromptTemplate: formData.userPromptTemplate || null,
        modelId: formData.modelId || null,
        platform: formData.platform,
        features: featuresArray.length > 0 ? featuresArray : null,
        userQuestions: userQuestionsArray.length > 0 ? userQuestionsArray : null,
        icon: formData.icon,
        category: formData.category,
        sortOrder,
        isSystem: formData.isSystem ? 'true' : 'false',
      });
    } else {
      createPrompt.mutate({
        name: formData.name,
        description: formData.description || undefined,
        content: formData.content,
        systemPrompt: formData.systemPrompt || undefined,
        userPromptTemplate: formData.userPromptTemplate || undefined,
        modelId: formData.modelId || undefined,
        platform: formData.platform,
        features: featuresArray.length > 0 ? featuresArray : undefined,
        userQuestions: userQuestionsArray.length > 0 ? userQuestionsArray : undefined,
        icon: formData.icon,
        category: formData.category,
        sortOrder,
        isSystem: formData.isSystem ? 'true' : 'false',
      });
    }
  };

  const handleToggleActive = (prompt: Prompt) => {
    updatePrompt.mutate({
      id: prompt.id,
      active: prompt.active === 'true' ? 'false' : 'true',
    });
  };

  const handleDelete = (prompt: Prompt) => {
    if (prompt.is_system === 'true') {
      alert('系统提示词不能删除');
      return;
    }
    if (confirm(`确定要删除提示词 "${prompt.name}" 吗？`)) {
      deletePrompt.mutate({ id: prompt.id });
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

  const prompts = data?.prompts ?? [];
  const stats = data?.stats ?? {
    total: 0, active: 0, inactive: 0, system: 0,
    byCategory: { general: 0, assistant: 0, creative: 0, coding: 0, translation: 0, analysis: 0 }
  };

  return (
    <div className="p-8 overflow-auto">
      {/* Page Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
              提示词模块
            </h1>
            <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
              管理系统提示词模板
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
              新建提示词
            </Button>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-[var(--color-primary-20)]">
                  <Wand2 className="h-6 w-6 text-[var(--color-primary)]" />
                </div>
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总提示词</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {stats.total}
                  </p>
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
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>已启用</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {stats.active}
                  </p>
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
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>已禁用</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {stats.inactive}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-blue-500/20">
                  <Lock className="h-6 w-6 text-blue-400" />
                </div>
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>系统级</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {stats.system}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Category Filter Tabs */}
        <Tabs value={categoryFilter} onValueChange={(v) => setCategoryFilter(v as typeof categoryFilter)} className="mb-6">
          <TabsList className="bg-[var(--bg-tertiary)]">
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

        {/* Prompts Table */}
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>分类</TableHead>
                  <TableHead>排序</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="w-[120px]">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {prompts.map((prompt: Prompt) => {
                  const config = categoryConfig[prompt.category];
                  const CategoryIcon = config.icon;
                  return (
                    <TableRow key={prompt.id} data-testid={`admin-prompt-row-${prompt.id}`}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div
                            className="p-2 rounded-lg"
                            style={{ background: 'var(--bg-tertiary)' }}
                          >
                            <Wand2 className="h-4 w-4 text-[var(--color-primary)]" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <p data-testid="admin-prompt-name" className="font-medium" style={{ color: 'var(--text-primary)' }}>
                                {prompt.name}
                              </p>
                              {prompt.is_system === 'true' && (
                                <Lock className="h-3 w-3 text-blue-400" />
                              )}
                            </div>
                            <p className="text-xs truncate max-w-[250px]" style={{ color: 'var(--text-tertiary)' }}>
                              {prompt.description || prompt.content.slice(0, 50)}...
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
                        <span style={{ color: 'var(--text-primary)' }}>
                          {prompt.sort_order}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge
                          data-testid={`admin-prompt-toggle-${prompt.id}`}
                          className={prompt.active === 'true'
                            ? 'bg-emerald-500/20 text-emerald-400 cursor-pointer'
                            : 'bg-rose-500/20 text-rose-400 cursor-pointer'
                          }
                          onClick={() => handleToggleActive(prompt)}
                        >
                          {prompt.active === 'true' ? (
                            <>
                              <Check className="h-3 w-3 mr-1" />
                              已启用
                            </>
                          ) : (
                            <>
                              <X className="h-3 w-3 mr-1" />
                              已禁用
                            </>
                          )}
                        </Badge>
                      </TableCell>
                      <TableCell style={{ color: 'var(--text-tertiary)' }}>
                        {new Date(prompt.created_at).toLocaleDateString('zh-CN')}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            data-testid={`admin-prompt-edit-${prompt.id}`}
                            onClick={() => openEditDialog(prompt)}
                            className="h-8 w-8 text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)]"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            data-testid={`admin-prompt-delete-${prompt.id}`}
                            onClick={() => handleDelete(prompt)}
                            disabled={prompt.is_system === 'true'}
                            className="h-8 w-8 text-rose-400 hover:bg-rose-500/20 disabled:opacity-30"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {prompts.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-12" style={{ color: 'var(--text-disabled)' }}>
                      暂无提示词，点击上方按钮创建
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Create/Edit Dialog */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent
            className="max-w-2xl"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
          >
            <DialogHeader>
              <DialogTitle style={{ color: 'var(--text-primary)' }}>
                {editingPrompt ? '编辑提示词' : '新建提示词'}
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-4 py-4 max-h-[60vh] overflow-y-auto">
              {/* 基础信息 */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>名称 *</Label>
                  <Input
                    data-testid="prompt-name-input"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="如：通用助手"
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  />
                </div>

                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>分类</Label>
                  <Select
                    value={formData.category}
                    onValueChange={(v) => setFormData({ ...formData, category: v as PromptCategory })}
                  >
                    <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                      {Object.entries(categoryConfig).map(([key, config]) => {
                        const IconComponent = config.icon;
                        return (
                          <SelectItem key={key} value={key}>
                            <div className="flex items-center gap-2">
                              <IconComponent className={`h-4 w-4 ${config.color.split(' ')[1]}`} />
                              {config.label}
                            </div>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>图标</Label>
                  <Select
                    value={formData.icon}
                    onValueChange={(v) => setFormData({ ...formData, icon: v })}
                  >
                    <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                      {iconOptions.map((icon) => (
                        <SelectItem key={icon} value={icon}>{icon}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>适用平台</Label>
                  <Select
                    value={formData.platform}
                    onValueChange={(v) => setFormData({ ...formData, platform: v as Platform })}
                  >
                    <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                      {Object.entries(platformConfig).map(([key, label]) => (
                        <SelectItem key={key} value={key}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>指定模型</Label>
                  <Select
                    value={formData.modelId || 'none'}
                    onValueChange={(v) => setFormData({ ...formData, modelId: v === 'none' ? '' : v })}
                  >
                    <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                      <SelectValue placeholder="不限制" />
                    </SelectTrigger>
                    <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                      <SelectItem value="none">不限制</SelectItem>
                      {modelsData?.map((model) => (
                        <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>描述 (可选)</Label>
                <Input
                  data-testid="prompt-description-input"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="简短描述这个提示词的用途"
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                />
              </div>

              {/* 提示词内容 */}
              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>提示词内容 *</Label>
                <Textarea
                  data-testid="prompt-content-input"
                  value={formData.content}
                  onChange={(e) => setFormData({ ...formData, content: e.target.value })}
                  placeholder="输入提示词内容..."
                  rows={4}
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)] font-mono text-sm"
                />
              </div>

              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>系统提示词 (可选)</Label>
                <Textarea
                  value={formData.systemPrompt}
                  onChange={(e) => setFormData({ ...formData, systemPrompt: e.target.value })}
                  placeholder="AI 的角色定义和行为指导..."
                  rows={3}
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)] font-mono text-sm"
                />
              </div>

              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>用户提示词模板 (可选)</Label>
                <Textarea
                  value={formData.userPromptTemplate}
                  onChange={(e) => setFormData({ ...formData, userPromptTemplate: e.target.value })}
                  placeholder="用户消息的模板，使用 {{input}} 表示用户输入..."
                  rows={3}
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)] font-mono text-sm"
                />
              </div>

              {/* 模块特点和用户问题 */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>模块特点 (每行一个)</Label>
                  <Textarea
                    value={formData.features}
                    onChange={(e) => setFormData({ ...formData, features: e.target.value })}
                    placeholder="快速响应&#10;支持多语言&#10;专业准确"
                    rows={4}
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)] text-sm"
                  />
                </div>

                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>用户准备问题 (每行一个)</Label>
                  <Textarea
                    value={formData.userQuestions}
                    onChange={(e) => setFormData({ ...formData, userQuestions: e.target.value })}
                    placeholder="帮我写一篇文章&#10;翻译这段话&#10;解释这个概念"
                    rows={4}
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)] text-sm"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>排序权重 (数字越大越靠前)</Label>
                <Input
                  data-testid="prompt-sort-order-input"
                  type="number"
                  min="0"
                  max="1000"
                  value={formData.sortOrder}
                  onChange={(e) => setFormData({ ...formData, sortOrder: e.target.value })}
                  placeholder="0"
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)] w-32"
                />
              </div>

              <div className="flex items-center justify-between rounded-lg p-3" style={{ background: 'var(--bg-tertiary)' }}>
                <div>
                  <Label style={{ color: 'var(--text-secondary)' }}>作为系统提示词</Label>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                    系统提示词会参与聊天运行时选择，仅用于管理员可控的全局 AI 行为。
                  </p>
                </div>
                <Switch
                  data-testid="prompt-is-system-switch"
                  checked={formData.isSystem}
                  onCheckedChange={(checked) => setFormData({ ...formData, isSystem: checked })}
                />
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={closeDialog}
                className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
              >
                取消
              </Button>
              <Button
                data-testid="prompt-save"
                onClick={handleSubmit}
                disabled={!formData.name || !formData.content || createPrompt.isPending || updatePrompt.isPending}
                className="bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
              >
                {createPrompt.isPending || updatePrompt.isPending ? '保存中...' : '保存'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
    </div>
  );
}
