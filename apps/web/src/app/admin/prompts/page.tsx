'use client';

import { useState } from 'react';
import type { ElementType } from 'react';
import { trpc } from '@/trpc/client';
import {
  Wand2, Plus, Pencil, Trash2, Check, X,
  Code, Sparkles, BarChart3, Layers, RefreshCw,
  Star, Image as ImageIcon, MessageSquare, Video,
  BriefcaseBusiness, GraduationCap, Megaphone,
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
  DialogDescription,
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
import { Checkbox } from "@/components/ui/checkbox";
import AdminLoadingState from '@/components/admin/AdminLoadingState';
import AdminErrorState from '@/components/admin/AdminErrorState';

type ModuleCategory = 'writing' | 'marketing' | 'video' | 'business' | 'education' | 'coding' | 'analysis' | 'creative' | 'other';
type Platform = 'all' | 'web' | 'mobile' | 'desktop' | 'api';
type BadgeType = 'new' | 'hot' | 'recommend';

interface FeatureModule {
  id: string;
  title: string;
  description: string | null;
  full_description: string | null;
  prompt_content: string | null;
  system_prompt: string | null;
  user_prompt_template: string | null;
  model_id: string | null;
  platform: Platform;
  features: string | string[] | null;
  examples: string | string[] | null;
  preparation_questions: string | string[] | null;
  icon: string | null;
  image_url: string | null;
  badge_type: BadgeType | null;
  badge_text: string | null;
  credits_display: string | null;
  category: ModuleCategory;
  is_featured: string;
  active: string;
  sort_order: number;
  created_at: string;
}

type ModuleForm = {
  title: string;
  description: string;
  fullDescription: string;
  content: string;
  systemPrompt: string;
  userPromptTemplate: string;
  modelId: string;
  platform: Platform;
  features: string;
  examples: string;
  userQuestions: string;
  icon: string;
  imageUrl: string;
  badgeType: BadgeType | 'none';
  badgeText: string;
  creditsDisplay: string;
  category: ModuleCategory;
  sortOrder: string;
  active: boolean;
  isFeatured: boolean;
};

const platformConfig: Record<Platform, string> = {
  all: '全平台',
  web: '网页端',
  mobile: '移动端',
  desktop: '桌面端',
  api: 'API',
};

const iconOptions = [
  'Wand2', 'Sparkles', 'MessageSquare', 'Code', 'BarChart3', 'Brain',
  'Lightbulb', 'Rocket', 'Target', 'Zap', 'Star', 'BookOpen',
  'PenTool', 'Camera', 'Film', 'Globe', 'Search', 'Settings', 'Users',
];

const categoryConfig: Record<ModuleCategory, { label: string; color: string; icon: ElementType }> = {
  writing: { label: '内容创作', color: 'bg-sky-500/20 text-sky-300', icon: MessageSquare },
  marketing: { label: '营销文案', color: 'bg-fuchsia-500/20 text-fuchsia-300', icon: Megaphone },
  video: { label: '视频制作', color: 'bg-rose-500/20 text-rose-300', icon: Video },
  business: { label: '商务办公', color: 'bg-emerald-500/20 text-emerald-300', icon: BriefcaseBusiness },
  education: { label: '教育学习', color: 'bg-amber-500/20 text-amber-300', icon: GraduationCap },
  coding: { label: '编程开发', color: 'bg-cyan-500/20 text-cyan-300', icon: Code },
  analysis: { label: '分析洞察', color: 'bg-violet-500/20 text-violet-300', icon: BarChart3 },
  creative: { label: '创意策划', color: 'bg-pink-500/20 text-pink-300', icon: Sparkles },
  other: { label: '其他分类', color: 'bg-slate-500/20 text-slate-300', icon: Layers },
};

const BATCH_NO_CHANGE = '__UNCHANGED__' as const;
type BatchSentinel = typeof BATCH_NO_CHANGE;
type BatchEditForm = {
  category: ModuleCategory | BatchSentinel;
  platform: Platform | BatchSentinel;
  modelId: string | BatchSentinel;
  icon: string | BatchSentinel;
  isFeatured: 'true' | 'false' | BatchSentinel;
};

function createEmptyForm(): ModuleForm {
  return {
    title: '',
    description: '',
    fullDescription: '',
    content: '',
    systemPrompt: '',
    userPromptTemplate: '',
    modelId: '',
    platform: 'all',
    features: '',
    examples: '',
    userQuestions: '',
    icon: 'Wand2',
    imageUrl: '',
    badgeType: 'none',
    badgeText: '',
    creditsDisplay: '',
    category: 'other',
    sortOrder: '0',
    active: true,
    isFeatured: false,
  };
}

function parseJsonArray(value: string | string[] | null): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function stringToArray(value: string): string[] {
  return value.split('\n').map((item) => item.trim()).filter(Boolean);
}

export default function AdminPromptsPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [batchEditOpen, setBatchEditOpen] = useState(false);
  const [editingModule, setEditingModule] = useState<FeatureModule | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<ModuleCategory | 'all'>('all');
  const [selectedModuleIds, setSelectedModuleIds] = useState<string[]>([]);
  const [formData, setFormData] = useState<ModuleForm>(() => createEmptyForm());
  const [batchForm, setBatchForm] = useState<BatchEditForm>({
    category: BATCH_NO_CHANGE,
    platform: BATCH_NO_CHANGE,
    modelId: BATCH_NO_CHANGE,
    icon: BATCH_NO_CHANGE,
    isFeatured: BATCH_NO_CHANGE,
  });

  const { data: dashboard, isLoading, error, refetch } = trpc.admin.getPromptsDashboard.useQuery({
    limit: 50,
    category: categoryFilter === 'all' ? undefined : categoryFilter,
  });

  const createPrompt = trpc.admin.createPrompt.useMutation({
    onSuccess: async () => {
      await refetch();
      closeDialog();
    }
  });

  const updatePrompt = trpc.admin.updatePrompt.useMutation({
    onSuccess: async () => {
      await refetch();
      closeDialog();
    }
  });

  const deletePrompt = trpc.admin.deletePrompt.useMutation({
    onSuccess: async () => {
      await refetch();
    }
  });

  const batchUpdatePrompts = trpc.admin.batchUpdatePrompts.useMutation({
    onSuccess: async () => {
      await refetch();
      setBatchEditOpen(false);
      setSelectedModuleIds([]);
    }
  });

  const batchSetPromptActive = trpc.admin.batchSetPromptActive.useMutation({
    onSuccess: async () => {
      await refetch();
      setSelectedModuleIds([]);
    }
  });

  const batchDeletePrompts = trpc.admin.batchDeletePrompts.useMutation({
    onSuccess: async () => {
      await refetch();
      setSelectedModuleIds([]);
    }
  });

  const openCreateDialog = () => {
    setEditingModule(null);
    setFormData(createEmptyForm());
    setDialogOpen(true);
  };

  const openEditDialog = (module: FeatureModule) => {
    setEditingModule(module);
    setFormData({
      title: module.title,
      description: module.description || '',
      fullDescription: module.full_description || '',
      content: module.prompt_content || '',
      systemPrompt: module.system_prompt || '',
      userPromptTemplate: module.user_prompt_template || '',
      modelId: module.model_id || '',
      platform: module.platform || 'all',
      features: parseJsonArray(module.features).join('\n'),
      examples: parseJsonArray(module.examples).join('\n'),
      userQuestions: parseJsonArray(module.preparation_questions).join('\n'),
      icon: module.icon || 'Wand2',
      imageUrl: module.image_url || '',
      badgeType: module.badge_type || 'none',
      badgeText: module.badge_text || '',
      creditsDisplay: module.credits_display || '',
      category: module.category || 'other',
      sortOrder: String(module.sort_order ?? 0),
      active: module.active === 'true',
      isFeatured: module.is_featured === 'true',
    });
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingModule(null);
    setFormData(createEmptyForm());
  };

  const buildPayload = () => {
    const featuresArray = stringToArray(formData.features);
    const examplesArray = stringToArray(formData.examples);
    const userQuestionsArray = stringToArray(formData.userQuestions);

    return {
      name: formData.title,
      description: formData.description || undefined,
      fullDescription: formData.fullDescription || undefined,
      content: formData.content,
      systemPrompt: formData.systemPrompt || undefined,
      userPromptTemplate: formData.userPromptTemplate || undefined,
      modelId: formData.modelId || undefined,
      platform: formData.platform,
      features: featuresArray.length > 0 ? featuresArray : undefined,
      examples: examplesArray.length > 0 ? examplesArray : undefined,
      userQuestions: userQuestionsArray.length > 0 ? userQuestionsArray : undefined,
      icon: formData.icon,
      imageUrl: formData.imageUrl || undefined,
      badgeType: formData.badgeType === 'none' ? undefined : formData.badgeType,
      badgeText: formData.badgeText || undefined,
      creditsDisplay: formData.creditsDisplay || undefined,
      category: formData.category,
      sortOrder: parseInt(formData.sortOrder) || 0,
      active: formData.active ? 'true' as const : 'false' as const,
      isFeatured: formData.isFeatured ? 'true' as const : 'false' as const,
    };
  };

  const handleSubmit = () => {
    const payload = buildPayload();

    if (editingModule) {
      updatePrompt.mutate({
        id: editingModule.id,
        ...payload,
        description: formData.description || null,
        fullDescription: formData.fullDescription || null,
        systemPrompt: formData.systemPrompt || null,
        userPromptTemplate: formData.userPromptTemplate || null,
        modelId: formData.modelId || null,
        features: payload.features ?? null,
        examples: payload.examples ?? null,
        userQuestions: payload.userQuestions ?? null,
        imageUrl: formData.imageUrl || null,
        badgeType: formData.badgeType === 'none' ? null : formData.badgeType,
        badgeText: formData.badgeText || null,
        creditsDisplay: formData.creditsDisplay || null,
      });
      return;
    }

    createPrompt.mutate(payload);
  };

  const handleToggleActive = (module: FeatureModule) => {
    updatePrompt.mutate({
      id: module.id,
      active: module.active === 'true' ? 'false' : 'true',
    });
  };

  const handleToggleFeatured = (module: FeatureModule) => {
    updatePrompt.mutate({
      id: module.id,
      isFeatured: module.is_featured === 'true' ? 'false' : 'true',
    });
  };

  const handleDisable = (module: FeatureModule) => {
    if (confirm(`确定要下架功能模块 "${module.title}" 吗？下架后前台功能广场将不再展示。`)) {
      deletePrompt.mutate({ id: module.id });
    }
  };

  const handleToggleModuleSelection = (moduleId: string, checked: boolean) => {
    setSelectedModuleIds((current) => {
      if (checked) {
        return current.includes(moduleId) ? current : [...current, moduleId];
      }
      return current.filter((id) => id !== moduleId);
    });
  };

  const handleToggleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedModuleIds(modules.map((module: FeatureModule) => module.id));
      return;
    }

    setSelectedModuleIds([]);
  };

  const handleBatchSetActive = (active: boolean) => {
    if (selectedModuleIds.length === 0) return;
    batchSetPromptActive.mutate({
      ids: selectedModuleIds,
      active,
    });
  };

  const handleOpenBatchEdit = () => {
    if (selectedModuleIds.length === 0) return;
    setBatchForm({
      category: BATCH_NO_CHANGE,
      platform: BATCH_NO_CHANGE,
      modelId: BATCH_NO_CHANGE,
      icon: BATCH_NO_CHANGE,
      isFeatured: BATCH_NO_CHANGE,
    });
    setBatchEditOpen(true);
  };

  const handleBatchEditSubmit = () => {
    const patch: Record<string, unknown> = {};

    if (batchForm.category !== BATCH_NO_CHANGE) patch.category = batchForm.category;
    if (batchForm.platform !== BATCH_NO_CHANGE) patch.platform = batchForm.platform;
    if (batchForm.modelId !== BATCH_NO_CHANGE) patch.modelId = batchForm.modelId === 'none' ? null : batchForm.modelId;
    if (batchForm.icon !== BATCH_NO_CHANGE) patch.icon = batchForm.icon;
    if (batchForm.isFeatured !== BATCH_NO_CHANGE) patch.isFeatured = batchForm.isFeatured;

    if (Object.keys(patch).length === 0) {
      alert('请至少选择一个要批量更新的字段');
      return;
    }

    batchUpdatePrompts.mutate({
      ids: selectedModuleIds,
      patch,
    });
  };

  const handleBatchDisable = () => {
    if (selectedModuleIds.length === 0) return;
    if (!confirm(`确定要下架选中的 ${selectedModuleIds.length} 个功能模块吗？下架后前台功能广场将不再展示。`)) {
      return;
    }

    batchDeletePrompts.mutate({
      ids: selectedModuleIds,
    });
  };

  if (isLoading) {
    return <AdminLoadingState />;
  }

  if (error) {
    return <AdminErrorState error={error} onRetry={() => refetch()} />;
  }

  const modules = dashboard?.modules ?? dashboard?.prompts ?? [];
  const hasSelectedModules = selectedModuleIds.length > 0;
  const allModulesSelected = modules.length > 0 && selectedModuleIds.length === modules.length;
  const stats = dashboard?.stats ?? {
    total: 0,
    active: 0,
    inactive: 0,
    featured: 0,
    byCategory: {
      writing: 0,
      marketing: 0,
      video: 0,
      business: 0,
      education: 0,
      coding: 0,
      analysis: 0,
      creative: 0,
      other: 0,
    },
  };
  const modelsData = dashboard?.models ?? [];

  return (
    <div className="p-8 overflow-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
            功能模块 / 提示词
          </h1>
          <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
            管理功能广场展示、排序、精选状态和模块运行提示词
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
                onClick={() => handleBatchSetActive(false)}
                className="border-amber-500/40 text-amber-300 hover:bg-amber-500/10"
              >
                <X className="h-4 w-4 mr-2" />
                批量下架
              </Button>
              <Button
                variant="outline"
                onClick={handleBatchDisable}
                className="border-rose-500/40 text-rose-300 hover:bg-rose-500/10"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                下架选中
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
                        className={module.is_featured === 'true'
                          ? 'bg-amber-500/20 text-amber-300 cursor-pointer'
                          : 'bg-slate-500/20 text-slate-300 cursor-pointer'
                        }
                        onClick={() => handleToggleFeatured(module)}
                      >
                        <Star className="h-3 w-3 mr-1" />
                        {module.is_featured === 'true' ? '精选' : '普通'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span style={{ color: 'var(--text-primary)' }}>{module.sort_order}</span>
                    </TableCell>
                    <TableCell>
                      <Badge
                        data-testid={`admin-prompt-toggle-${module.id}`}
                        className={module.active === 'true'
                          ? 'bg-emerald-500/20 text-emerald-400 cursor-pointer'
                          : 'bg-rose-500/20 text-rose-400 cursor-pointer'
                        }
                        onClick={() => handleToggleActive(module)}
                      >
                        {module.active === 'true' ? (
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
                          onClick={() => handleDisable(module)}
                          disabled={module.active !== 'true'}
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

      <Dialog open={dialogOpen} onOpenChange={(open) => (open ? setDialogOpen(true) : closeDialog())}>
        <DialogContent
          className="max-w-3xl"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
        >
          <DialogHeader>
            <DialogTitle style={{ color: 'var(--text-primary)' }}>
              {editingModule ? '编辑功能模块' : '新建功能模块'}
            </DialogTitle>
            <DialogDescription className="sr-only">
              编辑功能广场展示信息和该模块进入聊天时使用的提示词配置。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4 max-h-[65vh] overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>模块名称 *</Label>
                <Input
                  data-testid="prompt-name-input"
                  value={formData.title}
                  onChange={(event) => setFormData({ ...formData, title: event.target.value })}
                  placeholder="如：短视频脚本生成"
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                />
              </div>

              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>分类</Label>
                <Select
                  value={formData.category}
                  onValueChange={(value) => setFormData({ ...formData, category: value as ModuleCategory })}
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
                <Select value={formData.icon} onValueChange={(value) => setFormData({ ...formData, icon: value })}>
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
                  onValueChange={(value) => setFormData({ ...formData, platform: value as Platform })}
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
                  onValueChange={(value) => setFormData({ ...formData, modelId: value === 'none' ? '' : value })}
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
              <Label style={{ color: 'var(--text-secondary)' }}>卡片描述</Label>
              <Input
                data-testid="prompt-description-input"
                value={formData.description}
                onChange={(event) => setFormData({ ...formData, description: event.target.value })}
                placeholder="一句话说明这个模块在功能广场里的用途"
                className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
              />
            </div>

            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>详细介绍</Label>
              <Textarea
                value={formData.fullDescription}
                onChange={(event) => setFormData({ ...formData, fullDescription: event.target.value })}
                placeholder="用于模块详情弹窗的长说明"
                rows={3}
                className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)] text-sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>展示图 URL</Label>
                <Input
                  value={formData.imageUrl}
                  onChange={(event) => setFormData({ ...formData, imageUrl: event.target.value })}
                  placeholder="https://..."
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                />
              </div>
              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>积分展示文案</Label>
                <Input
                  value={formData.creditsDisplay}
                  onChange={(event) => setFormData({ ...formData, creditsDisplay: event.target.value })}
                  placeholder="按实际 token 计费"
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>徽标类型</Label>
                <Select
                  value={formData.badgeType}
                  onValueChange={(value) => setFormData({ ...formData, badgeType: value as ModuleForm['badgeType'] })}
                >
                  <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                    <SelectItem value="none">无</SelectItem>
                    <SelectItem value="new">NEW</SelectItem>
                    <SelectItem value="hot">HOT</SelectItem>
                    <SelectItem value="recommend">推荐</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>徽标文字</Label>
                <Input
                  value={formData.badgeText}
                  onChange={(event) => setFormData({ ...formData, badgeText: event.target.value })}
                  placeholder="新品"
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                />
              </div>
              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>排序权重</Label>
                <Input
                  data-testid="prompt-sort-order-input"
                  type="number"
                  min="0"
                  max="1000"
                  value={formData.sortOrder}
                  onChange={(event) => setFormData({ ...formData, sortOrder: event.target.value })}
                  placeholder="0"
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>模块提示词 *</Label>
              <Textarea
                data-testid="prompt-content-input"
                value={formData.content}
                onChange={(event) => setFormData({ ...formData, content: event.target.value })}
                placeholder="用户点击该模块进入 chat 后，模块会使用这里的提示词"
                rows={4}
                className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)] font-mono text-sm"
              />
            </div>

            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>模块系统提示词</Label>
              <Textarea
                value={formData.systemPrompt}
                onChange={(event) => setFormData({ ...formData, systemPrompt: event.target.value })}
                placeholder="这个模块下 AI 的角色和行为边界"
                rows={3}
                className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)] font-mono text-sm"
              />
            </div>

            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>用户输入模板</Label>
              <Textarea
                value={formData.userPromptTemplate}
                onChange={(event) => setFormData({ ...formData, userPromptTemplate: event.target.value })}
                placeholder="使用 {{input}} 表示用户输入"
                rows={3}
                className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)] font-mono text-sm"
              />
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>功能特点</Label>
                <Textarea
                  value={formData.features}
                  onChange={(event) => setFormData({ ...formData, features: event.target.value })}
                  placeholder="每行一个"
                  rows={4}
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)] text-sm"
                />
              </div>

              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>使用示例</Label>
                <Textarea
                  value={formData.examples}
                  onChange={(event) => setFormData({ ...formData, examples: event.target.value })}
                  placeholder="每行一个"
                  rows={4}
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)] text-sm"
                />
              </div>

              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>准备问题</Label>
                <Textarea
                  value={formData.userQuestions}
                  onChange={(event) => setFormData({ ...formData, userQuestions: event.target.value })}
                  placeholder="每行一个"
                  rows={4}
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)] text-sm"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="flex items-center justify-between rounded-lg p-3" style={{ background: 'var(--bg-tertiary)' }}>
                <div>
                  <Label style={{ color: 'var(--text-secondary)' }}>前台展示</Label>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                    关闭后该模块不会出现在功能广场。
                  </p>
                </div>
                <Switch
                  data-testid="module-active-switch"
                  checked={formData.active}
                  onCheckedChange={(checked) => setFormData({ ...formData, active: checked })}
                />
              </div>

              <div className="flex items-center justify-between rounded-lg p-3" style={{ background: 'var(--bg-tertiary)' }}>
                <div>
                  <Label style={{ color: 'var(--text-secondary)' }}>精选置顶</Label>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                    开启后进入首页和功能广场精选列表。
                  </p>
                </div>
                <Switch
                  data-testid="module-featured-switch"
                  checked={formData.isFeatured}
                  onCheckedChange={(checked) => setFormData({ ...formData, isFeatured: checked })}
                />
              </div>
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
              disabled={!formData.title || !formData.content || createPrompt.isPending || updatePrompt.isPending}
              className="bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
            >
              {createPrompt.isPending || updatePrompt.isPending ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
                    {modelsData?.map((model) => (
                      <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>
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
                    <SelectItem value="true">设为精选</SelectItem>
                    <SelectItem value="false">取消精选</SelectItem>
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
    </div>
  );
}
