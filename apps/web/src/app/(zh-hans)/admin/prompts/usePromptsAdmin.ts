/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState } from 'react';
import { emptySkillForm, skillPublicationFields, type SkillForm } from './module-skill-editor';
import { trpc } from '@/trpc/client';
import { toast } from 'sonner';
import {
  BATCH_NO_CHANGE, createEmptyForm, parseJsonArray, stringToArray,
  type ModuleCategory, type FeatureModule, type ModuleForm, type BatchEditForm,
} from './promptsShared';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@repo/api/src/root';

// Named so the hook's return type can be exported (the server-side type behind it cannot be imported here by name).
export interface SkillModelsView { data: inferRouterOutputs<AppRouter>['settings']['getSummaryModels'] | undefined }

// 功能模块后台页的全部状态、请求和操作。从 page.tsx 原样搬出：页面只负责加载/出错状态和摆放各块界面。
export function usePromptsAdmin() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [mode, setMode] = useState<'prompt' | 'skill'>('prompt');
  const skillModels = trpc.settings.getSummaryModels.useQuery({use:'skill'},{enabled:mode==='skill'});
  const [skillForm, setSkillForm] = useState<SkillForm>(emptySkillForm);
  const [skillIdentity, setSkillIdentity] = useState<{
    moduleId: string; skillId: string; revisionId: string; requestId: string; expectedVersion: number
  } | null>(null);
  const [skillError, setSkillError] = useState('');
  const [skillLoading, setSkillLoading] = useState(false);
  const [skillReading, setSkillReading] = useState(false);
  const editorSession = useRef(0);
  const currentEditorSession = editorSession.current;
  const utils = trpc.useUtils();
  const saveSkill = trpc.skills.saveModule.useMutation({ onSuccess: async () => {
    await refetch(); editorSession.current++; setDialogOpen(false); setEditingModule(null); setSkillIdentity(null);
    setFormData(createEmptyForm());
  } });
  const resetSkill = (module?: FeatureModule) => {
    editorSession.current++; setSkillReading(false); setSkillLoading(false);
    setSkillForm(emptySkillForm()); setSkillError('');
    setSkillIdentity({ moduleId: module?.id ?? crypto.randomUUID(), skillId: module?.skill_id ?? crypto.randomUUID(),
      revisionId: crypto.randomUUID(), requestId: crypto.randomUUID(), expectedVersion: 0 });
  };
  const [batchEditOpen, setBatchEditOpen] = useState(false);
  const [editingModule, setEditingModule] = useState<FeatureModule | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<ModuleCategory | 'all'>('all');
  const [confirmation, setConfirmation] = useState<{ kind: 'delete' | 'disable'; ids: string[]; title: string } | null>(null);
  const [confirmationError, setConfirmationError] = useState('');
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

  useEffect(() => {
    if (!dashboard) return;
    const present = new Set((dashboard.modules ?? dashboard.prompts ?? []).map(m => m.id));
    setSelectedModuleIds(ids => ids.filter(id => present.has(id)));
  }, [dashboard]);

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

  const deletePrompt = trpc.admin.removePrompts.useMutation({
    onError: error => setConfirmationError(error.message),
    onSuccess: async (result, input) => {
      // Only remove rows after the server confirms the atomic deletion. Cancel
      // older reads so they cannot put deleted rows back while we reconcile.
      await utils.admin.getPromptsDashboard.cancel();
      const deleted = new Set(input.ids);
      utils.admin.getPromptsDashboard.setData({
        limit: 50, category: categoryFilter === 'all' ? undefined : categoryFilter,
      }, current => {
        if (!current) return current;
        const removed = current.modules.filter(module => deleted.has(module.id));
        const modules = current.modules.filter(module => !deleted.has(module.id));
        const stats = { ...current.stats, byCategory: { ...current.stats.byCategory } };
        for (const module of removed) {
          stats.total = Math.max(0, stats.total - 1);
          if (module.active) stats.active = Math.max(0, stats.active - 1);
          else stats.inactive = Math.max(0, stats.inactive - 1);
          if (module.is_featured) stats.featured = Math.max(0, stats.featured - 1);
          if (module.category) stats.byCategory[module.category] = Math.max(0, (stats.byCategory[module.category] ?? 0) - 1);
        }
        return { ...current, modules, prompts: modules, stats, total: Math.max(0, current.total - removed.length) };
      });
      setSelectedModuleIds(ids => ids.filter(id => !deleted.has(id)));
      setConfirmation(null);
      toast.success(result.deletedIds.length ? `已删除 ${result.deletedIds.length} 个模块` : '所选模块已不存在');
      // Refill the page and reconcile global counts without extending the
      // delete pending state. Keep confirmed results if that read fails.
      void utils.admin.getPromptsDashboard.invalidate();
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
    onError: error => setConfirmationError(error.message),
    onSuccess: async () => {
      setConfirmation(null);
      await refetch();
      setSelectedModuleIds([]);
    }
  });

  const openCreateDialog = () => {
    resetSkill(); setMode('prompt');
    setEditingModule(null);
    setFormData(createEmptyForm());
    setDialogOpen(true);
  };

  const openEditDialog = (module: FeatureModule) => {
    resetSkill(module); setMode(module.skill_id ? 'skill' : 'prompt');
    if (module.skill_id) {
      const session = editorSession.current;
      setSkillLoading(true);
      void utils.skills.readModule.fetch({ id: module.id }).then(data => {
        if (session !== editorSession.current) return;
        if (!data) throw new Error('Skill 配置不存在');
        setSkillIdentity(current => current?.moduleId === module.id ? { ...current, skillId: data.skillId, expectedVersion: data.expectedVersion } : current);
        setSkillForm({ directoryName: data.directoryName, kind: data.workflow.kind, files: data.files,
          planResources: data.workflow.planResources, reportGeneration: data.workflow.reportGeneration,
          steps: data.workflow.steps.map(s => ({ title: s.title, resources: s.resources, information:s.information })), reviewed: false });
      }).catch(e => { if (session === editorSession.current) setSkillError(e instanceof Error ? e.message : '读取 Skill 失败'); })
        .finally(() => { if (session === editorSession.current) setSkillLoading(false); });
    }
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
      active: module.active,
      isFeatured: module.is_featured,
    });
    setDialogOpen(true);
  };

  const closeDialog = () => {
    if (saveSkill.isPending) return;
    editorSession.current++; setSkillReading(false); setSkillLoading(false);
    setDialogOpen(false);
    setSkillIdentity(null);
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
      active: formData.active,
      isFeatured: formData.isFeatured,
    };
  };

  const handleSubmit = () => {
    const payload = buildPayload();
    if (mode === 'skill') {
      if (skillReading || skillLoading || saveSkill.isPending || !skillIdentity || !formData.modelId || !skillForm.reviewed) return;
      setSkillError('');
      saveSkill.mutate({ ...skillIdentity, expectedUpdatedAt: editingModule?.updated_at ?? null,
        directoryName: skillForm.directoryName, ...skillPublicationFields(skillForm), resourcePlanReviewed: true,
        module: { title: formData.title, description: formData.description || null,
          full_description: formData.fullDescription || null, model_id: formData.modelId,
          platform: formData.platform, category: formData.category, icon: formData.icon,
          image_url: formData.imageUrl || null, badge_type: formData.badgeType === 'none' ? null : formData.badgeType,
          badge_text: formData.badgeText || null, credits_display: formData.creditsDisplay || null,
          sort_order: parseInt(formData.sortOrder) || 0, active: formData.active, is_featured: formData.isFeatured,
          features: payload.features ? JSON.stringify(payload.features) : null,
          examples: payload.examples ? JSON.stringify(payload.examples) : null,
          preparation_questions: payload.userQuestions ? JSON.stringify(payload.userQuestions) : null,
        },
      }, { onError: e => setSkillError(e.message) });
      return;
    }

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
      active: !module.active,
    });
  };

  const handleToggleFeatured = (module: FeatureModule) => {
    updatePrompt.mutate({
      id: module.id,
      isFeatured: !module.is_featured,
    });
  };

  const handleDelete = (module: FeatureModule) => {
    setConfirmationError('');
    setConfirmation({ kind: 'delete', ids: [module.id], title: module.title });
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
    if (batchForm.isFeatured !== BATCH_NO_CHANGE) patch.isFeatured = batchForm.isFeatured === 'featured';

    if (Object.keys(patch).length === 0) {
      toast.error('请至少选择一个要批量更新的字段');
      return;
    }

    batchUpdatePrompts.mutate({
      ids: selectedModuleIds,
      patch,
    });
  };

  const handleBatchDisable = () => {
    if (selectedModuleIds.length === 0) return;
    setConfirmationError('');
    setConfirmation({ kind: 'disable', ids: [...selectedModuleIds], title: `${selectedModuleIds.length} 个模块` });
  };
  const confirmationPending = deletePrompt.isPending || batchDeletePrompts.isPending;

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
  const skillModelsView: SkillModelsView = { data: skillModels.data };

  return {
    dashboard, isLoading, error, refetch,
    dialogOpen, setDialogOpen, mode, setMode, editingModule, setEditingModule, formData, setFormData,
    skillModels: skillModelsView, skillForm, setSkillForm, skillIdentity, skillError, setSkillError,
    skillLoading, skillReading, setSkillReading, currentEditorSession, editorSession,
    batchEditOpen, setBatchEditOpen, batchForm, setBatchForm,
    categoryFilter, setCategoryFilter, selectedModuleIds,
    confirmation, setConfirmation, confirmationError, setConfirmationError, confirmationPending,
    // the views only read whether a request is in flight and start the two confirmed ones (the full tRPC mutation
    // type cannot be exported by name)
    saveSkill: { isPending: saveSkill.isPending }, createPrompt: { isPending: createPrompt.isPending },
    updatePrompt: { isPending: updatePrompt.isPending }, batchUpdatePrompts: { isPending: batchUpdatePrompts.isPending },
    deletePrompt: { isPending: deletePrompt.isPending, mutate: (input: { ids: string[] }) => deletePrompt.mutate(input) },
    batchDeletePrompts: { mutate: (input: { ids: string[] }) => batchDeletePrompts.mutate(input) },
    openCreateDialog, openEditDialog, closeDialog, handleSubmit, handleToggleActive, handleToggleFeatured,
    handleDelete, handleToggleModuleSelection, handleToggleSelectAll, handleBatchSetActive, handleOpenBatchEdit,
    handleBatchEditSubmit, handleBatchDisable,
    modules, hasSelectedModules, allModulesSelected, stats, modelsData,
  };
}

export type PromptsAdmin = ReturnType<typeof usePromptsAdmin>;
